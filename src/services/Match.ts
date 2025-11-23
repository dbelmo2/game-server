import { Socket } from 'socket.io';
import { Projectile, ProjectileStateUpdate } from '../game/entities/Projectile';
import logger from '../utils/logger';
import { 
  testForAABB,
  PROJECTILE_WIDTH,
  PROJECTILE_HEIGHT,
  PLAYER_WIDTH,
  PLAYER_HEIGHT
} from '../game/systems/collision';
import { Player, PlayerState, PlayerStateBroadcast, PlayerStateBroadcastUpdate } from '../game/entities/Player';
import { Platform } from '../game/entities/Platform';
import { InputVector } from '../game/systems/Vector';
import ObjectPool from '../game/systems/ObjectPool';


// TODO: (this is done, its the input debt system)
// When using the previous input, add the input to a stack. If a player input
// is then recieved, check the input at the top of the stack. If it matches the incoming input,
// we've essentially already processed this input, so we can ignore it and pop the stack.

// Problem: Server might use previous input but rather then there being delayed
// input, the client simply stopped sending input. In this siatuation, we can either
// 1. Simply teleport the player to the overcorrected server position
// 2. Keep track of the simulated inputs and undo them once the stop input is received (0, 0). =
//    This would make the server position snap back to the client positon. But the client would probably also snap.
//    Any inputs that were accurately predicted can be kept. For example,
//    server predicts 5 left inputs. The client then send 3 left inputs, then a stop. 
//    The 3 left inputs can be kept, with the 2 last ones being undone on the server in a single tick.
//    This will avoid the client snapping back to the server position.
type Region = 'NA' | 'EU' | 'ASIA' | 'GLOBAL';


export type PlayerScore = {
  kills: number;
  deaths: number;
  name: string;
};

export type WorldState = {
    players: Map<string, Player>;
    platforms: Platform[];
    playerInputCounts: Map<string, { count: number; windowStart: number }>;
};

export type InputPayload = {
  tick: number;
  vector: InputVector;
}


const MAX_KILL_AMOUNT = 4; // Adjust this value as needed


// CRITICAL BUG:

// 2. Score display not centered when dev tools open
// 4. daily metrics in db?
// 5. allow falling through platforms when holding down
// -----------
// TODO: Fix issue where, the jump command arrives while the server position is still in the air,
// but the client is on the ground. In this situation, the server and the client are synced up to a tick before the jump arrives,
// yet for some reason the server position is still in the air.
/*

B: Player coordinates 54 ticks after jump: 137.5, 1034.1666666666667. localTick: 1924

broadcasting gamesate with laasdt player input tick: 1924

B: Player coordinates 57 ticks after jump: 137.5, 1067.9166666666667. localTick: 1927

Yes input payload scenario: Updated last processed input with tick: 1927 and vector: x=0, y=0

broadcasting gamesate with laasdt player input tick: 1927

Jumping... Current coordinates: 137.5 1067.9166666666667 Input vector: { x: 0, y: -1 }

A: Player coordinates 58 ticks after jump: 137.5, 1044.1666666666667. localTick: 1931

broadcasting gamesate with laasdt player input tick: 1931


--------

In these example logs, for the client, the jump occured at y = 1080, but at 1927, y was 1067.9166666666667
matching the server position.

*/

export class Match {
  private readonly GAME_WIDTH = 1920;  // Fixed game width
  private readonly GAME_HEIGHT = 1080; // Fixed game height
  private readonly STARTING_X = 100;
  private readonly STARTING_Y = 100;
  private readonly TICK_RATE = 30; // 60 ticks per second
  private readonly MIN_MS_BETWEEN_TICKS = 1000 / this.TICK_RATE;
  private readonly MIN_S_BETWEEN_TICKS = this.MIN_MS_BETWEEN_TICKS / 1000; // Convert to seconds
  private readonly RATE_LIMIT_WINDOW_MS = 1000; // 1 second
  private readonly MAX_INPUT_RATE = 100; // Max inputs per second
  private readonly GAME_BOUNDS = {
    left: 0,
    right: this.GAME_WIDTH,
    top: 0,
    bottom: this.GAME_HEIGHT
  };

  

