import logger from '../../utils/logger';
import { Platform } from './Platform';
import { InputPayload } from '../../services/Match';
import { InputVector, PositionVector } from '../systems/Vector';
export interface PlayerState {
  id: string;
  position: PositionVector;
  hp: number;
  isBystander: boolean;
  name: string;
  velocity: PositionVector;
  isOnGround?: boolean;
  tick: number; 
  isDisconnected: boolean;
  isDead: boolean;
  kills: number;
  deaths: number;
}

export interface PlayerStateBroadcast {
    id: string,
    x: number,
    y: number,
    hp?: number,
    by?: boolean,
    name?: string,
    vx: number,
    tick: number,
    vy: number,
    isDead?: boolean,
    kills?: number,
    deaths?: number,
}

export interface PlayerStateBroadcastUpdate {
  id: string;
  tick: number; 
  position?: PositionVector;
  hp?: number;
  isBystander?: boolean;
  name?: string;
  velocity?: PositionVector;
  [key: string]: any;
}

export class Player {
  public readonly SPEED = 750;
  public readonly JUMP_STRENGTH = 750;
  public readonly GRAVITY = 1500;
  public readonly MAX_FALL_SPEED = 1500;
  private id: string;
  private hp: number = 100;
  private x: number;
  private y: number;
  private velocity: PositionVector = { x: 0, y: 0 };
  private isBystander: boolean = true;
  private name: string;
  private isOnGround: boolean = false;
  private isOnSurface: boolean = false; // Used for platform collision detection
  private platforms: Platform[] = [];
  private canDoubleJump: boolean = true;
  private inputQueue: InputPayload[] = [];
  private lastProcessedInput: InputPayload | null = null;
  private gameBounds: { left: number; right: number; top: number; bottom: number } | null = null;
  private numTicksWithoutInput: number = 0;
  private InputDebt: InputVector[] = [];
  private lastKnownState: PlayerState | null = null;
  private lastBroadcastState: PlayerState | null = null;
  private isShooting = false; // Track if the player is shooting
  private lastInputTimestamp: number = Date.now(); // Timestamp of the last input
  public afkRemoveTimer: NodeJS.Timeout | undefined; // Timer for AFK removal
  private isDisconnected: boolean = false; // Track if player is temporarily disconnected
  private isDead: boolean = false; // Track if player is dead
  private kills: number = 0; // Track player's kill count
  private deaths: number = 0; // Track player's death count
  

  // Physics constants
  constructor(
    id: string,
    name: string,
    x: number, 
    y: number, 
    gameBounds: { left: number; right: number; top: number; bottom: number } | null = null
  ) {
    this.id = id;
    this.name = name;
    this.x = x;
    this.y = y;
    this.gameBounds = gameBounds;
  }


  public queueInput(input: InputPayload): void {
    this.inputQueue.push(input);
    this.lastInputTimestamp = Date.now();
  }

  public setPlatforms(platforms: Platform[]): void {
    this.platforms = platforms;
  }
  

  public setLastProcessedInput(inputPayload: InputPayload): void {
    this.lastProcessedInput = inputPayload;
  }
  
  public getLastInputTimestamp(): number {
    return this.lastInputTimestamp;
  }

  public getLastProcessedInput(): InputPayload | null {
    return this.lastProcessedInput;
  } 

  public getNumTicksWithoutInput(): number {
    return this.numTicksWithoutInput;
  }

  public setIsDead(dead: boolean): void {
    this.isDead = dead;
  }

  public getIsDead(): boolean {
    return this.isDead;
  }

  public addKill(): void {
    this.kills++;
  }

  public addDeath(): void {
    this.deaths++;
    this.setIsDead(true);
    this.inputQueue = []; // Clear input queue on death
    this.clearInputDebt();
  }

  public resetScore(): void {
    this.kills = 0;
    this.deaths = 0;
  }

  public getKills(): number {
    return this.kills;
  }

  public getDeaths(): number {
    return this.deaths;
  }


  private isJumping = false;
  private indexPostJump = 0

  update(inputVector: InputVector, dt: number, localTick: number, scenario: string): void {
      //console.log(`player position: ${this.x}, ${this.y}`);
      // 1. First we update our velocity vector based on input and physics.
      // Horizontal Movement
      if (inputVector.x !== 0) {
        //inputVector.normalize();
        this.velocity.x = inputVector.x * this.SPEED;
      } else {
        this.velocity.x = 0;
      }


      // Shooting
      if (inputVector.mouse) {
        // Handle shooting logic here, if applicable
        this.isShooting = true;
        logger.debug(`Player ${this.name} is shooting at mouse coordinates: ${JSON.stringify(inputVector.mouse)}. Local tick: ${localTick}`);
      }

      if (inputVector.y < 0) {
          this.jump(inputVector);
      }

      // Gravity
      this.applyGravity(dt);

      // 2. Once the velocity is updated, we calculate the new position.
      const newX = this.x + (this.velocity.x * dt);
      const newY = this.y + (this.velocity.y * dt);

      // 3. Now we clamp the position to the game bounds.
      const { clampedX, clampedY } = this.getClampedPosition(newX, newY);

      this.x = clampedX;
      this.y = clampedY;

      if (this.y === this.gameBounds?.bottom) {
          this.isOnGround = true;
          this.resetJumpState();
      } else {
          this.isOnGround = false; 
        }

      if (this.isJumping && inputVector.y === 0) {
        this.indexPostJump++;
        logger.debug(`${scenario}: Player coordinates ${this.indexPostJump} ticks after jump: ${this.x}, ${this.y}. Vy=${this.velocity.y}. localTick: ${localTick}`);
      }

      // Check platform collisions
      const { isOnPlatform, platformTop } = this.checkPlatformCollisions();            
      if (isOnPlatform && platformTop !== null) {
          this.y = platformTop;
          this.resetJumpState();
          
      }


      this.isOnSurface = isOnPlatform || this.isOnGround; // Update surface state based on platform collision


      this.updateLatestState(localTick);
  }

