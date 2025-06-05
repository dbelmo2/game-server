export const PROJECTILE_WIDTH = 10;
export const PROJECTILE_HEIGHT = 10;
export const PLAYER_WIDTH = 50;
export const PLAYER_HEIGHT = 50;

export const testForAABB = (
    obj1: { x: number; y: number; width: number; height: number },
    obj2: { x: number; y: number; width: number; height: number }
  ): boolean => {
    return (
      obj1.x < obj2.x + obj2.width &&
      obj1.x + obj1.width > obj2.x &&
      obj1.y < obj2.y + obj2.height &&
      obj1.y + obj1.height > obj2.y
    );
}
  