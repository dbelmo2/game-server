import express from 'express';
import { handleShowIsLive } from '../controllers/live';


const router = express.Router();


router.post('/', handleShowIsLive);

export default router;