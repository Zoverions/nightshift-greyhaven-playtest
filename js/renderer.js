// renderer.js — WebGL2 top-down renderer for Nightshift: Greyhaven.
//
// Replicates the look of ANightshiftScene::Present (Unreal) in a browser:
// orthographic neon district, handmade courier cat, cargo/barriers/gaps/
// sweepers, signal fragments, landing shadow, target ring, event pulses,
// deterministic rain. Screen-right is core +X, screen-up is core +Y, matching
// NightshiftCoordinates (camera looks straight down).

const VERT_SRC = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aCol;
uniform vec4 uView;
out vec2 vUV;
out vec4 vCol;
void main() {
  vUV = aUV; vCol = aCol;
  vec2 p = vec2((aPos.x - uView.z) * uView.x, (aPos.y - uView.w) * uView.y);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 vUV; in vec4 vCol;
uniform sampler2D uTex;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUV);
  o = vec4(vCol.rgb * t.rgb, vCol.a * t.a);
}`;

function hexRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function makeTex(gl, size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;

    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('shader: ' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUV');
    gl.bindAttribLocation(prog, 2, 'aCol');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    this.uView = gl.getUniformLocation(prog, 'uView');
    this.uTex = gl.getUniformLocation(prog, 'uTex');

    // Procedural sprite textures (white shapes; tint comes from vertex color).
    this.texGlow = makeTex(gl, 128, (g, s) => {
      const r = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.35, 'rgba(255,255,255,.45)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, s, s);
    });
    this.texDisc = makeTex(gl, 64, (g, s) => {
      const r = g.createRadialGradient(s/2, s/2, s*0.28, s/2, s/2, s/2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.82, 'rgba(255,255,255,1)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.beginPath(); g.arc(s/2, s/2, s/2, 0, 7); g.fill();
    });
    this.texBox = makeTex(gl, 64, (g, s) => {
      g.fillStyle = 'rgba(255,255,255,1)';
      g.beginPath(); g.roundRect(3, 3, s - 6, s - 6, 9); g.fill();
      g.filter = 'blur(2px)'; g.fill();
    });
    this.texTri = makeTex(gl, 64, (g, s) => {
      g.fillStyle = 'rgba(255,255,255,1)';
      g.beginPath(); g.moveTo(s/2, 4); g.lineTo(s - 4, s - 6); g.lineTo(4, s - 6); g.closePath(); g.fill();
    });
    this.texStreak = makeTex(gl, 32, (g, s) => {
      const grad = g.createLinearGradient(0, 0, 0, s);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,.9)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(s/2 - 2, 0, 4, s);
    });

    this.vbo = gl.createBuffer();
    this.batches = new Map();
    this.view = { w: 1, h: 1, scale: 0.01, cx: 0, cy: 0 };

    // District palette (defaults mirror Content/Data/greyhaven.json).
    this.setDistrict({
      roadColor: '101C2C', buildingColor: '1C2942', windowColor: '70E8CF',
      buildingSpacingCm: 440, rainEnabled: true,
      phases: [
        { name: 'SERVICE ROADS', accent: '66E3C4' },
        { name: 'NEON MARKET', accent: 'E985E5' },
        { name: 'FREIGHT CROSSING', accent: 'F5B85A' },
        { name: 'BLACKOUT PULSE', accent: '9BADF7' },
      ],
    });
  }

  setDistrict(d) {
    this.road = hexRgb(d.roadColor || '101C2C');
    this.building = hexRgb(d.buildingColor || '1C2940');
    this.windowBase = hexRgb(d.windowColor || '70E8CF');
    this.spacing = (d.buildingSpacingCm || 440) * 10;
    this.rainEnabled = d.rainEnabled !== false;
    this.phases = (d.phases && d.phases.length ? d.phases : [{ name: 'SERVICE ROADS', accent: '66E3C4' }])
      .map((p) => ({ name: p.name, accent: hexRgb(p.accent) }));
    this.phaseTicks = d.phaseDurationTicks || 3600;
  }

  phaseName(tick) { return this.phases[Math.floor(tick / this.phaseTicks) % this.phases.length].name; }
  accent(tick) { return this.phases[Math.floor(tick / this.phaseTicks) % this.phases.length].accent; }

  // Mirrors ANightshiftScene::FitCamera: the full input rectangle
  // x [-8400,8400], y [-6500,6500] stays visible in any aspect.
  resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    const aspect = cssW / Math.max(1, cssH);
    const viewW = Math.max(21000, 18000 * Math.max(0.1, aspect));
    const viewH = viewW / aspect;
    this.view = { w, h, scale: w / viewW, cx: 0, cy: 0, viewW, viewH };
    this.gl.viewport(0, 0, w, h);
  }

  // --- batching ---------------------------------------------------------
  quad(tex, additive, cx, cy, w, h, rot, r, gcol, b, a) {
    if (tex.__id === undefined) tex.__id = Renderer._nextTexId++;
    const key = (additive ? 'a' : 'n') + tex.__id;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { tex, additive, verts: [] };
      this.batches.set(key, batch);
    }
    const hw = w / 2, hh = h / 2;
    const c = Math.cos(rot), s = Math.sin(rot);
    const pts = [[-hw, -hh, 0, 0], [hw, -hh, 1, 0], [hw, hh, 1, 1], [-hw, hh, 0, 1]];
    const v = batch.verts;
    const push = (p) => {
      v.push(cx + p[0] * c - p[1] * s, cy + p[0] * s + p[1] * c, p[2], p[3], r, gcol, b, a);
    };
    // two triangles
    push(pts[0]); push(pts[1]); push(pts[2]);
    push(pts[0]); push(pts[2]); push(pts[3]);
  }

  glow(cx, cy, size, rgb, a) {
    this.quad(this.texGlow, true, cx, cy, size, size, 0, rgb[0], rgb[1], rgb[2], a);
  }

  flush() {
    const gl = this.gl;
    for (const batch of this.batches.values()) {
      if (!batch.verts.length) continue;
      gl.bindTexture(gl.TEXTURE_2D, batch.tex);
      gl.uniform1i(this.uTex, 0);
      if (batch.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.verts), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
      gl.drawArrays(gl.TRIANGLES, 0, batch.verts.length / 8);
      batch.verts.length = 0;
    }
  }

  // --- scene ------------------------------------------------------------
  // f: { prev, curr, alpha, targetX, targetY, visualTime, pulse, reducedMotion }
  render(f) {
    const gl = this.gl;
    const { prev, curr, alpha } = f;
    const tick = curr.tick;
    const accent = this.accent(tick);
    const windowCol = lerp3(this.windowBase, accent, 0.55);
    const v = this.view;
    gl.uniform4f(this.uView, 2 * v.scale / v.w, 2 * v.scale / v.h, v.cx, v.cy);
    gl.enable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    const px = prev.player.x + (curr.player.x - prev.player.x) * alpha;
    const py = prev.player.y + (curr.player.y - prev.player.y) * alpha;
    const pz = prev.player.z + (curr.player.z - prev.player.z) * alpha;
    const scroll = prev.distance + (curr.distance - prev.distance) * alpha;
    const jump = pz / 2200;

    // backdrop: undercity + road + sidewalks
    this.quad(this.texBox, false, v.cx, v.cy, v.viewW * 2, v.viewH * 2, 0, 0.016, 0.03, 0.05, 1);
    this.quad(this.texBox, false, 0, 400, 18000, 17400, 0, this.road[0], this.road[1], this.road[2], 1);
    for (const side of [-1, 1]) {
      this.quad(this.texBox, false, side * 9900, 400, 1800, 17400, 0, 0.10, 0.13, 0.17, 1);
    }
    // lane dashes scroll with distance
    const laneOff = scroll % 1800;
    for (let i = -6; i <= 6; i++) {
      for (const lane of [-5000, 0, 5000]) {
        const y = i * 1800 - laneOff;
        if (y < -8000 || y > 9000) continue;
        this.quad(this.texBox, false, lane, y, 90, 420, 0, 0.35, 0.42, 0.5, 0.5);
      }
    }
    // buildings, windows, neon bollards scroll past on both sides
    const bOff = scroll % this.spacing;
    for (const side of [-1, 1]) {
      for (let i = -4; i <= 4; i++) {
        const y = i * this.spacing - bOff;
        if (y < -9000 || y > 10000) continue;
        const bh = 2600 + ((i + 4) % 3) * 900;
        const bx = side * 13300;
        this.quad(this.texBox, false, bx, y, 3520, 4300, 0, this.building[0], this.building[1], this.building[2], 1);
        this.quad(this.texBox, false, bx, y + 240 + bh * 0.12, 3300, 3800, 0,
          this.building[0] * 1.5, this.building[1] * 1.5, this.building[2] * 1.5, 1);
        for (let wI = 0; wI < 3; wI++) {
          this.quad(this.texDisc, false, side * 11100, y + (wI - 1) * 700, 340, 340, 0,
            windowCol[0], windowCol[1], windowCol[2], 0.95);
          this.glow(side * 11100, y + (wI - 1) * 700, 700, windowCol, 0.25);
        }
        this.glow(side * 9200, y, 640, accent, 0.5);
        this.quad(this.texDisc, false, side * 9200, y, 200, 200, 0, accent[0], accent[1], accent[2], 1);
      }
    }

    // hazards (interpolated by id)
    const prevById = new Map(prev.hazards.map((h) => [h.id, h]));
    for (const hz of curr.hazards) {
      const old = prevById.get(hz.id);
      const hx = old ? old.x + (hz.x - old.x) * alpha : hz.x;
      const hy = old ? old.y + (hz.y - old.y) * alpha : hz.y;
      this.drawHazard(hz, hx, hy, f.visualTime, accent);
    }
    // signal pickups
    const prevPk = new Map(prev.pickups.map((p) => [p.id, p]));
    for (const p of curr.pickups) {
      const old = prevPk.get(p.id);
      const py2 = old ? old.y + (p.y - old.y) * alpha : p.y;
      const rot = Math.PI / 4 + f.visualTime * 0.8;
      this.glow(p.x, py2, 700, [0.35, 1, 0.75], 0.55);
      this.quad(this.texBox, false, p.x, py2, 300, 300, rot, 0.4, 1, 0.78, 1);
      this.quad(this.texBox, false, p.x, py2, 150, 150, rot, 0.85, 1, 0.9, 1);
    }

    if (!curr.dead || true) this.drawCat(px, py, pz, jump, f, accent);

    // aim target ring
    for (let i = 0; i < 24; i++) {
      const a = (i * 2 * Math.PI) / 24;
      this.quad(this.texDisc, true,
        f.targetX + Math.cos(a) * 450, f.targetY + Math.sin(a) * 450,
        70, 70, 0, 1, 0.95, 0.8, 0.8);
    }
    // event pulse ring
    if (f.pulse > 0 && !f.reducedMotion) {
      const radius = (1 - f.pulse) * 1200 + 450;
      for (let i = 0; i < 16; i++) {
        const a = (i * 2 * Math.PI) / 16;
        this.glow(px + Math.cos(a) * radius, py + Math.sin(a) * radius,
          260 * f.pulse + 60, accent, 0.5 * f.pulse);
      }
    }
    // deterministic rain
    if (this.rainEnabled && !f.reducedMotion) {
      for (let i = 0; i < 42; i++) {
        const rx = ((i * 7919) % 18000) - 9000;
        const ry = 7800 - ((i * 1133 + f.visualTime * 1700) % 15600);
        this.quad(this.texStreak, true, rx, ry, 60, 340, 0.21, 0.5, 0.75, 0.85, 0.28);
      }
    }
    this.flush();
  }

  drawHazard(hz, hx, hy, t, accent) {
    const w = hz.halfWidth * 2, d = hz.halfDepth * 2;
    // fade near the spawn/retire edges so rows never pop in
    let edge = 1;
    if (hy > 7000) edge = Math.max(0, (8500 - hy) / 1500);
    if (hy < -7000) edge = Math.max(0, (hy + 8000) / 1000);
    const cream = [0.96, 0.91, 0.78];
    if (hz.kind === 2) { // Gap: dark pit with glowing edge rails
      this.quad(this.texBox, false, hx, hy, w, d, 0, 0.01, 0.015, 0.03, edge);
      for (const s of [-1, 1]) {
        this.glow(hx, hy + s * hz.halfDepth, Math.max(w, 300), [1, 0.42, 0.2], 0.5 * edge);
        this.quad(this.texBox, false, hx, hy + s * hz.halfDepth, w, 130, 0, 1, 0.45, 0.2, 0.9 * edge);
      }
    } else if (hz.kind === 1) { // Barrier: low amber bar with cream stripes
      const hh = Math.max(hz.height, 800);
      this.glow(hx, hy, Math.max(w, d) * 0.9, [1, 0.62, 0.15], 0.35 * edge);
      this.quad(this.texBox, false, hx, hy - hh * 0.12, w, d, 0, 0.55, 0.32, 0.08, edge);
      this.quad(this.texBox, false, hx, hy, w, d, 0, 1, 0.62, 0.16, edge);
      for (const s of [-1, 0, 1]) {
        this.quad(this.texBox, false, hx + s * hz.halfWidth * 0.55, hy, w * 0.1, d * 0.9, 0,
          cream[0], cream[1], cream[2], 0.9 * edge);
      }
    } else { // Block / Sweeper: tall cargo with glowing cap
      const tall = hz.kind === 3;
      const hh = Math.max(1800, hz.height);
      const body = tall ? [0.32, 0.2, 0.5] : [0.16, 0.22, 0.34];
      const edgeCol = tall ? [0.75, 0.5, 1] : [0.95, 0.35, 0.55];
      this.quad(this.texBox, false, hx, hy - hh * 0.14, w, d, 0, body[0] * 0.6, body[1] * 0.6, body[2] * 0.6, edge);
      this.quad(this.texBox, false, hx, hy, w, d, 0, body[0], body[1], body[2], edge);
      this.quad(this.texBox, false, hx, hy + d * 0.06, w * 0.92, d * 0.82, 0,
        body[0] * 1.6, body[1] * 1.6, body[2] * 1.6, edge);
      this.glow(hx, hy, Math.max(w, d) * 0.8, edgeCol, 0.4 * edge);
      this.quad(this.texBox, false, hx, hy, w * 0.55, d * 0.55, 0, cream[0], cream[1], cream[2], 0.85 * edge);
      if (tall) {
        const rot = t * 0.9;
        for (const s of [-1, 1]) {
          this.quad(this.texBox, true, hx + s * hz.halfWidth, hy, 200, 200, rot, 1, 1, 1, 0.9 * edge);
        }
      }
    }
  }

  drawCat(px, py, pz, jump, f, accent) {
    const dead = f.curr.dead;
    const fade = dead ? Math.max(0.25, 1 - (f.visualTime - f.deathAt) * 1.2) : 1;
    const gy = py;                       // ground position (shadow, trail)
    const cy = py + pz * 0.22;           // body rides up with jump height
    const s = 1 + jump * 0.13;
    const stride = f.stride;
    const air = f.curr.player.airborne;

    // landing shadow shrinks as the cat climbs
    const shScale = 1.15 - jump * 0.28;
    this.quad(this.texDisc, false, px, gy, 1320 * shScale, 860 * shScale, 0, 0, 0, 0, 0.42 * fade);

    // trail
    if (!dead) {
      for (let i = 1; i <= 6; i++) {
        const k = 1 - i / 7;
        this.glow(px, gy - i * 170 + pz * 0.088, 200 * k + 60, [0.4, 1, 0.7], 0.35 * k * fade);
      }
    }

    // heading from velocity, eased like the Unreal presentation
    const p = f.curr.player;
    const fwd = Math.max(25, p.vy + (f.scrollDelta || 0));
    const heading = Math.atan2(p.vx, fwd) * 0.45;
    const R = (lx, ly) => {
      const c = Math.cos(heading), s2 = Math.sin(heading);
      return [px + (lx * c - ly * s2) * s, cy + (lx * s2 + ly * c) * s];
    };
    const ORANGE = [0.91, 0.5, 0.2], CREAM = [0.96, 0.9, 0.78],
      ARMOR = [0.16, 0.2, 0.26], EYE = [0.45, 1, 0.68];

    const part = (tex, add, lx, ly, w, h, rot, col, a) => {
      const [wx, wy] = R(lx, ly);
      this.quad(tex, add, wx, wy, w * s, h * s, rot + heading, col[0], col[1], col[2], a * fade);
    };

    // tail: 4 wagging segments
    let tx = -560, ty = 0;
    for (let i = 0; i < 4; i++) {
      const wag = Math.sin(stride * 0.42 - i * 0.65) * 0.4;
      tx += -200; ty += Math.sin(wag) * 170 + (air ? 40 : 20);
      const [wx, wy] = R(tx, ty);
      this.quad(this.texDisc, false, wx, wy, (i === 3 ? 220 : 300) * s, 200 * s, wag + heading,
        ...(i === 3 ? CREAM : ORANGE), fade);
    }
    // paws (stride; tucked when airborne)
    const pawDefs = [[300, 260], [300, -260], [-300, 260], [-300, -260]];
    pawDefs.forEach(([lx, ly], i) => {
      const wave = air ? 0 : Math.sin(stride + (i === 0 || i === 3 ? 0 : Math.PI)) * 90;
      part(this.texDisc, false, lx + wave * 0.4, ly, air ? 200 : 300, air ? 160 : 240, 0, ORANGE, 1);
      const [bx, by] = R(lx + wave * 0.4 + 130, ly);
      this.quad(this.texBox, false, bx, by, 190 * s, 150 * s, heading, ARMOR[0], ARMOR[1], ARMOR[2], fade);
    });
    // body, haunch, head
    part(this.texDisc, false, 0, 0, 980 * s, 560 * s, 0, ORANGE, 1);
    part(this.texDisc, false, -330, 0, 520 * s, 620 * s, 0, [0.82, 0.44, 0.17], 1);
    part(this.texDisc, false, 470, 60, 620 * s, 640 * s, 0, ORANGE, 1);
    part(this.texDisc, false, 740, 20, 250 * s, 400 * s, 0, CREAM, 1);   // muzzle
    part(this.texDisc, false, 850, 60, 110 * s, 160 * s, 0, ARMOR, 1);   // nose
    // ears
    for (const sd of [-1, 1]) {
      part(this.texTri, false, 360, sd * 250, 300 * s, 420 * s, sd * -0.6, ORANGE, 1);
      part(this.texTri, false, 350, sd * 265, 150 * s, 220 * s, sd * -0.6, CREAM, 1);
      // eyes
      part(this.texDisc, false, 660, sd * 240, 170 * s, 130 * s, 0, EYE, 1);
      part(this.texBox, false, 700, sd * 250, 60 * s, 110 * s, 0, [0.05, 0.08, 0.1], 1);
      // whiskers
      const [wxx, wyy] = R(720, sd * 330);
      this.quad(this.texStreak, false, wxx, wyy, 26, 340 * s, Math.PI / 2 + heading + sd * 0.2,
        CREAM[0], CREAM[1], CREAM[2], 0.8 * fade);
    }
    // armor plate + signal spine + stripes
    part(this.texBox, false, -20, 120, 500 * s, 520 * s, 0, ARMOR, 1);
    part(this.texBox, true, -20, 200, 380 * s, 80 * s, 0, EYE, 0.95);
    this.glow(px, cy + 200 * s, 700 * s, EYE, 0.3 * fade);
    for (let i = 0; i < 3; i++) {
      part(this.texBox, false, -240 + i * 165, 130, 42 * s, 540 * s, 0, [0.72, 0.36, 0.14], 1);
    }
  }
}
Renderer._nextTexId = 1;
