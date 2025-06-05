import rateLimit from 'express-rate-limit';
import { RateLimitError } from '../../types/error.type';
import logger from '../../utils/logger';

export const rateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    message: async () => {
        throw new RateLimitError('Too many requests from this IP, please try again after 15 minutes.');
    },
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
    handler: (req) => {
        logger.warn(`Rate limit reached for IP ${req.ip}`);
    }
});