import { config } from "../config/config";
import logger from "../utils/logger";
import { Match } from "./Match";
import { Socket } from "socket.io";

export type Region = 'NA' | 'EU' | 'ASIA' | 'GLOBAL';


const BROADCAST_HZ = 30;                   // 100 ms, 10 updates per second
const FRAME_MS     = 1000 / BROADCAST_HZ;  // outer‑loop cadence

const BROADBCAST_BATCH_SIZE = 50;          // Number of matches to broadcast per loop iteration

type QueuedPlayer = {
  socket: Socket;
  region: Region;
  enqueuedAt: number;
  name: string;
  id?: string;
  playerMatchId?: string;
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
        if (!disconnectedPlayer) {
          logger.info(`Adding player with socket ${player.socket.id} to existing match ${match.getId()} in region ${player.region}`);
          // New player joining existing match
          const playerMatchId = match.addPlayer(player.socket, player.name);
          player.socket.emit('matchFound', { 
            matchId: match.getId(), 
            region: player.region,
            playerId: playerMatchId,
          });
        } else {
          logger.info(`Rejoining disconnected player ${player.playerMatchId} to match ${match.getId()} in region ${player.region}`);
          // Rejoining disconnected player
          if (!player.playerMatchId) {
            throw new Error(`playerMatchID is required for rejoining a match`);
          }
          const { timeoutId } = disconnectedPlayer;
          match.rejoinPlayer(player.socket, player.playerMatchId, timeoutId);
          player.socket.emit('rejoinedMatch', { 
            matchId: match.getId(), 
            region: player.region 
          });
          this.removeDisconnectedPlayer(player.playerMatchId);
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
  private setDisconnectedPlayer(playerMatchId: string, matchId: string, timeoutId: NodeJS.Timeout) {
    if (this.disconnectedPlayers.has(playerMatchId)) {
      clearTimeout(this.disconnectedPlayers.get(playerMatchId)!.timeoutId);
      logger.info(`Cleared existing disconnect timeout for player ${playerMatchId}`);
    }

    this.disconnectedPlayers.set(playerMatchId, { timeoutId, matchId });
    logger.info(`Player ${playerMatchId} disconnected from match ${matchId}`);
  }

  private removeDisconnectedPlayer(playerMatchId: string) {
    if (this.disconnectedPlayers.has(playerMatchId)) {
      clearTimeout(this.disconnectedPlayers.get(playerMatchId)!.timeoutId);
      logger.info(`Cleared disconnect timeout for player ${playerMatchId}`);
      this.disconnectedPlayers.delete(playerMatchId);
      logger.info(`Removed player ${playerMatchId} from disconnected players list`);
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
    const now = Date.now();
    
    if (now - this.lastBroadcast >= FRAME_MS) {
      // Update & broadcast at 30Hz
      this.matches.forEach(match => {
        if (match.getIsReady() && !match.getShouldRemove()) {
          match.update();
          match.broadcastGameState();
          if (this.showisLive === true) {
            match.informShowIsLive();
          }
        } else if (match.getShouldRemove()) {
          this.removeMatch(match);
        }
      });
      
      this.showisLive = false;
      this.lastBroadcast = now;
    }

    setTimeout(
      this.serverLoop, 
      Math.max(1, FRAME_MS - (Date.now() - this.lastBroadcast))
    );
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


  private findMatchInRegion(region: Region, playerMatchId?: string): {  match?: Match,  disconnectedPlayer?: { timeoutId: NodeJS.Timeout } } {
    // If the player is reconnecting, prioritize that
    if (playerMatchId && this.disconnectedPlayers.has(playerMatchId)) {
      const disconnectedPlayerData = this.disconnectedPlayers.get(playerMatchId)!;
      const match = this.matches.get(disconnectedPlayerData.matchId);
      if (match) {
        logger.info(`Reconnecting player ${playerMatchId} to match ${disconnectedPlayerData.matchId}`);
        return { match, disconnectedPlayer: disconnectedPlayerData };
      }
    }

    // Else return the first available match in the region with space
    for (const match of this.matches.values()) {
      if (match.getRegion() === region && match.getNumberOfPlayers() < config.MAX_PLAYERS_PER_MATCH) {
        logger.info(`Found available match ${match.getId()} for player ${playerMatchId}`);
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