  private pendingFullStateBroadcast = false;

  private matchResetTimeout: NodeJS.Timeout | null = null;
  private AFK_THRESHOLD_MS = 60000; // 60 seconds of inactivity
  private DISCONNECT_GRACE_PERIOD_MS = 20000; // 20 seconds to reconnect before removal


  private worldState: WorldState = {
    players: new Map(),
    platforms: [],
    playerInputCounts: new Map<string, { count: number; windowStart: number }>(),
  };


  private id: string;
  private region: Region;
  private timeoutIds: Set<NodeJS.Timeout> = new Set();
  private sockets: Map<string, Socket> = new Map(); // TODO: Does this grow indefinitely? transform to map?
  private respawnQueue: Set<string> = new Set();
  private projectileUpdates: Map<string, ProjectileStateUpdate> = new Map();
  private disconnectedPlayerCleanup: Map<string, { playerId: string, socketId: string, disconnectTime: number }> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private matchIsActive = false;
  private lastUpdateTime = Date.now();
  private isReady = false; // Utilized by parent loop
  private accumulator: number = 0;
  private shouldRemove = false;
  private serverTick = 0;
  private onNewRoundCallback?: () => void;
  private io: any; // Socket.IO server instance

  constructor(
    firstPlayerSocket: Socket,
    firstPlayerName: string,
    region: Region,
    id = `match-${Math.random().toString(36).substring(2, 8)}`,
    private setDisconnectedPlayerCallback: (playerId: string, matchId: string, timeoutId: NodeJS.Timeout) => void,
    private removeDisconnectedPlayerCallback: (playerId: string) => void,
    io: any, // Socket.IO server instance
    onNewRound?: () => void
  ) {
    this.id = id;
    this.region = region;
    this.initializePlatforms()
    this.addPlayer(firstPlayerSocket, firstPlayerName);
    this.isReady = true;
    this.matchIsActive = true;
    this.io = io;
    this.onNewRoundCallback = onNewRound;

    logger.info(`Match ${this.id} created in region ${region} with first player ${firstPlayerName}`);
    // Start game loop loop (this will broadcast the game state to all players)
    
    // Start periodic cleanup for disconnected players (every 3 seconds)
    this.cleanupInterval = setInterval(() => {
      // TODO: Check why this prints 3 times 
      this.processDisconnectedPlayerCleanup();
    }, 3000);
  }


  public getPlayerIdFromSocketId(socketId: string): string | undefined {
    for (const [playerId, socket] of this.sockets.entries()) {
      if (socket.id === socketId) {
        return playerId;
      }
    }
    return undefined;
  }

  public addPlayer(socket: Socket, name: string): string {
    // Truncate the last 4 digits of the players socket.id with the last 3 of the match id and use as their playerId
    const playerMatchId = socket.id.slice(0, -4) + this.id.slice(-3);
    
    if (this.sockets.has(playerMatchId)) {
      logger.warn(`Player ${playerMatchId} is already connected to match ${this.id}`);
      return playerMatchId;
    }

    this.sockets.set(playerMatchId, socket);

    // This is a new player
    const serverPlayer = new Player(
      playerMatchId, // Use UUID instead of socket.id
      name, 
      this.STARTING_X,
      this.STARTING_Y,
      this.GAME_BOUNDS
    );

    serverPlayer.setPlatforms(this.worldState.platforms);
    // Initialize new player as bystander
    this.worldState.players.set(playerMatchId, serverPlayer);

    this.setUpPlayerSocketHandlers(playerMatchId, socket);
    logger.info(`Player ${name} (playerId: ${playerMatchId}) joined match ${this.id} in region ${this.region}`);
    logger.info(`Match ${this.id} now has ${this.worldState.players.size} players`);


    return playerMatchId;
  }

