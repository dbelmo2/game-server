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

const MAX_KILL_AMOUNT = 5; // Adjust this value as needed


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
  private readonly TICK_RATE = 60; // 60 ticks per second
  private readonly MIN_MS_BETWEEN_TICKS = 1000 / this.TICK_RATE;
  private readonly MIN_S_BETWEEN_TICKS = this.MIN_MS_BETWEEN_TICKS / 1000; // Convert to seconds
  private readonly BUFFER_SIZE = 1024;
  private readonly GAME_BOUNDS = {
    left: 0,
    right: this.GAME_WIDTH,
    top: 0,
    bottom: this.GAME_HEIGHT
  };

  private worldState: WorldState = {
    players: new Map(),
    projectiles: [],
    platforms: [],
  }

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
    socket: Socket,
    region: Region,
    id = `match-${Math.random().toString(36).substring(2, 8)}`,
    public matches: Map<string, Match> = new Map(),
    firstPlayerName: string = 'Player 1'
  ) {
    this.id = id;
    this.sockets = [socket];
    this.region = region;
    this.initializePlatforms()
    this.initalizeFirstPlayer(socket, firstPlayerName);
    this.setUpPlayerSocketHandlers(this.sockets);
    this.isReady = true;
    this.matchIsActive = true;

    logger.info(`Match ${this.id} created in region ${region} with first player ${firstPlayerName}`);
    // Start game loop loop (this will broadcast the game state to all players)
  }

  public addPlayer(socket: Socket, name: string): void {
    this.sockets.push(socket);
    const serverPlayer = new Player(
      socket.id, 
      this.STARTING_X, 
      this.STARTING_Y, 
      name, 
      this.GAME_BOUNDS
    );
    serverPlayer.setPlatforms(this.worldState.platforms);
    // Initialize new player as bystander
    this.worldState.players.set(socket.id, serverPlayer);

    this.playerScores.set(socket.id, {
      kills: 0,
      deaths: 0,
      name
    });

    this.setUpPlayerSocketHandlers([socket]);
    logger.info(`Player ${name} (${socket.id}) joined match ${this.id} in region ${this.region}`);
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
        this.accumulator -= this.MIN_MS_BETWEEN_TICKS;
        this.serverTick++;
      }
    } catch (error) {
      this.handleError(error as Error, 'gameLoop');
    }
  }


  public getShouldRemove(): boolean {
    return this.shouldRemove;   
  }

  public cleanUpSession() {
    this.matches.delete(this.id);
    for (const id of this.timeoutIds) {
      clearTimeout(id);
    }
    for (const socket of this.sockets) {
      socket.removeAllListeners('playerInput');
      socket.removeAllListeners('shoot');
      // We dont want to disconnect the socket here, just remove listeners for this match.
    }
        // Clear all game state
    this.worldState.players.clear();
    this.worldState.projectiles = [];
    this.timeoutIds.clear();
    this.playerScores.clear();
    
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
          // TODO: Fix scenario where last input was a jump command and is reused here..
          // Instead, in this scenario, we should use an input of 0,0.
          // Additionally, we need to check here if the player is standing still on the ground...
          // In this scenario, despite using a last input of 0,0, we should NOT apply input debt.
          numIntegrations = max; // No more inputs to process
          const lastProcessedInput = player.getLastProcessedInput();
          const lastProcessedInputVector = lastProcessedInput?.vector ?? new Vector2(0, 0);
           // Reset y to 0 to avoid predicted double jump issues.
           // This does not cause issues as there is no realistic scenario where a player intends to
           // send two jump inputs in a row. Therefore we know we will never need to predict this scenario.
          lastProcessedInputVector.y = 0;

          // We only add input debt if the player is not AFK.
          if (player.isAfk(lastProcessedInputVector) === false) {
            player.addInputDebt(lastProcessedInputVector);
          }
          const newTick = lastProcessedInput?.tick ? lastProcessedInput.tick + 1 : 0;
          player.update(lastProcessedInputVector, dt, newTick, 'A');
          player.setLastProcessedInput({ tick: newTick || 0, vector: lastProcessedInputVector });
          console.log(`no input payload scenario: Updated last processed input with tick: ${newTick} and vector: x=${lastProcessedInputVector.x}, y=${lastProcessedInputVector.y}`);
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
            console.log('Clearing the input debt for player', player.getId());
            console.log(`Input debt vector: ${inputDebtVector.x}, ${inputDebtVector.y}`);
            console.log(`New input vector: ${inputPayload.vector.x}, ${inputPayload.vector.y}`);
            // TODO: Is this scenario clearing valuable data that causes desync?
            player.clearInputDebt();
            player.update(inputPayload.vector, dt, inputPayload.tick, 'C');
          }
        }

        
  
        if (inputPayload && skipped === false) {
          player.setLastProcessedInput(inputPayload);
          console.log(`Yes input payload scenario: Updated last processed input with tick: ${inputPayload.tick} and vector: x=${inputPayload.vector.x}, y=${inputPayload.vector.y}`);
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

  private initalizeFirstPlayer(socket: Socket, name: string) {
    // Setup player state
    const controller = new Controller();
    const newPlayer = new Player(
      socket.id, 
      this.STARTING_X, 
      this.STARTING_Y, 
      name, 
      this.GAME_BOUNDS
    );
    newPlayer.setPlatforms(this.worldState.platforms);
    this.worldState.players.set(socket.id, newPlayer);

    // Initialize player scores
    this.playerScores.set(socket.id, {
      kills: 0,
      deaths: 0,
      name
    });
  }

  private initializePlatforms(): void {
    // Initialize platforms here
    this.worldState.platforms = [
          new Platform(250, this.GAME_HEIGHT - 250),
          new Platform(this.GAME_WIDTH - 850, this.GAME_HEIGHT - 250),
          new Platform(250, this.GAME_HEIGHT - 500),
          new Platform(this.GAME_WIDTH - 850, this.GAME_HEIGHT - 500)

    ];
  }
  private setUpPlayerSocketHandlers(sockets: Socket[]) {
    for (const socket of sockets) {
      // Move shoot handling and toggleBystander to PlayerInput event.
      socket.on('shoot', ({ x, y, id }) => this.handlePlayerShooting(socket.id, id, x, y));
      socket.on('toggleBystander', () => this.handleToggleBystander(socket.id));
      socket.on('disconnect', () => this.handlePlayerDisconnect(socket.id));
      socket.on('ping', (callback) => this.handlePing(callback));
      socket.on('playerInput', (inputPayloads: InputPayload[]) => this.handlePlayerInputPayload(socket.id, inputPayloads));
    }
  }

  private handlePlayerInputPayload(playerId: string, playerInputs: InputPayload[]): void {
    const player = this.worldState.players.get(playerId);
    if (!player) {
      logger.error(`Player ${playerId} attempted to send input but was not found in match ${this.id}`);
      return;
    }

    console.log(`Received ${playerInputs.length} inputs for player ${playerId} in match ${this.id}`);
    console.log(playerInputs);

    for (const playerInput of playerInputs) {
        console.log(playerInput);
        console.log(`Queuing input for player ${playerId} with tick: ${playerInput.tick} and vector: x=${playerInput.vector.x}, y=${playerInput.vector.y}`);
        player.queueInput(playerInput);
    }

  }

  private checkWinCondition() {
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
          this.STARTING_X, 
          this.STARTING_Y, 
          playerName, 
          this.GAME_BOUNDS
        );
        respawningPlayer.setIsBystander(false);
        respawningPlayer.setPlatforms(this.worldState.platforms);
        this.worldState.players.set(playerId, respawningPlayer);
      }

  
      for (const socket of this.sockets) {
        socket.emit('gameOver', sortedScores);
      }



      this.respawnQueue.clear();
      this.timeoutIds.clear();

      // Reset match.
      setTimeout(() => this.resetMatch(), 10000); // Wait 5 seconds before resetting

    }
  }



  // Extract state broadcast into its own method
  public broadcastGameState(): void {
    try {
    
      const projectileState = this.worldState.projectiles.filter((state) => state.shouldBeDestroyed === false)
        .map((projectile) => projectile.getState());

      const playerStates = this.getPlayerStates();
      const firstPlayer = this.getPlayerStates()[0];
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
      const projectilesToRemove: number[] = [];
      for (let i = 0; i < this.worldState.projectiles.length; i++) {
        const projectile = this.worldState.projectiles[i];
        projectile.update();
        
        // Check expired projectiles
        if (projectile.shouldBeDestroyed) {
          console.log(`Projectile ${projectile.getId()} expired`);
          projectilesToRemove.push(i);
          continue;
        }
        
        // Check for collisions only if match is active
        if (this.matchIsActive) {
          this.checkProjectileCollisions(i, projectile, projectilesToRemove);
        }
      }

      // Remove projectiles after processing
      for (let i = projectilesToRemove.length - 1; i >= 0; i--) {
        this.worldState.projectiles.splice(projectilesToRemove[i], 1);
      }
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
        this.handleCollision(projectile, player);
        return true; // Exit after collision
      } 
    }
    return false;
  }

  private handlePlayerDisconnect(playerId: string): void {
    const player = this.worldState.players.get(playerId);
    const playerName = player ? player.getName() : "Unknown Player";
  
    this.worldState.players.delete(playerId);
    this.playerScores.delete(playerId);
    this.sockets = this.sockets.filter(s => s.id !== playerId);

    logger.info(`Player ${playerName} (${playerId}) disconnected from match ${this.id}`);
    logger.info(`Match ${this.id} now has ${this.worldState.players.size} players`);
  

    if (this.sockets.length === 0) {
      logger.info(`All players left match ${this.id}. Cleaning up.`);
      this.shouldRemove = true;
    }  
  }

  
  private handlePlayerShooting(
    playerId: string, 
    projectileId: string,
    x: number,
    y: number,
  ): void {
      const p = this.worldState.players.get(playerId);
      if (!p || p.getIsBystander()) {
        if (!p) {
          logger.error(`Player ${playerId} attempted to shoot but was not found in match ${this.id}`);
        } else if (p.getIsBystander()) {
          logger.warn(`Bystander ${p.getName()} (${playerId}) attempted to shoot in match ${this.id}`);
        }
        return;
      }      
      logger.debug(`Player ${p.getName()} (${playerId}) fired projectile ${projectileId} in match ${this.id}`);
      const projectile = new Projectile(p.getX(), p.getY(), x, y, 30, 5000, 0.05, projectileId, p.getId());
      console.log(`Projectile created with ID: ${projectile.getId()}`);
      this.worldState.projectiles.push(projectile);
  }

  private handleCollision(projectile: Projectile, player: Player): void {
      if (player.getIsBystander()) return; // Prevent damage to bystanders
      player.damage(10);

      if (player.getHp() <= 0) {
        this.handlePlayerDeath(player.getId(), player.getName(), projectile.getOwnerId());
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
        logger.error(`Failed to update deaths for player ${victimName} (${victimId}) - score not found`);
      }
      // Update kill count for shooter
      const shooterScore = this.playerScores.get(killerId);
      if (shooterScore) {
        logger.info(`Player ${killerName} (${killerId}) now has ${shooterScore.kills} kills in match ${this.id}`);
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
          this.STARTING_X, 
          this.STARTING_Y, 
          playerName,
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

    // Clear all active projectiles
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
        logger.info(`Match ${this.id} reset complete with ${this.worldState.players.size} players`);

    }
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
        states.push(state);
      }
    }
    return states;
  }
}
