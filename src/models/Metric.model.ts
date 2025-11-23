import mongoose, { Schema, Document } from 'mongoose';

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

export interface IDailyMetrics extends Document, DailyMetrics {}

const DailyMetricsSchema: Schema = new Schema({
  date: {
    type: String,
    required: true,
    unique: true,
    match: /^\d{4}-\d{2}-\d{2}$/
  },
  
  // Player metrics
  totalPlayersConnected: {
    type: Number,
    required: true,
    default: 0
  },
  peakConcurrentPlayers: {
    type: Number,
    required: true,
    default: 0
  },
  avgConcurrentPlayers: {
    type: Number,
    required: true,
    default: 0
  },
  
  // Match metrics
  totalRoundsPlayed: {
    type: Number,
    required: true,
    default: 0
  },
  
  // Health metrics
  totalDisconnects: {
    type: Number,
    required: true,
    default: 0
  },
  temporaryDisconnects: {
    type: Number,
    required: true,
    default: 0
  },
  reconnects: {
    type: Number,
    required: true,
    default: 0
  },
  reconnectRate: {
    type: Number,
    required: true,
    default: 0
  },
  slowLoopsCount: {
    type: Number,
    required: true,
    default: 0
  },
  errorCount: {
    type: Number,
    required: true,
    default: 0
  },
  
  // Peak resources
  peakMemoryUsageMB: {
    type: Number,
    required: true,
    default: 0
  },
  peakBandwidthMBPerSec: {
    type: Number,
    required: true,
    default: 0
  }
}, {
  timestamps: true
});

// Create compound index for efficient date queries
DailyMetricsSchema.index({ date: 1 });

export const DailyMetricsModel = mongoose.model<IDailyMetrics>('DailyMetrics', DailyMetricsSchema);