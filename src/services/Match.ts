import { Socket } from 'socket.io';
import { Projectile } from '../game/entities/Projectile';
import logger from '../utils/logger';
import { 
  testForAABB,
  PROJECTILE_WIDTH,
  PROJECTILE_HEIGHT,
  PLAYER_WIDTH,
  PLAYER_HEIGHT
} from '../game/systems/collision';
import { Player, PlayerState } from '../game/entities/Player';
import { Platform } from '../game/entities/Platform';
import { Controller } from '../game/systems/PlayerController';
import { Vector2 } from '../game/systems/Vector';
import { error } from 'console';


// TODO:
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
    projectiles: Projectile[];
    platforms: Platform[];

};

export type PlayerStatePayload = {
  id: string;
  position: Vector2;
  hp: number;
  isBystander: boolean;
  name: string;
  velocity: Vector2;
  tick: number;

}

export type InputPayload = {
  tick: number;
  vector: Vector2;
}

const MAX_KILL_AMOUNT = 3; // Adjust this value as needed


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

TODO: fix lingering players bug where a player disconnects but is still in the match...
perhaphs, instead of adding an afk timeout, we update when the last update was received and if its been more than 60 seconds, we remove them.
We would check in the main game loop



*/

export class Match {
  private readonly GAME_WIDTH = 1920;  // Fixed game width
  private readonly GAME_HEIGHT = 1080; // Fixed game height
  private readonly STARTING_X = 100;
  private readonly STARTING_Y = 100;
  private readonly TICK_RATE = 60; // 60 ticks per second
  private readonly MIN_MS_BETWEEN_TICKS = 1000 / this.TICK_RATE;
  private readonly MIN_S_BETWEEN_TICKS = this.MIN_MS_BETWEEN_TICKS / 1000; // Convert to seconds
  private readonly GAME_BOUNDS = {
    left: 0,
    right: this.GAME_WIDTH,
    top: 0,
    bottom: this.GAME_HEIGHT
  };


  private matchResetTimeout: NodeJS.Timeout | null = null;
  private AFK_THRESHOLD_MS = 60000; // 60 seconds of inactivity
  private DISCONNECT_GRACE_PERIOD_MS = 20000; // 20 seconds to reconnect before removal


  private worldState: WorldState = {
    players: new Map(),
    projectiles: [],
    platforms: [],
  };
  
  
  // Map socket IDs to player UUIDs for tracking connections/reconnections
  private socketIdToPlayerId: Map<string, string> = new Map();
  private playerIdToSocketId: Map<string, string> = new Map();

  private id: string;
  private region: Region;
  private timeoutIds: Set<NodeJS.Timeout> = new Set();
  private playerScores: Map<string, PlayerScore> = new Map();
  private sockets: Socket[] = [];
  private respawnQueue: Map<string, string> = new Map();
  private matchIsActive = false;
  private lastUpdateTime = Date.now();
  private isReady = false; // Utilized by parent loop
  private accumulator: number = 0;
  private shouldRemove = false;
  private serverTick = 0;

  constructor(
    firstPlayerId: string,
    firstPlayerSocket: Socket,
    firstPlayerName: string,
    region: Region,
    id = `match-${Math.random().toString(36).substring(2, 8)}`,
    private setDisconnectedPlayerCallback: (playerId: string, matchId: string, timeoutId: NodeJS.Timeout) => void,
    private removeDisconnectedPlayerCallback: (playerId: string) => void
  ) {
    this.id = id;
    this.region = region;
    this.initializePlatforms()
    this.addPlayer(firstPlayerSocket, firstPlayerId, firstPlayerName);
    this.isReady = true;
    this.matchIsActive = true;

    logger.info(`Match ${this.id} created in region ${region} with first player ${firstPlayerName}`);
    // Start game loop loop (this will broadcast the game state to all players)
  }

