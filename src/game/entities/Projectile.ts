

export type ProjectileState = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
};
export class Projectile  {
  protected speed: number;
  protected lifespan: number;
  protected vx: number = 0;
  protected vy: number = 0;
  private x: number;
  private y: number;
  private id: string;
  private ownerId: string;
  protected gravityEffect: number;
  public shouldBeDestroyed = false;

  protected calculateVelocity(spawnX: number, spawnY: number, targetX: number, targetY: number): void {
    const dx = targetX - spawnX;
    const dy = targetY - spawnY;

    const mag = Math.sqrt(dx * dx + dy * dy);
    const dirX = dx / mag;
    const dirY = dy / mag;
    this.vx = dirX * this.speed;
    this.vy = dirY * this.speed;
  }

  // TODO: update collision logic for tomatos? Or verify that the desync in collisions is due to this. 
  // Current slight y desync is caused by y value being different on client and server for the player. server has 1030 when on ground,
  // client has 1145.

  constructor(
    id: string,
    ownerId: string,
    spawnX: number, 
    spawnY: number, 
    targetX: number, 
    targetY: number,
    speed = 30, 
    lifespan = 1750, 
    gravityEffect = 0.05, 
  ) {
    // initialize 
    this.x = spawnX;
    this.y = spawnY;
    this.speed = speed;
    this.lifespan = lifespan;
    this.gravityEffect = gravityEffect;
    this.id = id;
    this.ownerId = ownerId;

    // Calculate direction vector
    this.calculateVelocity(spawnX, spawnY, targetX, targetY);
    

    // Begin the age process (we dont want projetiles sticking around forever)
    this.age();
  }

  update() {
    this.vy += this.gravityEffect;
    this.x += this.vx;
    this.y += this.vy;
  }

  destroy() {
    // Call the superclass destroy method
  }

  age() {
    setTimeout(() => {
        this.shouldBeDestroyed = true;
    }, this.lifespan)
  }

  public getId(): string {
      return this.id;
  }

  public getOwnerId(): string {
      return this.ownerId;
  }

  public getX(): number {
      return this.x;
  }

  public getY(): number {
      return this.y;
  }

  public getVX(): number {
      return this.vx;
  }

  public getVY(): number {
      return this.vy;
  }

  public getState(): ProjectileState {
      return {
        ownerId: this.ownerId,
        id: this.id,
        x: this.x,
        y: this.y,
        vx: this.vx,
        vy: this.vy
    };
  }

}
