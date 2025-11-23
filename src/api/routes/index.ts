import express from 'express';
import heathRouter from './health';
import liveRouter from './live';
import bugReportRouter from './bugReport';

const router = express.Router();
router.use('/health', heathRouter);
router.use('/live', liveRouter);
router.use('/bug-report', bugReportRouter);
export default router;