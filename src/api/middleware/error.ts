import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../../types/error.type';
import logger from '../../utils/logger';

export const errorMiddleware = (err: Error, req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof ApiError) {
    logger.warn(`API Error: ${err.message}`, { 
        status: err.status, 
        details: err.details,
        endpoint: req.path,
        ip: req.ip
    });
    res.status(err.status).json({
      error: err.message,
      details: err.details,
    });
  } else {
    logger.error(`Unexpected Error: ${err.message}`, { stack: err.stack });
    res.status(500).json({
      error: 'Internal server error',
    });
  }
};