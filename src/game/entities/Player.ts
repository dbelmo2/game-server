import logger from '../../utils/logger';
import { Platform } from './Platform';
import { InputPayload } from '../../services/Match';
import { Vector2 } from '../systems/Vector';

export interface PlayerState {
  id: string;
  position: Vector2;
  hp: number;
  isBystander: boolean;
  name: string;
  velocity: Vector2;
  isOnGround?: boolean;
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
  private velocity: Vector2 = new Vector2(0, 0);
  private isBystander: boolean = true;
  private name: string;
  private isOnGround: boolean = false;
  private platforms: Platform[] = [];
  private canDoubleJump: boolean = true;
  private inputQueue: InputPayload[] = [];
  private lastProcessedInput: InputPayload | null = null;
  private gameBounds: { left: number; right: number; top: number; bottom: number } | null = null;
  private numTicksWithoutInput: number = 0;

  // Physics constants
  constructor(
    id: string, 
    x: number, 
    y: number, 
    name: string, 
    gameBounds: { left: number; right: number; top: number; bottom: number } | null = null
  ) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.name = name;
    this.gameBounds = gameBounds;
  }


  public queueInput(input: InputPayload): void {
    this.inputQueue.push(input);
  }

  public setPlatforms(platforms: Platform[]): void {
    this.platforms = platforms;
  }
  

  public setLastProcessedInput(inputPayload: InputPayload): void {
    this.lastProcessedInput = inputPayload;
  }
  

  public getLastProcessedInput(): InputPayload | null {
    return this.lastProcessedInput;
  } 

  public getNumTicksWithoutInput(): number {
    return this.numTicksWithoutInput;
  }


  private isJumping = false;
  private indexPostJump = 0

  update(inputVector: Vector2, dt: number) {

      //const wasOnGround = this.isOnGround;
      if (inputVector.x === 0 && inputVector.y === 0) {
          //this.numTicksWithoutInput++;
      } else {
          //this.numTicksWithoutInput = 0; // Reset if we have input
      }

      // 1. First we update our velocity vector based on input and physics.
      // Horizontal Movement
      if (inputVector.x !== 0) {
        //inputVector.normalize();
        this.velocity.x = inputVector.x * this.SPEED;
      } else {
        this.velocity.x = 0;
      }

      // Jumping
      


      //console.log('inputVector.v < 0', inputVector.y < 0)
      //console.log('this.canDoubleJump', this.canDoubleJump);
      if ((inputVector.y < 0 && this.isOnGround) || (inputVector.y < 0 && this.canDoubleJump)) {
        console.log("Jumping");
        this.velocity.y = inputVector.y * this.JUMP_STRENGTH;
        this.canDoubleJump = this.isOnGround;
        this.isOnGround = false;
        this.isJumping = true; // Set jumping state
      }



      // Gravity
      this.velocity.y += this.GRAVITY * dt;
      this.velocity.y = Math.min(this.velocity.y, this.MAX_FALL_SPEED); 


      // 2. Once the velocity is updated, we calculate the new position.
      const newX = this.x + (this.velocity.x * dt);
      const newY = this.y + (this.velocity.y * dt);

      // 3. Now we clamp the position to the game bounds.
      if (this.gameBounds) {
          this.x = Math.max(this.gameBounds.left + 25, Math.min(newX, this.gameBounds.right - 25)); // 50 is the width of the player
          this.y = Math.max(this.gameBounds.top, Math.min(newY, this.gameBounds.bottom)); // 50 is the height of the player
      } else {
          this.x = newX;
          this.y = newY;
      }

      if (this.y === this.gameBounds?.bottom) {
          this.isOnGround = true;
          this.canDoubleJump = true; // Reset double jump when on ground
          this.velocity.y = 0; // Reset vertical velocity when on ground
          this.isJumping = false; // Reset jumping state
          this.indexPostJump = 0; // Reset post-jump index
      }

      if (this.isJumping && inputVector.y === 0 && inputVector.x === 0) {
        this.indexPostJump++;
        console.log(`Player coordinates ${this.indexPostJump} ticks after jump: ${this.x}, ${this.y}`);
      }

                        
      /*
      // Check platform collisions
      for (const platform of this.platforms) {
      const platformBounds = platform.getPlatformBounds();
      const playerBounds = this.getPlayerBounds();
      
      // Calculate the previous position based on velocity
      const prevBottom = playerBounds.bottom - this.velocityY;
      
      // Check for platform collision with tunneling prevention
      const isGoingDown = this.velocityY > 0;
      const wasAbovePlatform = prevBottom <= platformBounds.top;
      const isWithinPlatformWidth = playerBounds.right > platformBounds.left && 
      playerBounds.left < platformBounds.right;
      const hasCollidedWithPlatform = playerBounds.bottom >= platformBounds.top;
      
      // Check if we're falling, were above platform last frame, and are horizontally aligned
      if (isGoingDown && wasAbovePlatform && isWithinPlatformWidth && hasCollidedWithPlatform) {

          this.y = platformBounds.top;
          this.velocityY = 0;
          isOnSurface = true;
          break;
      }
      }

      this.isOnGround = isOnSurface;
      if (isOnSurface && !wasOnGround) {
          this.canDoubleJump = true;
      }
    */
  }

  public setIsBystander(value: boolean): void {
    this.isBystander = value;
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

  public getState(): PlayerState {
    return {
      id: this.id,
      hp: this.hp,
      isBystander: this.isBystander,
      name: this.name,
      velocity: this.velocity,
      position: new Vector2(this.x, this.y),
      isOnGround: this.isOnGround,
    };
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


}