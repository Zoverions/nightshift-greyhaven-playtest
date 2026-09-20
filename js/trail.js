// trail.js — the breadcrumb path the cat is committed to.
//
// The cursor draws a dotted trail; a walker travels along it at chase speed
// and the simulation steers the cat at the walker, so the cat can never cut
// corners or teleport to the cursor. Once drawn, the path must be run.
//
// Pure logic, no DOM: unit-tested in test/trail.test.mjs.

export const TRAIL_SPACING = 60;     // minimum distance between breadcrumbs
export const TRAIL_WALK_SPEED = 150; // walker advance per tick along the path
export const TRAIL_MAX_POINTS = 512; // cap for pathological scribbling

export class Trail {
  constructor() {
    this.reset(0, -3500);
  }

  reset(x, y) {
    this.pts = [{ x, y }]; // breadcrumbs, oldest first
    this.wx = x; this.wy = y; // walker position (what the cat chases)
    this.seg = 0;             // walker heads from pts[seg] toward pts[seg+1]
    this.cx = x; this.cy = y; // latest cursor position (path end)
  }

  get x() { return this.wx; }
  get y() { return this.wy; }

  // True while the walker still has path to run.
  get pending() {
    return this.seg < this.pts.length - 1 ||
      Math.hypot(this.cx - this.wx, this.cy - this.wy) > 0.5;
  }

  // Record a cursor position, resampled to TRAIL_SPACING.
  push(x, y) {
    this.cx = x; this.cy = y;
    const last = this.pts[this.pts.length - 1];
    const dx = x - last.x, dy = y - last.y;
    if (dx * dx + dy * dy < TRAIL_SPACING * TRAIL_SPACING) return;
    this.pts.push({ x, y });
    this._compact();
  }

  _compact() {
    // Drop consumed points behind the walker to bound memory.
    if (this.seg > 32) {
      this.pts.splice(0, this.seg);
      this.seg = 0;
    }
    // Pathological cap: forget the oldest unconsumed stretch.
    if (this.pts.length > TRAIL_MAX_POINTS) {
      const drop = this.pts.length - TRAIL_MAX_POINTS;
      this.pts.splice(0, drop);
      this.seg = Math.max(0, this.seg - drop);
    }
  }

  // Advance the walker up to maxDist along the path, then close the final
  // gap to the live cursor. Returns the walker position {x, y}.
  advance(maxDist = TRAIL_WALK_SPEED) {
    let remaining = maxDist;
    while (remaining > 0 && this.seg < this.pts.length - 1) {
      const t = this.pts[this.seg + 1];
      const dx = t.x - this.wx, dy = t.y - this.wy;
      const d = Math.hypot(dx, dy);
      if (d <= remaining) {
        this.wx = t.x; this.wy = t.y;
        remaining -= d;
        this.seg++;
      } else {
        this.wx += (dx / d) * remaining;
        this.wy += (dy / d) * remaining;
        remaining = 0;
      }
    }
    const dx = this.cx - this.wx, dy = this.cy - this.wy;
    const d = Math.hypot(dx, dy);
    if (d > 0 && remaining > 0) {
      const step = Math.min(d, remaining);
      this.wx += (dx / d) * step;
      this.wy += (dy / d) * step;
    }
    this._compact();
    return { x: this.wx, y: this.wy };
  }

  // Dots for rendering: walker, every 2nd breadcrumb, then the cursor.
  dots() {
    const out = [{ x: this.wx, y: this.wy }];
    for (let i = this.seg + 1; i < this.pts.length; i += 2) out.push(this.pts[i]);
    const last = this.pts[this.pts.length - 1];
    if (Math.hypot(this.cx - last.x, this.cy - last.y) >= TRAIL_SPACING) {
      out.push({ x: this.cx, y: this.cy });
    }
    return out;
  }
}
