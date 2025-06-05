import request from 'supertest';
import express from 'express';
import { playerRoutes } from '../../../src/api/routes/player.routes';
import { authMiddleware } from '../../../src/api/middlewares/auth.middleware';

// Mock dependencies
jest.mock('../../src/api/middlewares/auth.middleware', () => ({
  authMiddleware: jest.fn((req, res, next) => next()),
}));

describe('Player API Integration Tests', () => {
  let app: express.Express;
  
  beforeEach(() => {
    // Reset mock and create fresh Express app for each test
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/players', playerRoutes);
  });
  
  describe('GET /api/players', () => {
    it('should return a list of players', async () => {
      const response = await request(app).get('/api/players');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('players');
      expect(Array.isArray(response.body.players)).toBe(true);
    });
    
    it('should call the auth middleware', async () => {
      await request(app).get('/api/players');
      expect(authMiddleware).toHaveBeenCalled();
    });
  });
  
  describe('GET /api/players/:id', () => {
    it('should return a player by ID', async () => {
      const response = await request(app).get('/api/players/1');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('player');
      expect(response.body.player).toHaveProperty('id', '1');
    });
    
    it('should call the auth middleware', async () => {
      await request(app).get('/api/players/1');
      expect(authMiddleware).toHaveBeenCalled();
    });
  });
  
  describe('POST /api/players', () => {
    it('should create a new player', async () => {
      const response = await request(app)
        .post('/api/players')
        .send({ username: 'testplayer' })
        .set('Content-Type', 'application/json');
      
      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('player');
      expect(response.body.player).toHaveProperty('username', 'testplayer');
      expect(response.body.player).toHaveProperty('id');
    });
  });
});