  public rejoinPlayer(socket: Socket, playerMatchId: string): void {
    const player = this.worldState.players.get(playerMatchId);
    if (!player) {
      logger.error(`Player ${playerMatchId} attempted to rejoin match ${this.id} but was not found in game state`);
      socket.emit('error', { message: 'Player not found in match' });
      socket.disconnect(true);
      this.removeDisconnectedPlayerCallback(playerMatchId);
      throw new Error(`Player ${playerMatchId} not found in match ${this.id}`);
    }
    
    player.setDisconnected(false);
    
    // Remove from disconnect cleanup map instead of clearing timeout
    if (this.disconnectedPlayerCleanup.has(playerMatchId)) {
      this.disconnectedPlayerCleanup.delete(playerMatchId);
      logger.info(`Removed player ${playerMatchId} from disconnect cleanup queue`);
    }
    
    this.sockets.set(playerMatchId, socket);
    this.removeDisconnectedPlayerCallback(playerMatchId);
    this.setUpPlayerSocketHandlers(playerMatchId, socket);

    logger.info(`Player ${player.getName()} (${playerMatchId}) rejoined match ${this.id}`);
  }

  public getIsReady(): boolean {
    return this.isReady;
  }

  public getId(): string {
    return this.id;
  } 


  public getNumberOfPlayers(): number {
    return this.worldState.players.size;
  }

  public getRegion(): Region {
    return this.region;
  }

  public update(): void {
    try {
      // Calculate elapsed time since last loop
      const now = Date.now();
      const frameTime = now - this.lastUpdateTime;
      this.lastUpdateTime = now;

      // Cap maximum frame time to prevent spiral of death on slow devices
      const cappedFrameTime = Math.min(frameTime, 100); 
    
      // Add elapsed time to accumulator
      this.accumulator += cappedFrameTime;

      // Run fixed updates as needed
      while (this.accumulator >= this.MIN_MS_BETWEEN_TICKS) {
        this.updatePhysics(this.MIN_S_BETWEEN_TICKS); // Pass fixed delta
        this.processAfkPlayers();
        this.accumulator -= this.MIN_MS_BETWEEN_TICKS;
        this.serverTick++;
      }
    } catch (error) {
      this.handleError(error as Error, 'gameLoop');
    }
  }


  public informShowIsLive(): void { 
    logger.info(`Match ${this.id} is live! Informing players...`);
    if (this.io) {
      this.io.to(this.id).emit('showIsLive');
    } else {
      for (const socket of this.sockets.values()) {
        socket.emit('showIsLive');
      }
    }
  }
  
  public processAfkPlayers(): void {
    const currentTime = Date.now();
    for (const [playerId, player] of this.worldState.players.entries()) {

        if (player.getIsDisconnected()) {
          continue;
        }

        if (currentTime - player.getLastInputTimestamp() > this.AFK_THRESHOLD_MS && !player.afkRemoveTimer) {
            logger.info(`Player ${player.getName()} (${playerId}) is AFK and will be removed from match ${this.id}`);
            const playerSocket = this.sockets.get(playerId);
            if (playerSocket) {
              playerSocket.emit('afkWarning', { message: 'You have been inactive for too long and will be removed from the match.' });
              player.afkRemoveTimer = setTimeout(() => {
                playerSocket.emit('afkRemoved', { message: 'You have been removed from the match due to inactivity.' });
                playerSocket.disconnect(true);
                this.timeoutIds.delete(player.afkRemoveTimer!);
              }, 10000); // Wait 10 seconds before removing

              this.timeoutIds.add(player.afkRemoveTimer)
            }
        }
      }
  }

  /**
   * Process disconnected players and remove those who exceeded grace period
   */
  private processDisconnectedPlayerCleanup(): void {
    const currentTime = Date.now();
    const playersToRemove: string[] = [];

    for (const [key, disconnectInfo] of this.disconnectedPlayerCleanup.entries()) {
      const { playerId, socketId, disconnectTime } = disconnectInfo;
      
      // Check if grace period has elapsed
      if (currentTime - disconnectTime > this.DISCONNECT_GRACE_PERIOD_MS) {
        logger.info(`Grace period elapsed for player ${playerId} in match ${this.id}. Scheduling for removal...`);
        playersToRemove.push(key);
        
        // Remove from game state
        this.removePlayerFromGameState(playerId);
        this.removeDisconnectedPlayerCallback(playerId);
      }
    }

    // Clean up processed entries
    for (const key of playersToRemove) {
      this.disconnectedPlayerCleanup.delete(key);
    }

    // Log cleanup status for debugging
    if (this.disconnectedPlayerCleanup.size > 0) {
      logger.debug(`Disconnect cleanup check complete. ${this.disconnectedPlayerCleanup.size} players still in grace period for match ${this.id}`);
    }

  }

