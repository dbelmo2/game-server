export const PROJECTILE_WIDTH = 20;
export const PROJECTILE_HEIGHT = 20;
export const PLAYER_WIDTH = 50;
export const PLAYER_HEIGHT = 50;

export const testForAABB = (
    obj1: { x: number; y: number; width: number; height: number },
    obj2: { x: number; y: number; width: number; height: number }
  ): boolean => {
    console.log(`Projectile bounds: ${obj1.x}, ${obj1.y}, ${obj1.width}, ${obj1.height}, player bounds: ${obj2.x}, ${obj2.y}, ${obj2.width}, ${obj2.height}`);
    return (
      obj1.x < obj2.x + obj2.width &&
      obj1.x + obj1.width > obj2.x &&
      obj1.y < obj2.y + obj2.height &&
      obj1.y + obj1.height > obj2.y
    );
}
  