  public addPlayer(socket: Socket, playerId: string, name: string): void {

    if (this.sockets.some(s => s.id === socket.id)) {
      logger.warn(`Socket ${socket.id} is already connected to match ${this.id}`);
      return;
    }

    this.sockets.push(socket);
    
    // Get the player's UUID from socket authentication
    
    // Store the socket ID to UUID mapping
    this.socketIdToPlayerId.set(socket.id, playerId);
    this.playerIdToSocketId.set(playerId, socket.id);

    // This is a new player
    const serverPlayer = new Player(
      playerId, // Use UUID instead of socket.id
      name, 
      this.STARTING_X,
      this.STARTING_Y,
      this.GAME_BOUNDS
    );

    serverPlayer.setPlatforms(this.worldState.platforms);
    // Initialize new player as bystander
    this.worldState.players.set(playerId, serverPlayer);

    this.playerScores.set(playerId, {
      kills: 0,
      deaths: 0,
      name
    });
  
    this.setUpPlayerSocketHandlers([socket]);
    logger.info(`Player ${name} (UUID: ${playerId}) joined match ${this.id} in region ${this.region}`);
    logger.info(`Match ${this.id} now has ${this.worldState.players.size} players`);

    // Inform new player of current game state
    socket.emit('stateUpdate', {
      players: this.getPlayerStates(),
      projectiles: [],
      scores: Array.from(this.playerScores.entries())
        .map(([playerId, score]) => ({
          playerId,
          ...score
        }))
    });
  }

  public rejoinPlayer(socket: Socket, playerId: string, timeoutId: NodeJS.Timeout): void {
    const player = this.worldState.players.get(playerId);
    if (!player) {
      logger.error(`Player ${playerId} attempted to rejoin match ${this.id} but was not found in game state`);
      socket.emit('error', { message: 'Player not found in match' });
      socket.disconnect(true);
      this.removeDisconnectedPlayerCallback(playerId);
      throw new Error(`Player ${playerId} not found in match ${this.id}`);
    }
    player.setDisconnected(false);
    clearTimeout(timeoutId);
    this.timeoutIds.delete(timeoutId);
    this.sockets.push(socket);
    this.socketIdToPlayerId.set(socket.id, playerId);
    this.playerIdToSocketId.set(playerId, socket.id);
    this.removeDisconnectedPlayerCallback(playerId);
    this.setUpPlayerSocketHandlers([socket]);

    logger.info(`Player ${player.getName()} (${playerId}) rejoined match ${this.id}`);
  }

  public getIsReady(): boolean {
    return this.isReady;
  }

  public getId(): string {
    return this.id;
  } 