  public getPlayerIds(): string[] {
    return Array.from(this.worldState.players.keys());
  }

  public getShouldRemove(): boolean {
    return this.shouldRemove;   
  }

  public cleanUpSession() {
    this.cleanupInterval && clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
    // Clear all timeout IDs
    for (const id of this.timeoutIds) {
      clearTimeout(id);
    }
    
    this.projectileUpdates.clear();
    // Explicitly clear match reset timeout
    if (this.matchResetTimeout) {
      clearTimeout(this.matchResetTimeout);
      this.matchResetTimeout = null;
    }

    // Remove event listeners from sockets
    for (const socket of this.sockets.values()) {
      socket.removeAllListeners();
    }
    
    for (const player of this.worldState.players.values()) {
      player.destroy();
    }

    // Clear all game state
    this.worldState.players.clear();
    this.timeoutIds.clear();
    this.sockets.clear();
    this.respawnQueue.clear();

    

    this.setDisconnectedPlayerCallback = () => {};
    this.removeDisconnectedPlayerCallback = () => {};

    
    logger.info(`Match ${this.id} ended and cleaned up \n\n`);
  }

  private integratePlayerInputs(dt: number) {
    for (const player of this.worldState.players.values()) {
      if (player.getIsDead()) {
        continue;
      }

      const max = 1;
      let numIntegrations = 0;

      // TODO: Address isse of number of inputs being processed and applying gravity multiple times...
      // Idea... scale changes in update() based on how many inputs are processed...?
      let skipped = false; // Track if we skipped processing an input
      while (numIntegrations < max) {
        const inputPayload = player.dequeueInput();
        if (!inputPayload) {
          numIntegrations = max; // No more inputs to process
          const lastProcessedInput = player.getLastProcessedInput();
          const lastProcessedInputVector = lastProcessedInput?.vector ?? { x: 0, y: 0 };
          // Reset y to 0 to avoid predicted double jump issues.
          // This does not cause issues as there is no realistic scenario where a player intends to
          // send two jump inputs in a row. Therefore we know we will never need to predict this scenario.
          // Same with shooting/mouse inputs
          lastProcessedInputVector.y = 0;
          lastProcessedInputVector.mouse = undefined;
          // We only add input debt if the player is not AFK.
          // AFK here means on a surface standing still.
          if (player.isAfk(lastProcessedInputVector) === false) {
            player.addInputDebt(lastProcessedInputVector);
          }
          const newTick = lastProcessedInput?.tick ? lastProcessedInput.tick + 1 : 0;
          player.update(lastProcessedInputVector, dt, newTick, 'A');
          if (player.isShootingActive() && lastProcessedInput) {
            this.handlePlayerShooting(player, lastProcessedInput)
          }
          player.setLastProcessedInput({ tick: newTick || 0, vector: lastProcessedInputVector });
          logger.debug(`Player ${player.getName()} no input payload scenario: Updated last processed input with tick: ${newTick} and vector: x=${lastProcessedInputVector.x}, y=${lastProcessedInputVector.y}`);
        } else {         
          const inputDebtVector = player.peekInputDebt();
          if (!inputDebtVector) {
            // We have no input debt, so we can process the input normally.
            player.update(inputPayload.vector, dt, inputPayload.tick, 'B');
          } else if (
            inputDebtVector.x === inputPayload.vector.x 
            && inputDebtVector.y === inputPayload.vector.y
            && inputPayload.vector.mouse === undefined
          ) {
            // If the input matches the last processed input, we've already processed it and can skip it.
            player.popInputDebt();
            skipped = true;

          } else {
            // We've overpredicted and this is an entierly new input.
            player.clearInputDebt();
            player.update(inputPayload.vector, dt, inputPayload.tick, 'C');
          }

          if (player.isShootingActive()) {
            this.handlePlayerShooting(player, inputPayload)
          }
        }

        
  
        if (inputPayload && skipped === false) {
          player.setLastProcessedInput(inputPayload);
          logger.debug(`Updated last processed input with new input payload sent from client. tick: ${inputPayload.tick} and vector: x=${inputPayload.vector.x}, y=${inputPayload.vector.y}`);
        }

        numIntegrations++;
      }
    }
  };


