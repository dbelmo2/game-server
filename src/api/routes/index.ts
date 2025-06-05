import express from 'express';
import heathRouter from './health';

const router = express.Router();
router.use('/health', heathRouter);

export default router;