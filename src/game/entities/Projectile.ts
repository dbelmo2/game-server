

export type ProjectileStateUpdate = {
  id: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  ownerId?: string;
  dud?: boolean;
};
export class Projectile  {
  public static speed: number = 30;
  protected vx: number = 0;
  protected vy: number = 0;
  public shouldBeDestroyed = false;

  static calculateVelocity(spawnX: number, spawnY: number, targetX: number, targetY: number): { vx: number; vy: number } {
    const dx = targetX - spawnX;
    const dy = targetY - spawnY;

    const mag = Math.sqrt(dx * dx + dy * dy);
    const dirX = dx / mag;
    const dirY = dy / mag;
    const vx = dirX * Projectile.speed;
    const vy = dirY * Projectile.speed;

    return { vx, vy };
  }

  private constructor() {}
}

  