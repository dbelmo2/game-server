import { Router, Request, Response } from 'express';

const router = Router();

/**
 * Health check endpoint
 * @route GET /health
 */
router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

export default router;