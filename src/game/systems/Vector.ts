export interface PositionVector {
  x: number;
  y: number;
}

export interface InputVector {
  x: number;
  y: number;
  mouse?: { x: number; y: number; id: string };
}

export class Vector2 {

  private constructor() {}
  // ---------- Static utility methods for plain objects ----------
  static addPositions(a: PositionVector, b: PositionVector): PositionVector {
    return { x: a.x + b.x, y: a.y + b.y };
  }

  static subtractPositions(a: PositionVector, b: PositionVector): PositionVector {
    return { x: a.x - b.x, y: a.y - b.y };
  }

  static scalePosition(pos: PositionVector, scale: number): PositionVector {
    return { x: pos.x * scale, y: pos.y * scale };
  }

  static dot(a: PositionVector, b: PositionVector): number {
    return a.x * b.x + a.y * b.y;
  }

  static lenSq(x: number, y: number): number {
    return x * x + y * y;
  }

  static len(x: number, y: number): number {
    return Math.sqrt(Vector2.lenSq(x, y));
  }

  static normalize(pos: PositionVector): PositionVector {
    const length = Vector2.len(pos.x, pos.y);
    if (length > 1e-8) {
      return { x: pos.x / length, y: pos.y / length };
    }
    return { x: 0, y: 0 };
  }

  static equals(a: PositionVector, b: PositionVector): boolean {
    return a.x === b.x && a.y === b.y;
  }



}