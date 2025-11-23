import logger from '../utils/logger';
import { saveDailyMetrics } from './Database';
export interface ServerMetrics {
  // Server health
  totalMatches: number;
  totalPlayers: number;
  
  // Performance (critical for production)
  avgLoopTimeMs: number;
  maxLoopTimeMs: number;
  loopsPerSecond: number;
  
  // Resource usage
  memoryUsageMB: number;
  memoryLimitMB: number;
  memoryUsagePercent: number;
  
  // Network
  broadcastsPerSecond: number;
  avgBroadcastSizeKB: number;
  totalBandwidthMBPerSec: number;
  temporaryDisconnectsPerMinute: number;
  reconnectsPerMinute: number;        
  
  // Player activity
  connectionsPerMinute: number;
  disconnectsPerMinute: number;
  
  // Issues
  slowLoopsLastMinute: number;
  errorCount: number;
}

export interface DailyMetrics {
  date: string; // YYYY-MM-DD
  
  // Player metrics
  totalPlayersConnected: number;
  peakConcurrentPlayers: number;
  avgConcurrentPlayers: number;
  
  // Match metrics
  totalRoundsPlayed: number;
  
  // Health metrics
  totalDisconnects: number;
  temporaryDisconnects: number;
  reconnects: number;
  reconnectRate: number;
  slowLoopsCount: number;
  errorCount: number;
  
  // Peak resources
  peakMemoryUsageMB: number;
  peakBandwidthMBPerSec: number;
}

interface MetricsCollector {
  loopTimes: number[];
  loopTimestamps: number[];
  broadcastSizes: number[];
  connectionTimestamps: number[];
  disconnectTimestamps: number[];
  slowLoops: number[];
  errors: number[];
  temporaryDisconnectTimestamps: number[];
  reconnectTimestamps: number[];
}

interface DailyMetricsCollector {
  uniquePlayerIds: Set<string>;
  totalConcurrentPlayerSum: number;      
  concurrentPlayerSampleCount: number;   
  peakConcurrentPlayers: number;
  totalRoundsPlayed: number;
  totalDisconnects: number;
  temporaryDisconnects: number;
  reconnects: number;
  slowLoops: number;
  errors: number;
  peakMemoryMB: number;
  peakBandwidthMBPerSec: number;
}

interface Thresholds {
  maxLoopTimeMs: number;
  maxMemoryPercent: number;
  maxBandwidthMBPerSec: number;
  targetLoopsPerSecond: number;
}

export class MetricsManager {
  private metrics: ServerMetrics = {
    totalMatches: 0,
    totalPlayers: 0,
    avgLoopTimeMs: 0,
    maxLoopTimeMs: 0,
    loopsPerSecond: 0,
    memoryUsageMB: 0,
    memoryLimitMB: 0,
    memoryUsagePercent: 0,
    broadcastsPerSecond: 0,
    avgBroadcastSizeKB: 0,
    totalBandwidthMBPerSec: 0,
    connectionsPerMinute: 0,
    disconnectsPerMinute: 0,
    temporaryDisconnectsPerMinute: 0,
    reconnectsPerMinute: 0,
    slowLoopsLastMinute: 0,
    errorCount: 0,
  };

  private collector: MetricsCollector = {
    loopTimes: [],
    loopTimestamps: [],
    broadcastSizes: [],
    connectionTimestamps: [],
    disconnectTimestamps: [],
    slowLoops: [],
    errors: [],
    temporaryDisconnectTimestamps: [],
    reconnectTimestamps: [],
  };

  private dailyCollector: DailyMetricsCollector = {
    uniquePlayerIds: new Set(),
    totalConcurrentPlayerSum: 0,
    concurrentPlayerSampleCount: 0,
    peakConcurrentPlayers: 0,
    totalRoundsPlayed: 0,
    totalDisconnects: 0,
    temporaryDisconnects: 0,
    reconnects: 0,
    slowLoops: 0,
    errors: 0,
    peakMemoryMB: 0,
    peakBandwidthMBPerSec: 0,
  };

  private currentDate: string = new Date().toISOString().split('T')[0];

