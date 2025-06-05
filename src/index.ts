import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import http from 'http';
import logger from './utils/logger';

import { Server as SocketIOServer } from 'socket.io';
import MatchMaker, { Region } from './services/MatchMaker';
import { errorMiddleware } from './api/middleware/error';
import { rateLimiter } from './api/middleware/rateLimit';
import { config } from './config/config';
import routes from './api/routes/index';
import connectionHandler from './sockets/handlers/Connection';


const app = express();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: config.CLIENT_URL || '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 30000
});

app.set('trust proxy', 1);
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.text({ type: 'application/atom+xml' }));
app.use(errorMiddleware);

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();
  return rateLimiter(req, res, next);
});

app.use('/api', routes);

io.on('connection', connectionHandler);

const PORT = config.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});
