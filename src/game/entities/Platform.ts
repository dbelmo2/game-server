export class Platform {
  public readonly x: number;
  public readonly y: number;
  public readonly width: number;
  public readonly height: number;

  constructor(x: number, y: number, width: number = 500, height: number = 30) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}