  private thresholds: Thresholds = {
    maxLoopTimeMs: 50,
    maxMemoryPercent: 85,
    maxBandwidthMBPerSec: 100,
    targetLoopsPerSecond: 30,
  };

  private metricsInterval: NodeJS.Timeout | null = null;
  private dailyPersistInterval: NodeJS.Timeout | null = null;
  private readonly METRICS_WINDOW_MS = 10000; // 10 seconds
  private readonly ROLLING_WINDOW_MS = 60000; // 1 minute

  constructor(
    private loggingIntervalMs: number = 10000,
    customThresholds?: Partial<Thresholds>,
  ) {
    if (customThresholds) {
      this.thresholds = { ...this.thresholds, ...customThresholds };
    }
    
    this.metrics.memoryLimitMB = 2048;
  }

  /**
   * Start collecting and logging metrics at regular intervals
   */
  public start(): void {
    if (this.metricsInterval) {
      logger.warn('MetricsManager already started');
      return;
    }

    logger.info(`MetricsManager started - logging every ${this.loggingIntervalMs}ms`);
    
    // Real-time metrics logging
    this.metricsInterval = setInterval(() => {
      this.calculateMetrics();
      this.logMetrics();
      this.checkThresholds();
      this.resetWindowMetrics();
    }, this.loggingIntervalMs);

    this.scheduleDailyPersistence();
    
  }

  /**
   * Stop metrics collection
   */
  public stop(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
      logger.info('MetricsManager stopped');
    }

    if (this.dailyPersistInterval) {
      clearInterval(this.dailyPersistInterval);
      this.dailyPersistInterval = null;
    }