  private resetJumpState(): void {
      this.canDoubleJump = true;
      this.velocity.y = 0;
      this.isJumping = false;
      this.indexPostJump = 0;
      this.isOnSurface = true;
  }



  private applyGravity(dt: number): void {
      this.velocity.y += this.GRAVITY * dt;
      this.velocity.y = Math.min(this.velocity.y, this.MAX_FALL_SPEED); 
  }

  private jump(inputVector: InputVector): void {
    if (this.isOnSurface) {
        // First jump from ground/platform
        this.velocity.y = inputVector.y * this.JUMP_STRENGTH;
        this.canDoubleJump = true; // Enable double jump
        this.isOnSurface = false;
        this.isJumping = true;
    } else if (this.canDoubleJump) {
        // Double jump in air
        this.velocity.y = inputVector.y * this.JUMP_STRENGTH;
        this.canDoubleJump = false; // Disable further jumping
    }
  }

  private getClampedPosition(newX: number, newY: number): { clampedX: number; clampedY: number } {
      if (this.gameBounds) {
        return {
          clampedX: Math.max(this.gameBounds.left + 25, Math.min(newX, this.gameBounds.right - 25)), // 50 is the width of the player
          clampedY: Math.max(this.gameBounds.top, Math.min(newY, this.gameBounds.bottom)) // 50 is the height of the player
        }
      } else {
        return {
          clampedX: newX,
          clampedY: newY
        };
      }
  }

  public checkPlatformCollisions(): { isOnPlatform: boolean; platformTop: number | null } {
      for (const platform of this.platforms) {
        const platformBounds = platform.getPlatformBounds();
        const playerBounds = this.getPlayerBounds();
        
        // Check for platform collision with tunneling prevention
        const isGoingDown = this.velocity.y > 0;
        const isOnPlatform = playerBounds.bottom === platformBounds.top;
        const isFallingThroughPlatform = playerBounds.bottom > platformBounds.top && 
          playerBounds.bottom < platformBounds.bottom;

        const isWithinPlatformWidth = playerBounds.right > platformBounds.left && 
          playerBounds.left < platformBounds.right;
        

        //console.log(`Player bottom ${playerBounds.bottom} Platform top ${platformBounds.top}, Velocity Y ${this.velocity.y}`);
        // Check if we're falling, were above platform last frame, and are horizontally aligned
          
        // Check if we're falling, were above platform last frame, and are horizontally aligned
        if (isGoingDown && isWithinPlatformWidth && (isOnPlatform || isFallingThroughPlatform)) {
            return { isOnPlatform: true, platformTop: platformBounds.top };
        }
      }
      
      return { isOnPlatform: false, platformTop: null };  
  }

  public setIsBystander(value: boolean): void {
    this.isBystander = value;
  }


  public addInputDebt(inputVector: InputVector): void {
    this.InputDebt.push(inputVector);
  } 

  public peekInputDebt(): InputVector | undefined {
    if (this.InputDebt.length === 0) {
      return undefined;
    }
    return this.InputDebt[this.InputDebt.length - 1];
  };

  public clearInputDebt(): void {
    this.InputDebt = [];
  }

  public popInputDebt(): InputVector | undefined {
    if (this.InputDebt.length === 0) {
      return undefined;
    }
    return this.InputDebt.pop();
  }


  public getIsBystander(): boolean {
    return this.isBystander;
  }
    
  public damage(amount: number = 10): void {
    this.hp = Math.max(0, this.hp - amount);
  }
  
  public heal(amount: number): void {
    this.hp = Math.min(100, this.hp + amount);
  }
  
  public resetHealth(): void {
    this.hp = 100;
  }

  public respawn(x: number, y: number): void {
    this.setIsDead(false);
    this.resetHealth();
    this.x = x;
    this.y = y;
    this.velocity = { x: 0, y: 0 };
    this.isOnGround = false;
    this.canDoubleJump = true;
  }


  public getFullBroadcastState(): PlayerStateBroadcast {
    const broadcastState: PlayerStateBroadcast = {
      id: this.id,
      x: this.x,
      y: this.y,
      vx: this.velocity.x,
      vy: this.velocity.y,
      tick: this.lastProcessedInput?.tick || 0,
      hp: this.hp,
      by: this.isBystander,
      name: this.name,
      isDead: this.isDead,
      kills: this.kills,
      deaths: this.deaths
    };
    return broadcastState;
  }

