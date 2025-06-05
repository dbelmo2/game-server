export class Vector2 {


  public x: number;
  public y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }



  // ---------- mutating instance methods ----------
  add(v: Vector2): this      { this.x += v.x; this.y += v.y; return this; }
  subtract(v: Vector2): this { this.x -= v.x; this.y -= v.y; return this; }
  scale(s: number): this     { this.x *= s;   this.y *= s;   return this; }

  lenSq(): number { return this.x * this.x + this.y * this.y; }
  len():   number { return Math.sqrt(this.lenSq()); }

  normalize(): this {
    const l = this.len();
    if (l > 1e-8) { this.x /= l; this.y /= l; }
    return this;
  }

  // ---------- non‑mutating helpers ----------
  static add(a: Vector2, b: Vector2): Vector2       { return a.clone().add(b); }
  static subtract(a: Vector2, b: Vector2): Vector2  { return a.clone().subtract(b); }
  static dot(a: Vector2, b: Vector2): number        { return a.x * b.x + a.y * b.y; }

  clone(): Vector2      { return new Vector2(this.x, this.y); }
  equals(v: Vector2): boolean { return this.x === v.x && this.y === v.y; }
}
