import { Router, Request, Response } from 'express';
import logger from '../../utils/logger';
import { saveBugReport } from '../../services/Database';

const router = Router();

/**
 * Health check endpoint
 * @route GET /health
 */
router.post('/', async (req: Request, res: Response) => {

    if (!req.body || !req.body.bugReport) {
        res.status(400).json({
            status: 'Bad Request',
            message: 'Bug report is required'
        });
        return;
    }
    const bugReport = req.body.bugReport;
    logger.error(`User report: ${bugReport}`);
    await saveBugReport(bugReport);
    res.status(200).json({
        status: 'Bug report recorded',
        timestamp: new Date().toISOString()
    });
});

export default router;