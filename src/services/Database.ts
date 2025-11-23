import { BugReport } from "../models/BugReport.model";
import { DailyMetricsModel, DailyMetrics } from "../models/Metric.model";
import logger from "../utils/logger";

export const saveBugReport = async (bugReport: string): Promise<void> => {
  try {
    const newReport = new BugReport({ bug: bugReport });
    await newReport.save();
  } catch (error) {
    logger.error('Failed to save bug report:', error);
  }
};

export const saveDailyMetrics = async (metrics: DailyMetrics): Promise<void> => {
  try {
    const newMetrics = new DailyMetricsModel(metrics);
    await newMetrics.save();
  } catch (error) {
    logger.error('Failed to save daily metrics:', error);
  }
};