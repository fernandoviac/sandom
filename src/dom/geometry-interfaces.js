// DOMRectReadOnly and DOMRect (Geometry Interfaces Level 1 §4), the
// rectangle constructors that component code builds its own rectangles
// with. Each coordinate converts as an unrestricted double; left, top,
// right and bottom are the minimum and maximum of x and x + width (y and
// y + height), so a negative width or height still gives left <= right.

const toDouble = (value) => (value === undefined ? 0 : Number(value));

// Writes one field of a rectangle; DOMRectReadOnly's static block sets it,
// as only that class reaches its private fields.
let setField;

export class DOMRectReadOnly {
  #x;
  #y;
  #width;
  #height;

  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.#x = toDouble(x);
    this.#y = toDouble(y);
    this.#width = toDouble(width);
    this.#height = toDouble(height);
  }

  static fromRect(other = {}) {
    return new this(other.x, other.y, other.width, other.height);
  }

  get x() { return this.#x; }
  get y() { return this.#y; }
  get width() { return this.#width; }
  get height() { return this.#height; }
  get top() { return Math.min(this.#y, this.#y + this.#height); }
  get right() { return Math.max(this.#x, this.#x + this.#width); }
  get bottom() { return Math.max(this.#y, this.#y + this.#height); }
  get left() { return Math.min(this.#x, this.#x + this.#width); }

  toJSON() {
    const { x, y, width, height, top, right, bottom, left } = this;
    return { x, y, width, height, top, right, bottom, left };
  }

  static {
    setField = (rect, name, value) => {
      if (name === "x") rect.#x = toDouble(value);
      else if (name === "y") rect.#y = toDouble(value);
      else if (name === "width") rect.#width = toDouble(value);
      else rect.#height = toDouble(value);
    };
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "DOMRectReadOnly", configurable: true });
  }
}

export class DOMRect extends DOMRectReadOnly {
  get x() { return super.x; }
  set x(value) { setField(this, "x", value); }
  get y() { return super.y; }
  set y(value) { setField(this, "y", value); }
  get width() { return super.width; }
  set width(value) { setField(this, "width", value); }
  get height() { return super.height; }
  set height(value) { setField(this, "height", value); }

  static fromRect(other = {}) {
    return new this(other.x, other.y, other.width, other.height);
  }

  static {
    Object.defineProperty(this.prototype, Symbol.toStringTag, { value: "DOMRect", configurable: true });
  }
}