  public getNumberOfPlayers(): number {
    return this.playerScores.size;
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
    for (const socket of this.sockets) {
      socket.emit('showIsLive');
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
            const playerSocket = this.sockets.find(s => s.id === this.playerIdToSocketId.get(playerId));
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

  public getPlayerIds(): string[] {
    return Array.from(this.playerScores.keys());
  }

  public getShouldRemove(): boolean {
    return this.shouldRemove;   
  }

  public cleanUpSession() {
    
    // Clear all timeout IDs
    for (const id of this.timeoutIds) {
      clearTimeout(id);
    }
    
    // Explicitly clear match reset timeout
    if (this.matchResetTimeout) {
      clearTimeout(this.matchResetTimeout);
      this.matchResetTimeout = null;
    }

    // Remove event listeners from sockets
    for (const socket of this.sockets) {
      socket.removeAllListeners();
    }
    

    
    for (const player of this.worldState.players.values()) {
      player.destroy();
    }

    for (const projectile of this.worldState.projectiles) {
      projectile.destroy();
    }

    // Clear all game state
    this.worldState.players.clear();
    this.worldState.projectiles = [];
    this.timeoutIds.clear();
    this.playerScores.clear();
    this.socketIdToPlayerId.clear();
    this.playerIdToSocketId.clear();
    this.respawnQueue.clear();





    this.setDisconnectedPlayerCallback = () => {};
    this.removeDisconnectedPlayerCallback = () => {};

    logger.info(`Match ${this.id} ended and cleaned up \n\n`);
  }

  // TODO: Would this be faster if we make it promise based and use promise.all?
  private integratePlayerInputs(dt: number) {
    for (const player of this.worldState.players.values()) {
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
          const lastProcessedInputVector = lastProcessedInput?.vector ?? new Vector2(0, 0);
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
          } else if (inputDebtVector.x === inputPayload.vector.x && inputDebtVector.y === inputPayload.vector.y) {
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

  private handlePing(callback: () => void): void {
      callback();
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
  
  private setUpPlayerSocketHandlers(sockets: Socket[]) {
    for (const socket of sockets) {


      socket.removeAllListeners('toggleBystander');
      socket.removeAllListeners('disconnect');
      socket.removeAllListeners('ping');
      socket.removeAllListeners('playerInput');
      socket.removeAllListeners('projectileHit');

      const playerUUID = this.socketIdToPlayerId.get(socket.id);
      if (!playerUUID) {
        logger.error(`Cannot set up socket handlers for socket ${socket.id} - no UUID mapping found`);
        continue;
      }
      // Move shoot handling and toggleBystander to PlayerInput event.
      socket.on('toggleBystander', () => this.handleToggleBystander(playerUUID));
      socket.on('connection_error', (err) => {
        logger.error(`Connection error for player ${playerUUID} in match ${this.id}: ${err.message}`);
      });
      socket.on('connection_timeout', (err) => {
        logger.error(`Connection timeout for player ${playerUUID} in match ${this.id}: ${err.message}`);
      });
      socket.on('reconnect_error', (err) => {
        logger.error(`Reconnect error for player ${playerUUID} in match ${this.id}: ${err.message}`);
      });
      socket.on('disconnect', (reason) => this.handlePlayerDisconnect(socket, playerUUID, reason));
      socket.on('ping', (callback) => this.handlePing(callback));
      socket.on('playerInput', (inputPayload: InputPayload) => this.handlePlayerInputPayload(playerUUID, inputPayload));
      socket.on('projectileHit', (enemyId) => this.handleProjectileHit(playerUUID, enemyId));
    }
  }
// Left off reviewing disconnect changes here. CHeck disconnect-notes.txt
  private handleProjectileHit(playerId: string, enemyId: string): void {
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
    this.handleCollision(playerId, enemy);
  }

  private handlePlayerInputPayload(playerId: string, playerInput: InputPayload): void {
    const player = this.worldState.players.get(playerId);
    if (!player) {
      logger.error(`Player ${playerId} attempted to send input but was not found in match ${this.id}`);
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
    
    const sortedScores = Array.from(this.playerScores.entries())
      .map(([playerId, score]) => ({
        playerId,
        ...score
      }))
      .sort((a, b) => b.kills - a.kills);

    const winner = sortedScores[0];
    
    if (winner && winner.kills >= MAX_KILL_AMOUNT) {
      // Get winner name
      const winnerPlayer = this.worldState.players.get(winner.playerId);
      const winnerName = winnerPlayer ? winnerPlayer.getName() : winner.name;
      
      logger.info(`Match ${this.id} ended. Winner: ${winnerName} (${winner.playerId}) with ${winner.kills} kills`);
      logger.info(`Final scores for match ${this.id}:`);
      
      // Log all player scores
      sortedScores.forEach((score, index) => {
        logger.info(`  ${index + 1}. ${score.name} - Kills: ${score.kills}, Deaths: ${score.deaths}`);
      });

      // Emit game over event with sorted scores
      this.matchIsActive = false;
      
      // Clear any pending respawn timeouts
      for (const id of this.timeoutIds) {
        clearTimeout(id);
      }

      // Respawn any players in the respawn queue

      for (const [playerId, playerName] of this.respawnQueue) {
        const respawningPlayer = new Player(
          playerId,
          playerName,
          this.STARTING_X,
          this.STARTING_Y,
          this.GAME_BOUNDS
        );
        respawningPlayer.setIsBystander(false);
        respawningPlayer.setPlatforms(this.worldState.platforms);
        this.worldState.players.set(playerId, respawningPlayer);
      }

    
      for (const socket of this.sockets) {
        logger.info(`Emitting gameOver event to player socket ${socket.id} in match ${this.id}`);
        socket.emit('gameOver', sortedScores);
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



  // Extract state broadcast into its own method
  public broadcastGameState(): void {
    try {
    
      const projectileState = this.worldState.projectiles.filter((state) => state.shouldBeDestroyed === false)
        .map((projectile) => projectile.getState());

      const playerStates = this.getPlayerStates();
      const gameState = {
        serverTick: this.serverTick,
        players: playerStates,
        projectiles: projectileState,
        scores: Array.from(this.playerScores.entries()).map(([playerId, score]) => ({
          playerId,
          ...score
        }))
      };

      for (const socket of this.sockets) {
        socket.emit('stateUpdate', gameState);
      }

    } catch (error) {
      this.handleError(error as Error, 'broadcastState');
    }
  }


  // Extract fixed update logic into its own method
  private updatePhysics(dt: number): void {
    try {
      // Process player updates with fixed delta
      this.integratePlayerInputs(dt);
  
      // Process projectile updates
      this.worldState.projectiles = this.worldState.projectiles.filter(
        projectile => {
          projectile.update();
          
        // Check expired projectiles
          if (projectile.shouldBeDestroyed) {
            logger.debug(`Projectile ${projectile.getId()} expired`);
            return false;
          }

        
          // Check for collisions only if match is active...
          // This is currently disabled as we dont have 
          // server side collision detection implemented yet.
          if (this.matchIsActive) {
            //this.checkProjectileCollisions(i, projectile, projectilesToRemove);
          }

          return true; // Keep projectile if not expired
          
        });
      // Check win condition
      this.checkWinCondition();

    } catch (error) {
      this.handleError(error as Error, 'fixedUpdate');
    }
  }

    // Extract collision check into its own method
  private checkProjectileCollisions(index: number, projectile: Projectile, projectilesToRemove: number[]): boolean {
    for (const player of this.worldState.players.values()) {
      // Skip collision check if projectile belongs to player or player is bystander
      if (projectile.getOwnerId() === player.getId() || player.getIsBystander()) continue;
      
      const projectileRect = {
        x: projectile.getX() - PROJECTILE_WIDTH / 2,
        y: projectile.getY() - PROJECTILE_HEIGHT / 2,
        width: PROJECTILE_WIDTH,
        height: PROJECTILE_HEIGHT,
      };
      
      const playerRect = {
        x: player.getX() - PLAYER_WIDTH / 2,
        y: player.getY() - PLAYER_HEIGHT,
        width: PLAYER_WIDTH,
        height: PLAYER_HEIGHT,
      };
      
      const collided = testForAABB(projectileRect, playerRect);
      if (collided) {
        projectilesToRemove.push(index);
        //this.handleCollision(projectile, player);
        return true; // Exit after collision
      } 
    }
    return false;
  }




  private handlePlayerDisconnect(socket: Socket, playerId?: string, reason?: string): void {
    // Get the UUID associated with this socket
    const socketId = socket.id;
    if (!playerId) playerId = this.socketIdToPlayerId.get(socketId)
    if (!playerId) {
      logger.warn(`Socket ${socketId} disconnected but no UUID mapping found in match ${this.id}`);
      return;
    }

    const player = this.worldState.players.get(playerId);
    if (!player) {
      logger.warn(`Player UUID ${playerId} disconnected but was not found in match ${this.id}`);
      return;
    }

    const timeout = setTimeout(() => {
      this.removePlayerFromGameState(playerId, socketId)
      this.timeoutIds.delete(timeout);
    }, this.DISCONNECT_GRACE_PERIOD_MS);

    this.timeoutIds.add(timeout);

    this.setDisconnectedPlayerCallback(playerId, this.id, timeout);
    player.setDisconnected(true);

    logger.info(`Player (UUID: ${playerId}) disconnected from match ${this.id}. Reason: ${reason}`);

    // Remove socket from active sockets list but keep player in game state
    // (This is done as reconnecting players will get a new socket ID)
  
    socket.removeAllListeners();
    this.sockets = this.sockets.filter(s => s.id !== socketId);
  }



  private removePlayerFromGameState(playerId: string, socketId: string): void {
      // If the timeout executes, the player did not reconnect in time
      logger.info(`Player (UUID: ${playerId}) did not reconnect within grace period. Removing from match ${this.id}.`);

      // Notify matchmaker first
      this.removeDisconnectedPlayerCallback(playerId);

      const player = this.worldState.players.get(playerId);
      if (!player) {
        logger.warn(`Player UUID ${playerId} not found in match ${this.id} during removal process`);
      }
      player?.destroy();

      this.respawnQueue.delete(playerId);
      

      // Actually remove the player now
      this.worldState.players.delete(playerId);
      this.playerScores.delete(playerId);

      // Clean up from our tracking map
      this.socketIdToPlayerId.delete(socketId);
      this.playerIdToSocketId.delete(playerId);

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
        logger.warn(`Bystander ${player.getName()} (${player.getId()}) attempted to shoot in match ${this.id}`);
        return;
      }      
      logger.debug(`Player ${player.getName()} (${player.getId()}) fired projectile ${id} in match ${this.id}`);
      // TODO: If were not handling collision server side, this should be removed.
      const projectile = new Projectile(id, player.getId(), player.getX(), player.getY() - 50, x, y);
      this.worldState.projectiles.push(projectile);
  }

  private handleCollision(shooterId: string, target: Player): void {
      if (target.getIsBystander()) return; // Prevent damage to bystanders
      target.damage(10);

      if (target.getHp() <= 0) {
        this.handlePlayerDeath(target.getId(), target.getName(), shooterId);
        target.destroy();
      }
      
  }

  private handlePlayerDeath(victimId: string, victimName: string, killerId: string) {
      this.worldState.players.delete(victimId);
      // Update death count for killed player
      const killer = this.worldState.players.get(killerId);
      const killerName = killer ? killer.getName() : "Unknown Player";
  

      const killedPlayerScore = this.playerScores.get(victimId);

      if (killedPlayerScore) {
        killedPlayerScore.deaths++;
        logger.info(`Player ${victimName} (${victimId}) was killed by ${killerName} (${killerId}) in match ${this.id}`);
      } else {
        logger.warn(`Failed to update deaths for player ${victimName} (${victimId}) - score not found`);
      }
      // Update kill count for shooter
      const shooterScore = this.playerScores.get(killerId);
      if (shooterScore) {
        logger.info(`Player ${killerName} (${killerId}) now has ${shooterScore.kills + 1} kills in match ${this.id}`);
        shooterScore.kills++;
        this.checkWinCondition();
      } else {
          logger.error(`Failed to update kills for player ${killerName} (${killerId}) - score not found`);
      }

      this.scheulePlayerRespawn(victimId, victimName);
  }

  private scheulePlayerRespawn(playerId: string, playerName: string): void {
      this.respawnQueue.set(playerId, playerName);
      const id = setTimeout(() => {
        const needsRespawn = this.respawnQueue.has(playerId);
        if (needsRespawn === false) return; // Player is not in respawn queue
        this.respawnQueue.delete(playerId);
        const player = new Player(
          playerId,
          playerName,
          this.STARTING_X, 
          this.STARTING_Y, 
          this.GAME_BOUNDS  
        );
        player.setIsBystander(false)
        player.setPlatforms(this.worldState.platforms);
        this.worldState.players.set(playerId, player);
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
    // Clear all active projectiles
    this.worldState.projectiles.forEach(p => p.destroy());
    this.worldState.projectiles = [];
    
    // Reset player health and scores but maintain positions and bystander status
    for (const [playerId, player] of this.worldState.players.entries()) {
      player.resetHealth();
      // Keep x, y positions and isBystander state
      
      // Reset scores for new round
      this.playerScores.set(playerId, {
        kills: 0,
        deaths: 0,
        name: player.getName()
      });
    }
    logger.info(`Match ${this.id} reset complete with ${this.worldState.players.size} players`);
    // Inform players of match reset
    for (const socket of this.sockets) {
      socket.emit('matchReset', {
        players: this.getPlayerStates(),
        scores: Array.from(this.playerScores.entries())
          .map(([playerId, score]) => ({
            playerId,
            ...score
          }))
      });
    }

    this.matchIsActive = true;

  }

  private handleError(error: Error, context: string): void {
    logger.error(`Error in Match ${this.id} - ${context}: ${error.message}`);
    // Could add additional error handling logic here
  }

  private getPlayerStates(): PlayerState[] {
    const states = [];
    for (const player of this.worldState.players.values()) {
      const state = player.getLatestState();
      if (state) {
        // Add disconnected flag to player state
        const extendedState = {
          ...state,
          isDisconnected: player.getIsDisconnected()
        };
        states.push(extendedState);
      }
    }
    return states;
  }
}
