import { config } from "../config/config";
import logger from "../utils/logger";
import { Match } from "./Match";
import { Socket } from "socket.io";

export type Region = 'NA' | 'EU' | 'ASIA' | 'GLOBAL';


const BROADCAST_HZ = 30;                   // 100 ms, 10 updates per second
const FRAME_MS     = 1000 / BROADCAST_HZ;  // outer‑loop cadence


type QueuedPlayer = {
  socket: Socket;
  region: Region;
  enqueuedAt: number;
  name: string;
  id?: string;
};


class Matchmaker {
  private matches: Map<string, Match>;
  private disconnectedPlayers: Map<string, { matchId: string, timeoutId: NodeJS.Timeout }>;
  private lastBroadcast: number = Date.now();
  private showisLive: boolean = false; // This should be set based on your application logic
  
  constructor() {
    this.disconnectedPlayers = new Map<string, { matchId: string, timeoutId: NodeJS.Timeout }>();
    this.matches = new Map<string, Match>();
    this.serverLoop();
  }

  public setShowIsLive(show: boolean) {
    this.showisLive = show;
  }

  public enqueuePlayer(player: QueuedPlayer) {
    try {
      const { match, disconnectedPlayer }  = this.findMatchInRegion(player.region, player?.id);
      if (match) {
        logger.info(`Adding player with socket ${player.socket.id} to existing match ${match.getId()} in region ${player.region}`);
        if (!disconnectedPlayer) {
          // New player joining existing match
          const playerId = match.addPlayer(player.socket, player.name);
          player.socket.emit('matchFound', { 
            matchId: match.getId(), 
            region: player.region,
            playerId: playerId
          });
        } else {
          // Rejoining disconnected player
          if (!player.id) {
            throw new Error(`Player ID is required for rejoining a match`);
          }
          const { timeoutId } = disconnectedPlayer;
          match.rejoinPlayer(player.socket, player.id, timeoutId);
          player.socket.emit('rejoinedMatch', { 
            matchId: match.getId(), 
            region: player.region 
          });
          this.removeDisconnectedPlayer(player.id);
        }
        player.socket.join(match.getId());

      } else {
        logger.info(`Creating new match for player ${player.id} with socket ${player.socket.id} in region ${player.region}`);
        const matchId = this.generateMatchId();
        const newMatch = new Match(
          player.socket, 
          player.name, 
          player.region, 
          matchId, 
          this.setDisconnectedPlayer.bind(this),
          this.removeDisconnectedPlayer.bind(this),
        );
        this.matches.set(matchId, newMatch);
        player.socket.join(matchId);
        player.socket.emit('matchFound', { 
          matchId, 
          region: player.region,
          playerId: newMatch.getPlayerIdFromSocketId(player.socket.id),
        });
      }
    } catch (error) {
        logger.error(`Error enqueuing player ${player.id}: ${error}`);
        player.socket.emit('error', { message: 'Internal server error while joining match' });
        player.socket.disconnect(true);
    }
  }
  private setDisconnectedPlayer(playerId: string, matchId: string, timeoutId: NodeJS.Timeout) {
    if (this.disconnectedPlayers.has(playerId)) {
      clearTimeout(this.disconnectedPlayers.get(playerId)!.timeoutId);
      logger.info(`Cleared existing disconnect timeout for player ${playerId}`);
    }

    this.disconnectedPlayers.set(playerId, { timeoutId, matchId });
    logger.info(`Player ${playerId} disconnected from match ${matchId}`);
  }

  private removeDisconnectedPlayer(playerId: string) {
    if (this.disconnectedPlayers.has(playerId)) {
      clearTimeout(this.disconnectedPlayers.get(playerId)!.timeoutId);
      logger.info(`Cleared disconnect timeout for player ${playerId}`);
      this.disconnectedPlayers.delete(playerId);
      logger.info(`Removed player ${playerId} from disconnected players list`);
      return;
    }
  }

  public getMatch(matchId: string): Match | undefined {
    return this.matches.get(matchId);
  }

  public getActiveMatches(): Match[] {
    return Array.from(this.matches.values());
  }

  private serverLoop = () => {
    // Create a copy of the matches to handle safely during iteration
    const matchesToProcess = Array.from(this.matches.entries());
    for (const [matchId, match] of matchesToProcess) {
      const shouldRemove = match.getShouldRemove();
      if (match.getIsReady() && shouldRemove === false) {
        if (this.showisLive) {
          match.informShowIsLive();
        }
        match.update();
      } else if (shouldRemove) {
        logger.info(`Calling remove match from server loop for match ${matchId}`);
        this.removeMatch(match);
      } else {
        logger.info(`Match ${matchId} is not ready yet`);
      }
    }

    if (this.showisLive) this.showisLive = false;

    const now = Date.now();
    const delta = now - this.lastBroadcast;

    if (delta >= FRAME_MS) {
      for (const match of this.matches.values()) match.broadcastGameState();
      this.lastBroadcast = now;
    }

    setTimeout(this.serverLoop, 4);    
  }


  private removeMatch = (match: Match) => {
      const matchId = match.getId();
      logger.info(`Removing match ${matchId}`);  

      if (!this.matches.has(matchId)) {
        logger.warn(`Match ${matchId} already removed from matchmaker`);
        return; // Exit early if already removed
      }
      for (const playerId of match.getPlayerIds()) {
        this.removeDisconnectedPlayer(playerId);
      }
      
      // Remove from map first to prevent recursion
      this.matches.delete(matchId);
      
      // Then clean up resources
      match.cleanUpSession();
      logger.info(`Match ${matchId} removed from matchmaker`);
  } 


  private findMatchInRegion(region: Region, playerId?: string): {  match?: Match,  disconnectedPlayer?: { timeoutId: NodeJS.Timeout } } {
    // If the player is reconnecting, prioritize that
    if (playerId && this.disconnectedPlayers.has(playerId)) {
      const disconnectedPlayerData = this.disconnectedPlayers.get(playerId)!;
      const match = this.matches.get(disconnectedPlayerData.matchId);
      if (match) {
        logger.info(`Reconnecting player ${playerId} to match ${disconnectedPlayerData.matchId}`);
        return { match, disconnectedPlayer: disconnectedPlayerData };
      }
    }

    // Else return the first available match in the region with space
    for (const match of this.matches.values()) {
      if (match.getRegion() === region && match.getNumberOfPlayers() < config.MAX_PLAYERS_PER_MATCH) {
        logger.info(`Found available match ${match.getId()} for player ${playerId}`);
        return { match };
      }
    }

    return {};
  }

  private generateMatchId(): string {
    return `match-${Math.random().toString(36).substring(2, 8)}`;
  }

}

const matchMaker = new Matchmaker();
export default matchMaker;