    // Persist any remaining daily metrics before stopping
    this.persistDailyMetrics();
    
  }

  // ==================== Real-Time Data Collection Methods ====================

  /**
   * Record a server loop execution
   */
  public recordLoop(durationMs: number): void {
    const now = Date.now();
    this.collector.loopTimes.push(durationMs);
    this.collector.loopTimestamps.push(now);

    // Track slow loops
    if (durationMs > this.thresholds.maxLoopTimeMs) {
      this.collector.slowLoops.push(now);
      this.dailyCollector.slowLoops++;
    }
  }

  /**
   * Record a broadcast event
   */
  public recordBroadcast(sizeBytes: number): void {
    this.collector.broadcastSizes.push(sizeBytes);
  }

  /**
   * Record a player connection with player ID for daily tracking
   */
  public recordConnection(playerId: string): void {
    this.metrics.totalPlayers++;
    if (this.metrics.totalPlayers > this.dailyCollector.peakConcurrentPlayers) {
        this.dailyCollector.peakConcurrentPlayers = this.metrics.totalPlayers;
    }
    this.collector.connectionTimestamps.push(Date.now());
    this.dailyCollector.uniquePlayerIds.add(playerId);
    this.dailyCollector.totalConcurrentPlayerSum += this.metrics.totalPlayers;
    this.dailyCollector.concurrentPlayerSampleCount++;
  }

  /**
   * Record a player disconnection
   */
  public recordDisconnect(): void {
    this.collector.disconnectTimestamps.push(Date.now());
    this.metrics.totalPlayers--;
    this.dailyCollector.totalDisconnects++;
  }

  /**
   * Record a player reconnection
   */
  public recordReconnect(): void {
    this.metrics.totalPlayers++;
    if (this.metrics.totalPlayers > this.dailyCollector.peakConcurrentPlayers) {
        this.dailyCollector.peakConcurrentPlayers = this.metrics.totalPlayers;
    }
    this.collector.reconnectTimestamps.push(Date.now());
    this.dailyCollector.reconnects++;
    this.dailyCollector.temporaryDisconnects++;
    this.dailyCollector.totalConcurrentPlayerSum += this.metrics.totalPlayers;
    this.dailyCollector.concurrentPlayerSampleCount++;
  }



  /**
   * Record an error occurrence
   */
  public recordError(): void {
    this.collector.errors.push(Date.now());
    this.dailyCollector.errors++;
  }

  /**
   * Record a completed match round
   */
  public recordNewRound(): void {
    this.dailyCollector.totalRoundsPlayed++;
  }

  /**
   * Update current server state
   */


  public setTotalMatches(matchCount: number): void {
    this.metrics.totalMatches = matchCount;
  }

  // ==================== Real-Time Calculation Methods ====================

  private calculateMetrics(): void {
    const now = Date.now();
    const windowStartTime = now - this.METRICS_WINDOW_MS;

    // Performance metrics
    if (this.collector.loopTimes.length > 0) {
      this.metrics.avgLoopTimeMs = this.average(this.collector.loopTimes);
      this.metrics.maxLoopTimeMs = Math.max(...this.collector.loopTimes);
      
      const loopsInWindow = this.collector.loopTimestamps.filter(
        t => t >= windowStartTime
      ).length;
      this.metrics.loopsPerSecond = loopsInWindow / (this.METRICS_WINDOW_MS / 1000);
    }

    // Resource usage
    const memUsage = process.memoryUsage();
    this.metrics.memoryUsageMB = memUsage.heapUsed / 1024 / 1024;
    this.metrics.memoryUsagePercent = (this.metrics.memoryUsageMB / this.metrics.memoryLimitMB) * 100;

    // Track peak memory for daily metrics
    if (this.metrics.memoryUsageMB > this.dailyCollector.peakMemoryMB) {
      this.dailyCollector.peakMemoryMB = this.metrics.memoryUsageMB;
    }

    // Network metrics
    if (this.collector.broadcastSizes.length > 0) {
      const avgBroadcastBytes = this.average(this.collector.broadcastSizes);
      this.metrics.avgBroadcastSizeKB = avgBroadcastBytes / 1024;
      
      const totalBroadcasts = this.collector.broadcastSizes.length;
      this.metrics.broadcastsPerSecond = totalBroadcasts / (this.METRICS_WINDOW_MS / 1000);
      
      const bytesPerSecond = this.metrics.broadcastsPerSecond * avgBroadcastBytes;
      this.metrics.totalBandwidthMBPerSec = bytesPerSecond / 1024 / 1024;

      // Track peak bandwidth for daily metrics
      if (this.metrics.totalBandwidthMBPerSec > this.dailyCollector.peakBandwidthMBPerSec) {
        this.dailyCollector.peakBandwidthMBPerSec = this.metrics.totalBandwidthMBPerSec;
      }
    }

    // Player activity
    const rollingWindowStart = now - this.ROLLING_WINDOW_MS;
    
    const recentConnections = this.collector.connectionTimestamps.filter(
      t => t >= rollingWindowStart
    );
    const recentDisconnects = this.collector.disconnectTimestamps.filter(
      t => t >= rollingWindowStart
    );
    const recentTemporaryDisconnects = this.collector.temporaryDisconnectTimestamps.filter(
      t => t >= rollingWindowStart
    );
    const recentReconnects = this.collector.reconnectTimestamps.filter(
      t => t >= rollingWindowStart
    );
    
    this.metrics.connectionsPerMinute = recentConnections.length;
    this.metrics.disconnectsPerMinute = recentDisconnects.length;
    this.metrics.temporaryDisconnectsPerMinute = recentTemporaryDisconnects.length;
    this.metrics.reconnectsPerMinute = recentReconnects.length;

    // Issues
    const recentSlowLoops = this.collector.slowLoops.filter(
      t => t >= rollingWindowStart
    );
    this.metrics.slowLoopsLastMinute = recentSlowLoops.length;

    const recentErrors = this.collector.errors.filter(
      t => t >= rollingWindowStart
    );
    this.metrics.errorCount = recentErrors.length;
  }

  private logMetrics(): void {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('📊 SERVER METRICS');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    logger.info(`🎮 Server Health:`);
    logger.info(`   Matches: ${this.metrics.totalMatches} | Players: ${this.metrics.totalPlayers}`);
    
    logger.info(`⚡ Performance:`);
    logger.info(`   Loop Time: avg=${this.metrics.avgLoopTimeMs.toFixed(2)}ms max=${this.metrics.maxLoopTimeMs.toFixed(2)}ms`);
    logger.info(`   Loop Rate: ${this.metrics.loopsPerSecond.toFixed(1)}/sec (target: ${this.thresholds.targetLoopsPerSecond}/sec)`);
    
    logger.info(`💾 Resources:`);
    logger.info(`   Memory: ${this.metrics.memoryUsageMB.toFixed(2)}MB / ${this.metrics.memoryLimitMB.toFixed(0)}MB (${this.metrics.memoryUsagePercent.toFixed(1)}%)`);
    
    logger.info(`🌐 Network:`);
    logger.info(`   Broadcasts: ${this.metrics.broadcastsPerSecond.toFixed(1)}/sec | Avg Size: ${this.metrics.avgBroadcastSizeKB.toFixed(2)}KB`);
    logger.info(`   Bandwidth: ${this.metrics.totalBandwidthMBPerSec.toFixed(2)} MB/sec`);
    
    logger.info(`👥 Player Activity (last 60s):`);
    logger.info(`   Connections: ${this.metrics.connectionsPerMinute} | Disconnects: ${this.metrics.disconnectsPerMinute}`);
    logger.info(`   Temp Disconnects: ${this.metrics.temporaryDisconnectsPerMinute} | Reconnects: ${this.metrics.reconnectsPerMinute}`);
    
    if (this.metrics.slowLoopsLastMinute > 0 || this.metrics.errorCount > 0) {
      logger.info(`⚠️  Issues:`);
      if (this.metrics.slowLoopsLastMinute > 0) {
        logger.info(`   Slow Loops: ${this.metrics.slowLoopsLastMinute}`);
      }
      if (this.metrics.errorCount > 0) {
        logger.info(`   Errors: ${this.metrics.errorCount}`);
      }
    }
    
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }

  private checkThresholds(): void {
    const alerts: string[] = [];

    if (this.metrics.maxLoopTimeMs > this.thresholds.maxLoopTimeMs) {
      alerts.push(
        `Loop time exceeded: ${this.metrics.maxLoopTimeMs.toFixed(2)}ms (threshold: ${this.thresholds.maxLoopTimeMs}ms)`
      );
    }

    if (this.metrics.memoryUsagePercent > this.thresholds.maxMemoryPercent) {
      alerts.push(
        `High memory usage: ${this.metrics.memoryUsagePercent.toFixed(1)}% (threshold: ${this.thresholds.maxMemoryPercent}%)`
      );
    }

    if (this.metrics.totalBandwidthMBPerSec > this.thresholds.maxBandwidthMBPerSec) {
      alerts.push(
        `High bandwidth: ${this.metrics.totalBandwidthMBPerSec.toFixed(2)} MB/sec (threshold: ${this.thresholds.maxBandwidthMBPerSec} MB/sec)`
      );
    }

    // Only check loop rate if we have active matches
    if (this.metrics.totalMatches > 0) {
      const loopRateDiff = this.thresholds.targetLoopsPerSecond - this.metrics.loopsPerSecond;
      if (loopRateDiff > 5) {
        alerts.push(
          `Server falling behind: ${this.metrics.loopsPerSecond.toFixed(1)}/sec (target: ${this.thresholds.targetLoopsPerSecond}/sec)`
        );
      }
    }

    if (alerts.length > 0) {
      logger.error('🚨 PERFORMANCE ALERTS:');
      alerts.forEach(alert => logger.error(`   ⚠️  ${alert}`));
      logger.error('');
    }
  }

  private resetWindowMetrics(): void {
    this.collector.loopTimes = [];
    this.collector.broadcastSizes = [];
    
    const now = Date.now();
    const rollingWindowStart = now - this.ROLLING_WINDOW_MS;
    
    this.collector.connectionTimestamps = this.collector.connectionTimestamps.filter(
      t => t >= rollingWindowStart
    );
    this.collector.disconnectTimestamps = this.collector.disconnectTimestamps.filter(
      t => t >= rollingWindowStart
    );
    this.collector.temporaryDisconnectTimestamps = this.collector.temporaryDisconnectTimestamps.filter(
      t => t >= rollingWindowStart
    );
    this.collector.reconnectTimestamps = this.collector.reconnectTimestamps.filter(
      t => t >= rollingWindowStart
    );
    this.collector.slowLoops = this.collector.slowLoops.filter(
      t => t >= rollingWindowStart
    );
    this.collector.errors = this.collector.errors.filter(
      t => t >= rollingWindowStart
    );
    this.collector.loopTimestamps = this.collector.loopTimestamps.filter(
      t => t >= rollingWindowStart
    );
  }

  // ==================== Daily Metrics Methods ====================

  private scheduleDailyPersistence(): void {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setDate(nextMidnight.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);

    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    setTimeout(() => {
      this.persistDailyMetrics();

      // After running, schedule the next midnight again
      this.scheduleDailyPersistence();
    }, msUntilMidnight);

    logger.info(
      `Daily metrics persistence scheduled for midnight (in ${(msUntilMidnight / 1000 / 60).toFixed(0)} minutes)`
    );
  }

  private async persistDailyMetrics(): Promise<void> {
    
    try {
      const avgConcurrentPlayers = this.dailyCollector.concurrentPlayerSampleCount > 0
        ? Math.round(this.dailyCollector.totalConcurrentPlayerSum / this.dailyCollector.concurrentPlayerSampleCount)
        : 0;
      
      const reconnectRate = this.dailyCollector.temporaryDisconnects > 0
        ? this.dailyCollector.reconnects / this.dailyCollector.temporaryDisconnects
        : 0;
      
      const dailyMetrics: DailyMetrics = {
        date: this.currentDate,
        totalPlayersConnected: this.dailyCollector.uniquePlayerIds.size,
        peakConcurrentPlayers: this.dailyCollector.peakConcurrentPlayers,
        avgConcurrentPlayers: avgConcurrentPlayers,
        totalRoundsPlayed: this.dailyCollector.totalRoundsPlayed,
        totalDisconnects: this.dailyCollector.totalDisconnects,
        temporaryDisconnects: this.dailyCollector.temporaryDisconnects,
        reconnects: this.dailyCollector.reconnects,
        reconnectRate: reconnectRate,
        slowLoopsCount: this.dailyCollector.slowLoops,
        errorCount: this.dailyCollector.errors,
        peakMemoryUsageMB: Math.round(this.dailyCollector.peakMemoryMB),
        peakBandwidthMBPerSec: parseFloat(this.dailyCollector.peakBandwidthMBPerSec.toFixed(2)),
      };
      
      await saveDailyMetrics(dailyMetrics);
      logger.info(`✅ Daily metrics persisted for ${this.currentDate}`);
      
      // Reset daily metrics for new day
      this.resetDailyMetrics();
      
    } catch (error) {
      logger.error(`❌ Failed to persist daily metrics: ${error}`);
    }
  }

  private resetDailyMetrics(): void {
    this.currentDate = new Date().toISOString().split('T')[0];
    this.dailyCollector = {
      uniquePlayerIds: new Set(),
      totalConcurrentPlayerSum: 0,
      concurrentPlayerSampleCount: 0,
      peakConcurrentPlayers: 0,
      totalRoundsPlayed: 0,
      totalDisconnects: 0,
      temporaryDisconnects: 0,
      reconnects: 0,
      slowLoops: 0,
      errors: 0,
      peakMemoryMB: 0,
      peakBandwidthMBPerSec: 0,
    };
  }

  // ==================== Utility Methods ====================

  private average(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((sum, val) => sum + val, 0) / arr.length;
  }

  /**
   * Get current real-time metrics snapshot
   */
  public getMetrics(): Readonly<ServerMetrics> {
    return { ...this.metrics };
  }

  /**
   * Get current daily metrics snapshot (for debugging)
   */
  public getDailyMetrics(): {
    date: string;
    totalPlayersConnected: number;
    peakConcurrentPlayers: number;
    totalRoundsPlayed: number;
  } {
    return {
      date: this.currentDate,
      totalPlayersConnected: this.dailyCollector.uniquePlayerIds.size,
      peakConcurrentPlayers: this.dailyCollector.peakConcurrentPlayers,
      totalRoundsPlayed: this.dailyCollector.totalRoundsPlayed,
    };
  }


  /**
   * Force an immediate metrics calculation and log
   */
  public forceLog(): void {
    this.calculateMetrics();
    this.logMetrics();
    this.checkThresholds();
  }

  /**
   * Force persist daily metrics now (useful for testing or manual triggers)
   */
  public async forcePersistDailyMetrics(): Promise<void> {
    await this.persistDailyMetrics();
  }
}