  private handleToggleBystander(playerId: string): void {
    const player = this.worldState.players.get(playerId);
    if (!player) {
      logger.error(`Player ${playerId} attempted to toggle bystander mode but was not found in match ${this.id}`);
      return;
    }
    player.setIsBystander(false);
    logger.info(`Player ${player.getName()} (${playerId}) left bystander mode in match ${this.id}`);

  }

  private handlePing(socket: Socket, data: any): void {
    socket.emit('m-pong', { serverTime: performance.now(), ...data });
  }



  

  private initializePlatforms(): void {
    // Initialize platforms here 
    this.worldState.platforms = [
          new Platform(115, this.GAME_HEIGHT - 250),
          new Platform(this.GAME_WIDTH - 610, this.GAME_HEIGHT - 250),
          new Platform(115, this.GAME_HEIGHT - 500),
          new Platform(this.GAME_WIDTH - 610, this.GAME_HEIGHT - 500)

    ];
  }
  
  private setUpPlayerSocketHandlers(playerId: string, socket: Socket) {
    socket.removeAllListeners('toggleBystander');
    socket.removeAllListeners('disconnect');
    socket.removeAllListeners('ping');
    socket.removeAllListeners('playerInput');
    socket.removeAllListeners('projectileHit');

    // Move shoot handling and toggleBystander to PlayerInput event.
    socket.on('toggleBystander', () => this.handleToggleBystander(playerId));
    socket.on('connection_error', (err) => {
      logger.error(`Connection error for player ${playerId} in match ${this.id}: ${err.message}`);
    });
    socket.on('connection_timeout', (err) => {
      logger.error(`Connection timeout for player ${playerId} in match ${this.id}: ${err.message}`);
    });
    socket.on('reconnect_error', (err) => {
      logger.error(`Reconnect error for player ${playerId} in match ${this.id}: ${err.message}`);
    });
    socket.on('disconnect', (reason) => this.handlePlayerDisconnect(socket, playerId, reason));
    socket.on('m-ping', (data) => this.handlePing(socket, data));
    socket.on('playerInput', (inputPayload: InputPayload) => this.handlePlayerInputPayload(playerId, inputPayload));
    socket.on('projectileHit', ({ enemyId, projectileId}) => this.handleProjectileHit(playerId, enemyId, projectileId));

    this.broadcastFullStateNextLoop();
  }
// Left off reviewing disconnect changes here. CHeck disconnect-notes.txt
  private handleProjectileHit(playerId: string, enemyId: string, projectileId: string): void {
    const player = this.worldState.players.get(playerId);
    if (!player) {
      logger.error(`Player ${playerId} attempted to hit an enemy but was not found in match ${this.id}`);
      return;
    }

    const enemy = this.worldState.players.get(enemyId);
    if (!enemy) {
      logger.error(`Enemy ${enemyId} not found for player ${playerId} in match ${this.id}`);
      return;
    }

    // first check if the projectile exists in the world state history
    // and that it belongs to the player
    // Handle projectile hit logic
    this.handleCollision(playerId, enemy, projectileId);
  }


  private checkRateLimit(playerId: string): boolean {
      const now = Date.now();
      const record = this.worldState.playerInputCounts.get(playerId);
      
      if (!record || now - record.windowStart >= this.RATE_LIMIT_WINDOW_MS) {
        // New window
        this.worldState.playerInputCounts.set(playerId, { count: 1, windowStart: now });
        return true;
      }
      
      if (record.count >= this.MAX_INPUT_RATE) {
        return false; // Rate limit exceeded
      }
      
      record.count++;
      return true;
  }