  public getPlayerBounds(): { top: number; bottom: number; left: number; right: number; width: number; height: number } {
    const width = 50;
    const height = 50;
    
    // Since pivot is at bottom middle (25, 50), we calculate bounds accordingly
    const left = this.x - 25; // pivot x (this.x) minus half width
    const right = this.x + 25; // pivot x (this.x) plus half width
    const bottom = this.y; // pivot y (this.y) is at the bottom
    const top = this.y - height; // top is bottom minus height
    
    return {
      top,
      bottom,
      left,
      right,
      width,
      height
    };
  }
  
  public getId(): string {
    return this.id;
  }
  public getX(): number {
    return this.x;
  }
  public getY(): number {
    return this.y;
  }
  public getHp(): number {
    return this.hp;
  }

  public getName(): string {
    return this.name;
  }


  public isAfk(vector: InputVector): boolean {
    if (vector.x === 0 && vector.y === 0 && this.isOnSurface) {
      return true;
    }
    return false;
  }

  public updateTimeSinceLastInput(): void {
    this.numTicksWithoutInput = 0;
    if (this.inputQueue.length === 0) {
      this.numTicksWithoutInput++;
    }
    logger.debug(`Player ${this.name} has ${this.numTicksWithoutInput} ticks without input. Local tick: ${this.lastKnownState?.tick}`);
  }

  public updateLatestState(latestProcessedTick: number): void {
    this.lastKnownState = {
      id: this.id,
      hp: this.hp,
      name: this.name,
      isBystander: this.isBystander,
      velocity: this.velocity,
      position: { x: this.x, y: this.y },
      isOnGround: this.isOnGround,
      tick: latestProcessedTick,
      isDisconnected: this.getIsDisconnected(),
      isDead: this.isDead,
      kills: this.kills,
      deaths: this.deaths
    }
  }

  public getLatestState(): PlayerState {
    const state: PlayerState = {
      id: this.id,
      position: { x: this.x, y: this.y },
      hp: this.hp,
      isBystander: this.isBystander,
      name: this.name,
      velocity: { x: this.velocity.x, y: this.velocity.y },
      isOnGround: this.isOnGround,
      tick: this.lastProcessedInput?.tick || 0,
      isDisconnected: this.isDisconnected,
      isDead: this.isDead,
      kills: this.kills,
      deaths: this.deaths
    };
    
    this.lastKnownState = { ...state };
    return state;
  }

  public getLatestStateDelta(): PlayerStateBroadcast {
    const currentState = this.getLatestState();
    
    // Always include position, velocity, id, and tick
    const delta: PlayerStateBroadcast = {
      id: this.id,
      x: currentState.position.x,
      y: currentState.position.y,
      vx: currentState.velocity.x,
      vy: currentState.velocity.y,
      tick: currentState.tick
    };

    // Only include changed fields (or if no previous broadcast state exists)
    if (!this.lastBroadcastState || this.lastBroadcastState.hp !== currentState.hp) {
      delta.hp = currentState.hp;
    }
    if (!this.lastBroadcastState || this.lastBroadcastState.isBystander !== currentState.isBystander) {
      delta.by = currentState.isBystander;
    }
    if (!this.lastBroadcastState || this.lastBroadcastState.name !== currentState.name) {
      delta.name = currentState.name;
    }
    if (!this.lastBroadcastState || this.lastBroadcastState.isDead !== currentState.isDead) {
      delta.isDead = currentState.isDead;
    }
    if (!this.lastBroadcastState || this.lastBroadcastState.kills !== currentState.kills) {
      delta.kills = currentState.kills;
    }
    if (!this.lastBroadcastState || this.lastBroadcastState.deaths !== currentState.deaths) {
      delta.deaths = currentState.deaths;
    }

    // Update last broadcast state
    this.lastBroadcastState = { ...currentState };
    
    return delta;
  }


  public getInputQueueLength(): number {
    return this.inputQueue.length;
  }

  public dequeueInput(): InputPayload | undefined {
    if (this.inputQueue.length === 0) {
      return undefined;
    }
    const input = this.inputQueue.shift();
    return input;
  } 

  public resetShooting(): void {
    this.isShooting = false;
    logger.debug(`Player ${this.name} has reset shooting state. Local tick: ${this.lastKnownState?.tick}`);
  }

  public isShootingActive(): boolean {
    return this.isShooting;
  }

  public getIsDisconnected(): boolean {
    return this.isDisconnected;
  }

  public setDisconnected(value: boolean): void {
    this.isDisconnected = value;
  }

  public destroy(): void {
    // Clean up resources, listeners, etc.
    if (this.afkRemoveTimer) {
      clearTimeout(this.afkRemoveTimer);
    } 
    this.inputQueue = [];
    this.InputDebt = [];
    logger.info(`Destroyed player ${this.name} (UUID: ${this.id}) and cleaned up resources.`);
  }
}