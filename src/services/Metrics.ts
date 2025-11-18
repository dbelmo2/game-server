import logger from '../utils/logger';

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
  
  // Player activity
  connectionsPerMinute: number;
  disconnectsPerMinute: number;
  
  // Issues
  slowLoopsLastMinute: number; // Loops that exceeded target time
  errorCount: number;
}

interface MetricsCollector {
  loopTimes: number[];
  loopTimestamps: number[];
  broadcastSizes: number[];
  connectionTimestamps: number[];
  disconnectTimestamps: number[];
  slowLoops: number[];
  errors: number[];
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
  };

  private thresholds: Thresholds = {
    maxLoopTimeMs: 50,
    maxMemoryPercent: 85,
    maxBandwidthMBPerSec: 100,
    targetLoopsPerSecond: 30,
  };

  private metricsInterval: NodeJS.Timeout | null = null;
  private lastMetricsLog = Date.now();
  private readonly METRICS_WINDOW_MS = 10000; // 10 seconds
  private readonly ROLLING_WINDOW_MS = 60000; // 1 minute for connections/disconnects

  constructor(
    private loggingIntervalMs: number = 10000,
    customThresholds?: Partial<Thresholds>
  ) {
    if (customThresholds) {
      this.thresholds = { ...this.thresholds, ...customThresholds };
    }
    
    // Get memory limit
    const memLimit = process.memoryUsage().heapTotal / 1024 / 1024;
    this.metrics.memoryLimitMB = memLimit;
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
    
    this.metricsInterval = setInterval(() => {
      this.calculateMetrics();
      this.logMetrics();
      this.checkThresholds();
      this.resetWindowMetrics();
    }, this.loggingIntervalMs);
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
  }

  // ==================== Data Collection Methods ====================

  /**
   * Record a server loop execution
   * @param durationMs - How long the loop took in milliseconds
   */
  public recordLoop(durationMs: number): void {
    const now = Date.now();
    this.collector.loopTimes.push(durationMs);
    this.collector.loopTimestamps.push(now);

    // Track slow loops
    if (durationMs > this.thresholds.maxLoopTimeMs) {
      this.collector.slowLoops.push(now);
    }
  }

  /**
   * Record a broadcast event
   * @param sizeBytes - Size of the broadcast in bytes
   */
  public recordBroadcast(sizeBytes: number): void {
    this.collector.broadcastSizes.push(sizeBytes);
  }

  /**
   * Record a player connection
   */
  public recordConnection(): void {
    this.collector.connectionTimestamps.push(Date.now());
  }

  /**
   * Record a player disconnection
   */
  public recordDisconnect(): void {
    this.collector.disconnectTimestamps.push(Date.now());
  }

  /**
   * Record an error occurrence
   */
  public recordError(): void {
    this.collector.errors.push(Date.now());
  }

  /**
   * Update current server state
   * @param matchCount - Current number of active matches
   * @param playerCount - Current number of connected players
   */
  public updateServerState(matchCount: number, playerCount: number): void {
    this.metrics.totalMatches = matchCount;
    this.metrics.totalPlayers = playerCount;
  }

  // ==================== Calculation Methods ====================

  private calculateMetrics(): void {
    const now = Date.now();
    const windowStartTime = now - this.METRICS_WINDOW_MS;

    // Performance metrics - loop timing
    if (this.collector.loopTimes.length > 0) {
      this.metrics.avgLoopTimeMs = this.average(this.collector.loopTimes);
      this.metrics.maxLoopTimeMs = Math.max(...this.collector.loopTimes);
      
      // Calculate loops per second
      const loopsInWindow = this.collector.loopTimestamps.filter(
        t => t >= windowStartTime
      ).length;
      this.metrics.loopsPerSecond = loopsInWindow / (this.METRICS_WINDOW_MS / 1000);
    }

    // Resource usage - memory
    const memUsage = process.memoryUsage();
    this.metrics.memoryUsageMB = memUsage.heapUsed / 1024 / 1024;
    this.metrics.memoryUsagePercent = (this.metrics.memoryUsageMB / this.metrics.memoryLimitMB) * 100;

    // Network metrics
    if (this.collector.broadcastSizes.length > 0) {
      const avgBroadcastBytes = this.average(this.collector.broadcastSizes);
      this.metrics.avgBroadcastSizeKB = avgBroadcastBytes / 1024;
      
      const totalBroadcasts = this.collector.broadcastSizes.length;
      this.metrics.broadcastsPerSecond = totalBroadcasts / (this.METRICS_WINDOW_MS / 1000);
      
      // Calculate bandwidth: broadcasts/sec * avg size
      const bytesPerSecond = this.metrics.broadcastsPerSecond * avgBroadcastBytes;
      this.metrics.totalBandwidthMBPerSec = bytesPerSecond / 1024 / 1024;
    }

    // Player activity - use rolling 60 second window
    const rollingWindowStart = now - this.ROLLING_WINDOW_MS;
    
    const recentConnections = this.collector.connectionTimestamps.filter(
      t => t >= rollingWindowStart
    );
    const recentDisconnects = this.collector.disconnectTimestamps.filter(
      t => t >= rollingWindowStart
    );
    
    this.metrics.connectionsPerMinute = recentConnections.length;
    this.metrics.disconnectsPerMinute = recentDisconnects.length;

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
    
    // Server health
    logger.info(`🎮 Server Health:`);
    logger.info(`   Matches: ${this.metrics.totalMatches} | Players: ${this.metrics.totalPlayers}`);
    
    // Performance
    logger.info(`⚡ Performance:`);
    logger.info(`   Loop Time: avg=${this.metrics.avgLoopTimeMs.toFixed(2)}ms max=${this.metrics.maxLoopTimeMs.toFixed(2)}ms`);
    logger.info(`   Loop Rate: ${this.metrics.loopsPerSecond.toFixed(1)}/sec (target: ${this.thresholds.targetLoopsPerSecond}/sec)`);
    
    // Resources
    logger.info(`💾 Resources:`);
    logger.info(`   Memory: ${this.metrics.memoryUsageMB.toFixed(2)}MB / ${this.metrics.memoryLimitMB.toFixed(0)}MB (${this.metrics.memoryUsagePercent.toFixed(1)}%)`);
    
    // Network
    logger.info(`🌐 Network:`);
    logger.info(`   Broadcasts: ${this.metrics.broadcastsPerSecond.toFixed(1)}/sec | Avg Size: ${this.metrics.avgBroadcastSizeKB.toFixed(2)}KB`);
    logger.info(`   Bandwidth: ${this.metrics.totalBandwidthMBPerSec.toFixed(2)} MB/sec`);
    
    // Activity
    logger.info(`👥 Player Activity (last 60s):`);
    logger.info(`   Connections: ${this.metrics.connectionsPerMinute} | Disconnects: ${this.metrics.disconnectsPerMinute}`);
    
    // Issues
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

    // Check loop time
    if (this.metrics.maxLoopTimeMs > this.thresholds.maxLoopTimeMs) {
      alerts.push(
        `Loop time exceeded: ${this.metrics.maxLoopTimeMs.toFixed(2)}ms (threshold: ${this.thresholds.maxLoopTimeMs}ms)`
      );
    }

    // Check memory
    if (this.metrics.memoryUsagePercent > this.thresholds.maxMemoryPercent) {
      alerts.push(
        `High memory usage: ${this.metrics.memoryUsagePercent.toFixed(1)}% (threshold: ${this.thresholds.maxMemoryPercent}%)`
      );
    }

    // Check bandwidth
    if (this.metrics.totalBandwidthMBPerSec > this.thresholds.maxBandwidthMBPerSec) {
      alerts.push(
        `High bandwidth: ${this.metrics.totalBandwidthMBPerSec.toFixed(2)} MB/sec (threshold: ${this.thresholds.maxBandwidthMBPerSec} MB/sec)`
      );
    }

    // Check if server is falling behind target loop rate
    const loopRateDiff = this.thresholds.targetLoopsPerSecond - this.metrics.loopsPerSecond;
    if (loopRateDiff > 5) { // More than 5 loops/sec below target
      alerts.push(
        `Server falling behind: ${this.metrics.loopsPerSecond.toFixed(1)}/sec (target: ${this.thresholds.targetLoopsPerSecond}/sec)`
      );
    }

    // Log all alerts
    if (alerts.length > 0) {
      logger.error('🚨 PERFORMANCE ALERTS:');
      alerts.forEach(alert => logger.error(`   ⚠️  ${alert}`));
      logger.error('');
    }
  }

  private resetWindowMetrics(): void {
    // Reset metrics for the next window
    this.collector.loopTimes = [];
    this.collector.broadcastSizes = [];
    
    // Keep rolling window data (connections/disconnects) for 60 seconds
    const now = Date.now();
    const rollingWindowStart = now - this.ROLLING_WINDOW_MS;
    
    this.collector.connectionTimestamps = this.collector.connectionTimestamps.filter(
      t => t >= rollingWindowStart
    );
    this.collector.disconnectTimestamps = this.collector.disconnectTimestamps.filter(
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

  // ==================== Utility Methods ====================

  private average(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((sum, val) => sum + val, 0) / arr.length;
  }

  /**
   * Get current metrics snapshot
   */
  public getMetrics(): Readonly<ServerMetrics> {
    return { ...this.metrics };
  }

  /**
   * Get metrics in Prometheus format (for external monitoring)
   */
  public getPrometheusMetrics(): string {
    return `
# HELP game_server_matches Total number of active matches
# TYPE game_server_matches gauge
game_server_matches ${this.metrics.totalMatches}

# HELP game_server_players Total number of connected players
# TYPE game_server_players gauge
game_server_players ${this.metrics.totalPlayers}

# HELP game_server_loop_time_ms Average server loop time in milliseconds
# TYPE game_server_loop_time_ms gauge
game_server_loop_time_ms ${this.metrics.avgLoopTimeMs.toFixed(2)}

# HELP game_server_memory_mb Memory usage in megabytes
# TYPE game_server_memory_mb gauge
game_server_memory_mb ${this.metrics.memoryUsageMB.toFixed(2)}

# HELP game_server_memory_percent Memory usage percentage
# TYPE game_server_memory_percent gauge
game_server_memory_percent ${this.metrics.memoryUsagePercent.toFixed(2)}

# HELP game_server_bandwidth_mbps Total bandwidth in megabytes per second
# TYPE game_server_bandwidth_mbps gauge
game_server_bandwidth_mbps ${this.metrics.totalBandwidthMBPerSec.toFixed(2)}

# HELP game_server_loops_per_second Server loop rate
# TYPE game_server_loops_per_second gauge
game_server_loops_per_second ${this.metrics.loopsPerSecond.toFixed(2)}

# HELP game_server_slow_loops_total Slow loops in last minute
# TYPE game_server_slow_loops_total counter
game_server_slow_loops_total ${this.metrics.slowLoopsLastMinute}

# HELP game_server_errors_total Errors in last minute
# TYPE game_server_errors_total counter
game_server_errors_total ${this.metrics.errorCount}
    `.trim();
  }

  /**
   * Force an immediate metrics calculation and log
   */
  public forceLog(): void {
    this.calculateMetrics();
    this.logMetrics();
    this.checkThresholds();
  }
}