  private handlePlayerInputPayload(playerId: string, playerInput: InputPayload): void {
    const player = this.worldState.players.get(playerId);
    if (!player) {
      logger.error(`Player ${playerId} attempted to send input but was not found in match ${this.id}`);
      return;
    }


    if (this.checkRateLimit(playerId) === false) {
      logger.warn(`Player ${player.getName()} (${playerId}) is sending inputs too quickly in match ${this.id}`);
      return;
    }



    player.queueInput(playerInput);

    if (player.afkRemoveTimer) {
      clearTimeout(player.afkRemoveTimer); // Clear any existing AFK timeout
      this.timeoutIds.delete(player.afkRemoveTimer); // Clear any existing AFK timeout
      player.afkRemoveTimer = undefined; // Reset AFK timer on input
    }
  }

  private checkWinCondition() {
    // If match is already inactive or reset timeout is set, don't check win condition again
    if (!this.matchIsActive || this.matchResetTimeout) {
      return;
    }
    
    const sortedScores = this.getAllPlayerScores()
      .sort((a, b) => b.kills - a.kills);

    const winner = sortedScores[0];
    
    if (winner && winner.kills >= MAX_KILL_AMOUNT) {
      // Get winner name
      const winnerPlayer = this.worldState.players.get(winner.playerId);
      const winnerName = winnerPlayer ? winnerPlayer.getName() : winner.name;
      
      logger.info(`Match ${this.id} ended. Winner: ${winnerName} (${winner.playerId}) with ${winner.kills} kills`);
      logger.info(`Final scores for match ${this.id}:`);
      

      // Emit game over event with sorted scores
      this.matchIsActive = false;
      
      // Clear any pending respawn timeouts
      for (const id of this.timeoutIds) {
        clearTimeout(id);
      }

      // Respawn any players in the respawn queue

      for (const playerId of this.respawnQueue) {
        const player = this.worldState.players.get(playerId);
        if (player) {
          // Remove existing player instance before respawning
          player.respawn(this.STARTING_X, this.STARTING_Y);
        }
      }
    
      if (this.io) {
        logger.info(`Emitting gameOver event to room ${this.id} in match ${this.id}`);
        this.io.to(this.id).emit('gameOver', sortedScores);
      } else {
        for (const socket of this.sockets.values()) {
          logger.info(`Emitting gameOver event to player socket ${socket.id} in match ${this.id}`);
          socket.emit('gameOver', sortedScores);
        }
      }

      this.respawnQueue.clear();

      // Reset match - ensure we don't set multiple timeouts
      if (!this.matchResetTimeout) {
        logger.info(`Setting up match reset timeout for match ${this.id}`);
        this.matchResetTimeout = setTimeout(() => this.resetMatch(), 10000); // Wait 10 seconds before resetting
        this.timeoutIds.add(this.matchResetTimeout);
      }


    }
  }

  public broadcastFullStateNextLoop() {
    this.pendingFullStateBroadcast = true;
  }


  // Extract state broadcast into its own method
  public broadcastGameState(): number | undefined {
    try {

      const projectileUpdates = Array.from(this.projectileUpdates).map(([id, update]) => update);
      this.projectileUpdates.clear();

      const playerStates = this.pendingFullStateBroadcast === false ? this.getPlayerBroadcastState() : this.getFullPlayerBroadcastStates();
      this.pendingFullStateBroadcast = false;

      const gameState = {
        sTick: this.serverTick,
        sTime: performance.now(),
        players: playerStates,
        projectiles: projectileUpdates,
      };

      const stateString = JSON.stringify(gameState);
      const sizeInBytes = Buffer.byteLength(stateString, 'utf8');

      // Use room broadcasting if io instance is available, otherwise fallback to loop
      if (this.io) {
        this.io.to(this.id).emit('stateUpdate', gameState);
      } else {
        // Fallback to individual socket emissions
        for (const socket of this.sockets.values()) {
          socket.emit('stateUpdate', gameState);
        }
      }

      return sizeInBytes;

    } catch (error) {
      this.handleError(error as Error, 'broadcastState');
    }
  }


