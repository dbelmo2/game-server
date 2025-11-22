import { config } from "../config/config";
import logger from "../utils/logger";
import { Match } from "./Match";
import { Socket } from "socket.io";
import { MetricsManager } from "./Metrics";

export type Region = 'NA' | 'EU' | 'ASIA' | 'GLOBAL';

const BROADCAST_HZ = 30;
const FRAME_MS = 1000 / BROADCAST_HZ;
const BROADBCAST_BATCH_SIZE = 50; // Number of matches to broadcast per loop iteration

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
  private disconnectedPlayers: Map<string, { matchId: string }>;
  private lastBroadcast: number = Date.now();
  private showisLive: boolean = false;
  // Metrics Manager
  private metricsManager: MetricsManager;
  
  constructor() {
    this.disconnectedPlayers = new Map<string, { matchId: string }>();
    this.matches = new Map<string, Match>();
    
    // Initialize metrics manager with custom thresholds
    this.metricsManager = new MetricsManager(
      10000, // Log every 10 seconds
      {
        maxLoopTimeMs: 33,        // Should complete in < 33ms for 30Hz
        maxMemoryPercent: 80,     // Alert at 80% memory
        maxBandwidthMBPerSec: 50, // Alert at 50MB/sec
        targetLoopsPerSecond: 30, // Target 30 loops/sec
      }
    );
    
    // Start metrics collection
    this.metricsManager.start();
    logger.info('MetricsManager initialized and started');
    
    // Start server loop
    this.serverLoop();
  }



  public setShowIsLive(show: boolean) {
    this.showisLive = show;
  }

  public enqueuePlayer(player: QueuedPlayer) {
    try {
      // Record connection metric
      this.metricsManager.recordConnection();
      
      const { match, disconnectedPlayer } = this.findMatchInRegion(player.region, player.playerMatchId);
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
          this.metricsManager.recordReconnect();
          match.rejoinPlayer(player.socket, player.playerMatchId);
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
      // Record error metric
      this.metricsManager.recordError();
      
      logger.error(`Error enqueuing player ${player.id}: ${error}`);
      player.socket.emit('error', { message: 'Internal server error while joining match' });
      player.socket.disconnect(true);
    }
  }

  private setDisconnectedPlayer(playerMatchId: string, matchId: string,) {
    this.metricsManager.recordTemporaryDisconnect();
    this.disconnectedPlayers.set(playerMatchId, { matchId });
    logger.info(`Player ${playerMatchId} disconnected from match ${matchId}`);
  }

  private removeDisconnectedPlayer(playerMatchId: string) {
    // Record disconnect metric
    this.metricsManager.recordDisconnect();
    
    if (this.disconnectedPlayers.has(playerMatchId)) {
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
    const loopStart = Date.now();
    const now = Date.now();
    
    if (now - this.lastBroadcast >= FRAME_MS) {
      try {
        // Update server state metrics before processing
        const totalPlayers = Array.from(this.matches.values())
          .reduce((sum, match) => sum + match.getNumberOfPlayers(), 0);
        this.metricsManager.updateServerState(this.matches.size, totalPlayers);

        // Update & broadcast at 30Hz
        this.matches.forEach(match => {
          if (match.getIsReady() && !match.getShouldRemove()) {
            match.update();
            
            // Record broadcast metrics
            const broadcastSize = match.broadcastGameState();
            if (broadcastSize) {
              this.metricsManager.recordBroadcast(broadcastSize);
            }
            
            if (this.showisLive === true) {
              match.informShowIsLive();
            }
          } else if (match.getShouldRemove()) {
            this.removeMatch(match);
          }
        });
        
        this.showisLive = false;
        this.lastBroadcast = now;
      } catch (error) {
        // Record error metric
        this.metricsManager.recordError();
        logger.error(`Error in server loop: ${error}`);
      }
    }

    // Record loop timing
    const loopDuration = Date.now() - loopStart;
    this.metricsManager.recordLoop(loopDuration);

    // Adaptive sleep
    setTimeout(
      this.serverLoop, 
      Math.max(1, FRAME_MS - (Date.now() - this.lastBroadcast))
    );
  };

  private removeMatch = (match: Match) => {
    const matchId = match.getId();
    logger.info(`Removing match ${matchId}`);  

    if (!this.matches.has(matchId)) {
      logger.warn(`Match ${matchId} already removed from matchmaker`);
      return;
    }
    
    for (const playerId of match.getPlayerIds()) {
      this.removeDisconnectedPlayer(playerId);
    }
    
    // Remove from map first to prevent recursion
    this.matches.delete(matchId);
    
    // Then clean up resources
    match.cleanUpSession();
    logger.info(`Match ${matchId} removed from matchmaker`);
  };

  private findMatchInRegion(region: Region, playerMatchId?: string): { match?: Match, disconnectedPlayer?: { matchId: string } } {
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

  // ==================== Metrics API ====================
  
  /**
   * Get current metrics snapshot
   * Useful for health check endpoints or admin dashboards
   */
  public getMetrics() {
    return this.metricsManager.getMetrics();
  }

  /**
   * Get metrics in Prometheus format
   * Useful for external monitoring tools
   */
  public getPrometheusMetrics(): string {
    return this.metricsManager.getPrometheusMetrics();
  }

  /**
   * Force an immediate metrics log
   * Useful for debugging or before shutdown
   */
  public forceMetricsLog(): void {
    this.metricsManager.forceLog();
  }

  /**
   * Graceful shutdown
   * Cleans up all resources and logs final metrics
   */
  public shutdown(): void {
    logger.info('Shutting down matchmaker...');
    
    // Stop metrics collection
    this.metricsManager.stop();
    
    // Force final metrics log
    this.metricsManager.forceLog();
    
    // Clean up all matches
    for (const match of this.matches.values()) {
      match.cleanUpSession();
    }
    this.matches.clear();
    
    this.disconnectedPlayers.clear();
    
    logger.info('Matchmaker shutdown complete');
  }
}

const matchMaker = new Matchmaker();

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  logger.info('SIGTERM received - initiating graceful shutdown');
  matchMaker.shutdown();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received - initiating graceful shutdown');
  matchMaker.shutdown();
  process.exit(0);
});

export default matchMaker;