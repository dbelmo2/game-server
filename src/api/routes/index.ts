import express from 'express';
import heathRouter from './health';
import liveRouter from './live';

const router = express.Router();
router.use('/health', heathRouter);
router.use('/live', liveRouter);
export default router;