  // Extract fixed update logic into its own method
  private updatePhysics(dt: number): void {
    try {
      // Process player updates with fixed delta
      this.integratePlayerInputs(dt);
  
      // Check win condition
      this.checkWinCondition();

    } catch (error) {
      this.handleError(error as Error, 'fixedUpdate');
    }
  }


  private handlePlayerDisconnect(socket: Socket, playerId: string, reason?: string): void {
    // Get the UUID associated with this socket
    const socketId = socket.id;
    if (!playerId) {
      logger.warn(`Socket ${socketId} disconnected but no UUID mapping found in match ${this.id}`);
      return;
    }

    const player = this.worldState.players.get(playerId);
    if (!player) {
      logger.warn(`Player UUID ${playerId} disconnected but was not found in match ${this.id}`);
      return;
    }

    // Add to disconnect cleanup map instead of using timeout
    const disconnectTime = Date.now();
    this.disconnectedPlayerCleanup.set(playerId, {
      playerId,
      socketId,
      disconnectTime
    });

    this.setDisconnectedPlayerCallback(playerId, this.id, {} as NodeJS.Timeout); // Pass dummy timeout for now
    player.setDisconnected(true);

    logger.info(`Player (UUID: ${playerId}) disconnected from match ${this.id} at ${disconnectTime}. Reason: ${reason}. Grace period: ${this.DISCONNECT_GRACE_PERIOD_MS}ms`);

    // Remove socket from active sockets list but keep player in game state
    // (This is done as reconnecting players will get a new socket ID)
  
    socket.removeAllListeners();
    this.sockets.delete(playerId);
  }



  private removePlayerFromGameState(playerId: string): void {
      // If the timeout executes, the player did not reconnect in time
      logger.info(`Player ${playerId} did not reconnect within grace period. Removing from match ${this.id}.`);

      // Notify matchmaker first
      this.removeDisconnectedPlayerCallback(playerId);

      const player = this.worldState.players.get(playerId);
      if (!player) {
        logger.warn(`Player UUID ${playerId} not found in match ${this.id} during removal process. Players remaining: ${this.worldState.players.size}`);
        return; // Early return if player not found
      }
      
      logger.info(`Found player ${player.getName()} (${playerId}) in match ${this.id}. Proceeding with removal.`);
      player.destroy();

      this.respawnQueue.delete(playerId);
      
      // Actually remove the player now
      this.worldState.players.delete(playerId);
      logger.info(`Removed player ${playerId} from worldState. Remaining players: ${this.worldState.players.size}`);

      // Clean up from our tracking map
      this.sockets.delete(playerId);

      // Check if we need to mark the match for removal
      if (this.worldState.players.size === 0) {
        logger.info(`All players left match ${this.id}. Marking for removal.`);
        this.shouldRemove = true;
        // Let the server loop handle the actual removal
      }
  }
  
  private handlePlayerShooting(
    player: Player, 
    inputPayload: InputPayload,
  ): void {
      player.resetShooting(); // Reset shooting state after handling input
      if (!inputPayload.vector.mouse) return

      const { x, y, id } = inputPayload.vector.mouse;

      if (player.getIsBystander()) {
        return;
      }      

      const velocity = Projectile.calculateVelocity(player.getX(), player.getY() - 50, x, y);
      const projectileUpdate = {
        id,
        ownerId: player.getId(),
        x: player.getX(),
        y: player.getY() - 50,
        vx: velocity.vx,
        vy: velocity.vy,
      }

      this.projectileUpdates.set(projectileUpdate.id, projectileUpdate);

  }

  private handleCollision(shooterId: string, target: Player, projectileId: string): void {
      if (target.getIsBystander()) return; // Prevent damage to bystanders
      target.damage(10);

      if (target.getHp() <= 0) {
        this.handlePlayerDeath(target.getId(), target.getName(), shooterId);
        target.destroy();
      }

      if (this.projectileUpdates.has(projectileId)) {
        const currentUpdate = this.projectileUpdates.get(projectileId);
        if (currentUpdate) {
          currentUpdate.dud = true;
          this.projectileUpdates.set(projectileId, currentUpdate);
        }
      } else {
        this.projectileUpdates.set(projectileId, { id: projectileId, dud: true });
      }
  }

  private handlePlayerDeath(victimId: string, victimName: string, killerId: string) {
      // Mark player as dead instead of removing them
      const victim = this.worldState.players.get(victimId);
      const killer = this.worldState.players.get(killerId);
      
      if (victim) {
        victim.addDeath();
        logger.info(`Player ${victimName} (${victimId}) was killed by ${killer?.getName() || "Unknown Player"} (${killerId}) in match ${this.id}`);
      } else {
        logger.warn(`Failed to update deaths for player ${victimName} (${victimId}) - player not found`);
      }
      
      // Update kill count for shooter
      if (killer) {
        killer.addKill();
        logger.info(`Player ${killer.getName()} (${killerId}) now has ${killer.getKills()} kills in match ${this.id}`);
        this.checkWinCondition();
      } else {
        logger.error(`Failed to update kills for player (${killerId}) - player not found`);
      }

      this.scheulePlayerRespawn(victimId);
  }

  private scheulePlayerRespawn(playerId: string): void {
      this.respawnQueue.add(playerId);
      const id = setTimeout(() => {
        const needsRespawn = this.respawnQueue.has(playerId);
        if (needsRespawn === false) return; // Player is not in respawn queue
        this.respawnQueue.delete(playerId);
        const player = this.worldState.players.get(playerId);
        if (player) {
          player.respawn(this.STARTING_X, this.STARTING_Y);
        }
        this.timeoutIds.delete(id);
      }, 3000);

      this.timeoutIds.add(id);
  }

  private resetMatch(): void {
    logger.info(`Resetting match ${this.id} for a new round`);
    if (this.matchResetTimeout) {
      clearTimeout(this.matchResetTimeout);
      this.timeoutIds.delete(this.matchResetTimeout);
      this.matchResetTimeout = null;
    }


    this.projectileUpdates.clear();

    // Reset player health and scores but maintain positions and bystander status
    for (const [playerId, player] of this.worldState.players.entries()) {
      player.resetHealth();
      // Keep x, y positions and isBystander state
      
      // Reset scores for new round - now handled by Player class
      player.resetScore();
      
    }
    logger.info(`Match ${this.id} reset complete with ${this.worldState.players.size} players`);
    
    // Force a full state broadcast to all clients immediately after reset
    this.broadcastFullStateNextLoop();
    logger.info(`Scheduled full state broadcast after match reset for match ${this.id}`);
    
    // Inform players of match reset
    if (this.io) {
      this.io.to(this.id).emit('matchReset');
    } else {
      for (const socket of this.sockets.values()) {
        socket.emit('matchReset');
      }
    }

    this.matchIsActive = true;
    if (this.onNewRoundCallback) this.onNewRoundCallback();
  }

  private handleError(error: Error, context: string): void {
    logger.error(`Error in Match ${this.id} - ${context}: ${error.message}`);
    // Could add additional error handling logic here
  }


  private getFullPlayerBroadcastStates(): PlayerStateBroadcast[] {
    const states: PlayerStateBroadcast[] = [];
    for (const player of this.worldState.players.values()) {
      const fullState = player.getFullBroadcastState();
      states.push(fullState);
    }
    return states;
  }


  private getAllPlayerScores(): Array<{playerId: string, kills: number, deaths: number, name: string}> {
    const scores: Array<{playerId: string, kills: number, deaths: number, name: string}> = [];
    for (const player of this.worldState.players.values()) {
      const state = player.getLatestState();
      scores.push({
        playerId: state.id,
        kills: state.kills,
        deaths: state.deaths,
        name: state.name
      });
    }
    return scores;
  }

  private getPlayerBroadcastState(): PlayerStateBroadcast[] {
    const states: PlayerStateBroadcast[] = [];
    for (const player of this.worldState.players.values()) {
      // Use delta method to only send changed data
      const deltaState = player.getLatestStateDelta();
      states.push(deltaState);
      if (deltaState.kills || deltaState.deaths) {
        logger.debug(`Player ${player.getName()} (${player.getId()}) delta state includes kills/deaths: kills=${deltaState.kills}, deaths=${deltaState.deaths}`);
      }
    }
    return states;
  }
}
