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
    this.faceA = Math.PI / 2; // cat facing: eased toward velocity, starts looking up-road

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
    this.texStar = makeTex(gl, 64, (g, s) => {
      g.fillStyle = 'rgba(255,255,255,1)';
      g.beginPath();
      const cx = s / 2, cy = s / 2, R = s / 2 - 2, r = R * 0.45;
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? R : r;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    });
    // Scent card: vellum-cream card with three wavy scent lines baked in.
    // Tinted with white at draw time so the baked colors survive.
    this.texScentCard = makeTex(gl, 96, (g, s) => {
      g.fillStyle = '#f3e8cd';
      g.beginPath(); g.roundRect(8, 8, s - 16, s - 16, 10); g.fill();
      g.strokeStyle = '#8a6b3f'; g.lineWidth = 5; g.lineCap = 'round';
      for (let r = 0; r < 3; r++) {
        g.beginPath();
        const y0 = s * 0.32 + r * s * 0.18;
        for (let x = 22; x <= s - 22; x += 4) {
          const y = y0 + Math.sin(x * 0.24 + r * 1.9) * 7;
          if (x === 22) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
    });

    // Rolling history of the cat's world position, used for Rook's scent
    // ribbon. The sim's exact 40-tick-old scent positions are not exposed
    // by the snapshot, so this is a renderer-side approximation at the
    // render rate (~60fps, matching the 60Hz tick).
    this.scentHist = [];

    this.vbo = gl.createBuffer();
    this.batches = new Map();
    this.view = { w: 1, h: 1, scale: 0.01, cx: 0, cy: 0 };

    // District palette (defaults mirror Content/Data/greyhaven.json,
    // shifted toward the ZOVERIONS banner: deep purple/magenta/cyan neon).
    this.setDistrict({
      roadColor: '1B1030', buildingColor: '1C2942', windowColor: '70E8CF',
      buildingSpacingCm: 440, rainEnabled: true,
      phases: [
        { name: 'HARMONY COMMON', accent: '66E3C4' },
        { name: 'KESTREL SPAN', accent: 'E985E5' },
        { name: 'NEON MARKET', accent: 'F5B85A' },
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
    this.phases = (d.phases && d.phases.length ? d.phases : [{ name: 'HARMONY COMMON', accent: '66E3C4' }])
      .map((p) => ({ name: p.name, accent: hexRgb(p.accent) }));
    this.phaseTicks = d.phaseDurationTicks || 3600;
    // Far-skyline parallax: a value in (0,1]; slower than the near field.
    const sky = d.skyline || {};
    this.skyParallax = typeof sky.parallax === 'number' && sky.parallax > 0 && sky.parallax <= 1
      ? sky.parallax : 0.35;
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
  // f: { prev, curr, alpha, cursorX, cursorY, trailDots, visualTime, pulse,
  //      stride, hitFlash, dt, deathAt, reducedMotion }
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
    this.reducedMotion = !!f.reducedMotion;

    // Feed the scent history: Rook's ribbon reads the ~40-frame-old slot.
    this.scentHist.push({ x: px, y: py });
    if (this.scentHist.length > 90) this.scentHist.shift();

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
    // manholes + neon puddles on the road, scrolling with distance
    const propOff = scroll % 2600;
    for (let i = -4; i <= 4; i++) {
      const y = i * 2600 - propOff;
      if (y < -8000 || y > 9000) continue;
      const mx = ((i * 5303) % 12000) - 6000;
      this.quad(this.texDisc, false, mx, y, 520, 380, 0, 0.05, 0.06, 0.09, 1);
      this.quad(this.texDisc, false, mx, y, 380, 260, 0, 0.09, 0.11, 0.15, 1);
      const px2 = ((i * 9171) % 14000) - 7000;
      this.glow(px2, y + 900, 900, accent, 0.10);
      this.quad(this.texDisc, false, px2, y + 900, 620, 300, 0.2, 0.10, 0.14, 0.2, 0.8);
    }
    // far skyline: Harmony Common rooftops, Kestrel Span cables, and the
    // distant Calder House spire. Parallaxed slower than the near field so
    // the depth reads; silhouettes stay dim so the play field stays legible.
    {
      const par = this.skyParallax || 0.35;
      const skyOff = (scroll * par) % 6000;
      for (let i = -3; i <= 3; i++) {
        const y = i * 6000 - skyOff;
        if (y < -9500 || y > 10500) continue;
        for (const side of [-1, 1]) {
          this.quad(this.texBox, false, side * 17000, y, 2500, 5600, 0, 0.045, 0.05, 0.11, 0.92);
          this.quad(this.texDisc, false, side * 15900, y + 1100, 190, 190, 0,
            accent[0] * 0.45, accent[1] * 0.45, accent[2] * 0.45, 0.32);
        }
      }
      // Kestrel Span cables: long faint diagonals crossing the far field
      const cableOff = (scroll * par) % 5200;
      for (let cI = 0; cI < 3; cI++) {
        const y = cI * 5200 - cableOff - 5600;
        if (y < -9500 || y > 10500) continue;
        this.quad(this.texBox, true, 0, y, 30000, 22, 1.32, 0.85, 0.3, 0.75, 0.09);
        this.quad(this.texBox, true, 0, y + 260, 30000, 14, 1.32, 0.35, 0.8, 1, 0.07);
      }
      // Calder House spire: a thin silhouette with a slow violet beacon
      const spireY = 4200 - ((scroll * par) % 12000);
      if (spireY > -9500 && spireY < 10500) {
        this.quad(this.texBox, false, -15600, spireY, 420, 4400, 0, 0.07, 0.06, 0.16, 0.95);
        const sblink = 0.35 + 0.65 * Math.max(0, Math.sin(f.visualTime * 1.6 + 2.1));
        this.glow(-15600, spireY + 2200, 420 * sblink + 120, [0.65, 0.35, 1], 0.5 * sblink);
        this.quad(this.texDisc, true, -15600, spireY + 2200, 130, 130, 0,
          0.65, 0.35, 1, 0.8 * sblink);
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
          // windows flicker faintly, each on its own deterministic phase
          const flick = 0.72 + 0.28 * Math.sin(f.visualTime * 2.1 + i * 3.7 + wI * 2.3);
          this.quad(this.texDisc, false, side * 11100, y + (wI - 1) * 700, 340, 340, 0,
            windowCol[0], windowCol[1], windowCol[2], 0.95 * flick);
          this.glow(side * 11100, y + (wI - 1) * 700, 700, windowCol, 0.25 * flick);
        }
        this.glow(side * 9200, y, 640, accent, 0.5);
        this.quad(this.texDisc, false, side * 9200, y, 200, 200, 0, accent[0], accent[1], accent[2], 1);
        // antenna spire with a blinking beacon on every third tower
        if ((i + 8) % 3 === 0) {
          const spx = bx + side * 900;
          this.quad(this.texBox, false, spx, y + 2150 + bh * 0.12, 90, 900, 0,
            0.1, 0.12, 0.18, 1);
          const blink = 0.35 + 0.65 * Math.max(0, Math.sin(f.visualTime * 2.4 + i * 1.3));
          const bc = (i % 2 === 0) ? [1, 0.25, 0.3] : [0.3, 0.9, 1];
          this.glow(spx, y + 2600 + bh * 0.12, 500 * blink + 150, bc, 0.7 * blink);
          this.quad(this.texDisc, true, spx, y + 2600 + bh * 0.12, 150, 150, 0,
            bc[0], bc[1], bc[2], blink);
        }
        // sidewalk clutter: crates and drums the courier weaves past
        const cSeed = i * 7 + (side > 0 ? 3 : 0);
        const cx1 = side * (10200 + ((cSeed * 613) % 900));
        this.quad(this.texBox, false, cx1, y + 500, 420, 420, 0.06, 0.23, 0.18, 0.12, 1);
        this.quad(this.texBox, false, cx1, y + 500, 340, 340, 0.06, 0.3, 0.24, 0.16, 1);
        const dx1 = side * (10600 + ((cSeed * 911) % 700));
        this.quad(this.texDisc, false, dx1, y - 700, 360, 360, 0, 0.14, 0.2, 0.26, 1);
        this.glow(dx1, y - 700, 500, accent, 0.18);
      }
    }

    // hazards (interpolated by id)
    const prevById = new Map(prev.hazards.map((h) => [h.id, h]));
    // Gate edges: kind-0 span segments with no same-row neighbor on one
    // side border an opening; those ends get the cyan permitted-passage
    // glow, mid-span posts stay dim.
    this.gateOpen = new Map();
    {
      const spans = curr.hazards.filter((h) => h.kind === 0);
      for (const b of spans) {
        let left = false, right = false;
        for (const o of spans) {
          if (o === b || Math.abs(o.y - b.y) > 600) continue;
          const gap = Math.abs(o.x - b.x);
          if (gap < (b.halfWidth + o.halfWidth) * 1.35) {
            if (o.x < b.x) left = true; else right = true;
          }
        }
        if (!left || !right) {
          this.gateOpen.set(b.id, !left && !right ? 'both' : (!left ? 'left' : 'right'));
        }
      }
    }
    for (const hz of curr.hazards) {
      const old = prevById.get(hz.id);
      const hx = old ? old.x + (hz.x - old.x) * alpha : hz.x;
      const hy = old ? old.y + (hz.y - old.y) * alpha : hz.y;
      this.drawHazard(hz, hx, hy, f.visualTime, accent);
    }
    // scent cards: vellum cards with a baked scent glyph, bobbing gently
    const prevPk = new Map(prev.pickups.map((p) => [p.id, p]));
    for (const p of curr.pickups) {
      const old = prevPk.get(p.id);
      const py2 = old ? old.y + (p.y - old.y) * alpha : p.y;
      const bob = f.reducedMotion ? 0 : Math.sin(f.visualTime * 2.2 + p.id * 1.7) * 70;
      const cardY = py2 + bob;
      const pulse = f.reducedMotion ? 0.5 : 0.4 + 0.15 * Math.sin(f.visualTime * 2.2 + p.id);
      this.glow(p.x, cardY, 640, [0.95, 0.82, 0.55], pulse);
      this.quad(this.texScentCard, false, p.x, cardY, 330, 330, 0, 1, 1, 1, 1);
    }

    if (!curr.dead || true) this.drawCat(px, py, pz, jump, f, accent);

    // bonk recovery: dizzy stars orbit the cat while stunned, and a gold
    // guide ring marks the hole the cat is auto-running toward.
    const stun = f.stunTicks | 0;
    const guiding = stun > 0 || !!f.autoRunning;
    if (guiding && !curr.dead) {
      const gx = (f.autoX | 0), gy = (f.autoY | 0);
      if (!f.reducedMotion) {
        const pulse = 0.6 + 0.4 * Math.sin(f.visualTime * 6);
        const rad = 950 + 130 * Math.sin(f.visualTime * 6);
        for (let i = 0; i < 18; i++) {
          if (i % 2) continue;
          const a = (i * 2 * Math.PI) / 18 + f.visualTime * 0.8;
          this.quad(this.texDisc, true, gx + Math.cos(a) * rad, gy + Math.sin(a) * rad,
            110, 110, 0, 1, 0.8, 0.25, 0.85);
        }
        this.glow(gx, gy, 1500 * pulse + 600, [1, 0.75, 0.2], 0.4);
        // dotted guide line from the cat to the hole
        const dx = gx - px, dy = gy - py;
        const steps = Math.floor(Math.hypot(dx, dy) / 520);
        for (let i = 1; i < steps; i++) {
          const tt = i / steps;
          this.quad(this.texDisc, true, px + dx * tt, py + dy * tt, 80, 80, 0,
            1, 0.8, 0.3, 0.5 * (1 - tt * 0.5));
        }
      } else {
        this.glow(gx, gy, 1600, [1, 0.75, 0.2], 0.5);
      }
    }
    if (stun > 0 && !curr.dead && !f.reducedMotion) {
      for (let i = 0; i < 4; i++) {
        const a = f.visualTime * 5.2 + (i * 2 * Math.PI) / 4;
        const sx = px + Math.cos(a) * 640;
        const sy = py + pz * 0.22 + 430 + Math.sin(a * 2) * 90;
        const tw = 0.65 + 0.35 * Math.sin(f.visualTime * 9 + i * 1.7);
        this.glow(sx, sy, 430 * tw, [1, 0.8, 0.25], 0.35);
        this.quad(this.texStar, true, sx, sy, 270 * tw, 270 * tw, a * 0.7,
          1, 0.85, 0.3, 0.95);
      }
    }

    // dotted breadcrumb trail: the path the cat is committed to
    const dots = f.trailDots || [];
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const a = 0.22 + 0.5 * (i / Math.max(1, dots.length));
      this.quad(this.texDisc, true, d.x, d.y, 90, 90, 0, 1, 0.82, 0.45, a);
    }

    // cursor ring: where the pointer is drawing
    for (let i = 0; i < 24; i++) {
      const a = (i * 2 * Math.PI) / 24;
      this.quad(this.texDisc, true,
        f.cursorX + Math.cos(a) * 450, f.cursorY + Math.sin(a) * 450,
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
    // hit flash: red wash when a life is lost
    if (f.hitFlash > 0) {
      this.glow(v.cx, v.cy, Math.max(v.viewW, v.viewH) * 0.62, [1, 0.12, 0.08], 0.42 * f.hitFlash);
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
    if (hz.kind === 4) { // Rook: the enhanced greyhound, a person reading old scent
      const fur = [0.36, 0.39, 0.47], dark = [0.2, 0.22, 0.29];
      this.glow(hx, hy, Math.max(w, d) * 0.85, [0.9, 0.35, 0.7], 0.22 * edge);
      // scent ribbon: a faint fading line from the old scent position Rook
      // is reading to his nose. The sim's exact 40-tick scent slot is not
      // exposed, so the renderer holds ~40 frames of cat history instead.
      const hist = this.scentHist;
      if (hist.length > 40) {
        const old = hist[hist.length - 41];
        const nx = hx, ny = hy - 900;
        const steps = 9;
        for (let i = 0; i <= steps; i++) {
          const tt = i / steps;
          this.glow(old.x + (nx - old.x) * tt, old.y + (ny - old.y) * tt,
            240, [0.55, 0.85, 1], 0.13 * (1 - tt * 0.55) * edge);
        }
        this.glow(old.x, old.y, 520, [0.55, 0.85, 1], 0.09 * edge);
      }
      // tucked legs: folded close, unhurried
      for (const lx of [-150, 150]) for (const ly of [-150, 150]) {
        this.quad(this.texDisc, false, hx + lx, hy + ly, 140, 140, 0, dark[0], dark[1], dark[2], edge);
      }
      // long lean body, tucked frame
      this.quad(this.texDisc, false, hx, hy, 1020, 430, 0, fur[0], fur[1], fur[2], edge);
      this.quad(this.texDisc, false, hx, hy + 40, 700, 330, 0, dark[0], dark[1], dark[2], 0.55 * edge);
      // neck and long tapered head, nose to the old scent
      this.quad(this.texDisc, false, hx, hy - 400, 300, 420, 0, fur[0] * 1.1, fur[1] * 1.1, fur[2] * 1.1, edge);
      this.quad(this.texTri, false, hx, hy - 690, 230, 430, Math.PI, fur[0] * 1.1, fur[1] * 1.1, fur[2] * 1.1, edge);
      this.quad(this.texDisc, false, hx, hy - 880, 110, 110, 0, dark[0], dark[1], dark[2], edge);
      // swept-back ears
      for (const s of [-1, 1]) {
        this.quad(this.texTri, false, hx + s * 130, hy - 480, 120, 220, s * -2.6 + Math.PI,
          dark[0], dark[1], dark[2], edge);
        // eyes: cyan glints — a person, not a monster
        this.glow(hx + s * 95, hy - 430, 150, [0.4, 0.9, 1], 0.6 * edge);
        this.quad(this.texDisc, true, hx + s * 95, hy - 430, 80, 80, 0, 0.4, 0.9, 1, 0.95 * edge);
      }
      // implant glints at the neck: Cairn Cognition regulators
      const reg = this.reducedMotion ? 0.7 : 0.45 + 0.3 * Math.sin(t * 2.2 + hx * 0.001);
      for (const s of [-1, 1]) {
        this.glow(hx + s * 85, hy - 330, 200, [0.7, 1, 0.95], reg * edge);
        this.quad(this.texBox, true, hx + s * 85, hy - 330, 70, 70, 0, 0.75, 1, 0.95, reg * edge);
      }
      // tail: straight and still, slight curve
      let gx = hx, gy2 = hy + 240;
      for (let i = 0; i < 3; i++) {
        gx += 26;
        gy2 += 120;
        this.quad(this.texDisc, false, gx, gy2, 120 - i * 22, 120 - i * 22, 0, fur[0], fur[1], fur[2], edge);
      }
    } else if (hz.kind === 2) { // Gap: dark pit with glowing edge rails
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
      if (!tall) {
        // Checkpoint gate: a dark span segment of the Kestrel-style
        // district gate. Beacon-lit posts cap the segment; the end that
        // borders an opening carries the cyan permitted-passage glow.
        // Solid spans are stamped with faint abstract one-bit glyphs.
        const openSides = this.gateOpen ? this.gateOpen.get(hz.id) : null;
        const span = [0.075, 0.085, 0.15];
        this.quad(this.texBox, false, hx, hy - d * 0.05, w, d, 0, span[0] * 0.6, span[1] * 0.6, span[2] * 0.6, edge);
        this.quad(this.texBox, false, hx, hy, w, d, 0, span[0], span[1], span[2], edge);
        this.quad(this.texBox, false, hx, hy + d * 0.06, w * 0.94, d * 0.84, 0,
          span[0] * 1.7, span[1] * 1.7, span[2] * 1.7, edge);
        this.glow(hx, hy, Math.max(w, d) * 0.7, [0.5, 0.35, 0.8], 0.28 * edge);
        // one-bit glyph marks: abstract dot pairs, deterministic per segment
        let bits = ((hz.id * 2654435761) ^ 0x9e3779b9) >>> 0;
        const glyphs = Math.min(6, Math.max(2, Math.round(w / 1400)));
        for (let gI = 0; gI < glyphs; gI++) {
          bits = (bits * 1103515245 + 12345) >>> 0;
          const on = ((bits >>> 16) & 1) === 1;
          const gx = hx - w / 2 + ((gI + 0.5) / glyphs) * w;
          const dotA = 0.30 * edge;
          this.quad(this.texDisc, true, gx - 60, hy, 70, 70, 0, 0.5, 0.9, 1, on ? dotA : dotA * 0.3);
          this.quad(this.texDisc, true, gx + 60, hy, 70, 70, 0, 0.5, 0.9, 1, on ? dotA * 0.3 : dotA);
        }
        // beacon-lit posts at the segment ends
        const blink = this.reducedMotion ? 0.7 : 0.5 + 0.5 * Math.sin(t * 3.1 + hz.id * 1.3);
        for (const s of [-1, 1]) {
          const ex = hx + s * w / 2;
          const open = openSides === 'both' ||
            (openSides === 'left' && s < 0) || (openSides === 'right' && s > 0);
          const pc = open ? [0.35, 0.95, 1] : [0.95, 0.4, 0.8];
          this.quad(this.texBox, false, ex, hy, 170, d * 1.02, 0, 0.08, 0.1, 0.14, edge);
          this.glow(ex, hy + d * 0.3, 700 * blink + 150, pc, (open ? 0.75 : 0.4) * blink * edge);
          this.quad(this.texDisc, true, ex, hy + d * 0.3, 150, 150, 0,
            pc[0], pc[1], pc[2], (open ? 1 : 0.7) * blink * edge);
        }
        // the top edge catches the neon; the base glows a warning toward
        // the courier so the gate still reads as solid.
        this.quad(this.texBox, false, hx, hy + d / 2 - 60, w * 0.98, 120, 0,
          span[0] * 2.4, span[1] * 2.4, span[2] * 2.4, edge);
        const warn = 0.55 + 0.35 * Math.sin(t * 3 + hx * 0.001);
        this.glow(hx, hy - d / 2, Math.min(w, 9000) * 0.9, [1, 0.45, 0.1], 0.30 * warn * edge);
        this.quad(this.texBox, false, hx, hy - d / 2 + 40, w * 0.98, 80, 0, 1, 0.5, 0.12, 0.85 * edge);
      }
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
    const stunned = (f.stunTicks | 0) > 0;
    const fade = dead ? Math.max(0.25, 1 - (f.visualTime - f.deathAt) * 1.2) : 1;
    const gy = py;                       // ground position (shadow, trail)
    const cy = py + pz * 0.22;           // body rides up with jump height
    const s = 1 + jump * 0.13;
    const stride = f.stride;
    const air = f.curr.player.airborne;

    // soft accent glow under the courier so it pops off the road
    if (!dead) this.glow(px, gy, 1050 * s, accent, 0.16 * fade);
    // landing shadow shrinks as the cat climbs
    const shScale = 1.15 - jump * 0.28;
    this.quad(this.texDisc, false, px, gy, 1320 * shScale, 860 * shScale, 0, 0, 0, 0, 0.42 * fade);

    // full 360° facing, eased toward the velocity direction; holds the last
    // meaningful heading when the cat stops
    const p = f.curr.player;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 60 && f.dt > 0) {
      const want = Math.atan2(p.vy, p.vx);
      let d = want - this.faceA;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.faceA += d * (1 - Math.exp(-f.dt * 10));
    }
    const heading = this.faceA + (stunned && !f.reducedMotion
      ? Math.sin(f.visualTime * 26) * 0.07 : 0);

    // trail behind the facing direction
    if (!dead) {
      const bx = Math.cos(heading), by = Math.sin(heading);
      for (let i = 1; i <= 6; i++) {
        const k = 1 - i / 7;
        this.glow(px - bx * i * 170, gy - by * i * 170 + pz * 0.088, 200 * k + 60, [0.4, 1, 0.7], 0.35 * k * fade);
      }
    }
    const R = (lx, ly) => {
      const c = Math.cos(heading), s2 = Math.sin(heading);
      return [px + (lx * c - ly * s2) * s, cy + (lx * s2 + ly * c) * s];
    };
    const ORANGE = [0.91, 0.5, 0.2], CREAM = [0.96, 0.9, 0.78],
      ARMOR = [0.16, 0.2, 0.26], EYE = [0.45, 1, 0.68],
      CYAN = [0.35, 0.85, 1], MAGENTA = [0.95, 0.28, 0.78],
      ZGLOW = [0.72, 0.4, 1];

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
    // ginger tabby stripes across the back
    for (const sx of [-160, 20, 200]) {
      part(this.texBox, false, sx, 0, 64 * s, 500 * s, 0, [0.58, 0.3, 0.12], 0.85);
    }
    part(this.texDisc, false, -330, 0, 300 * s, 540 * s, 0, [0.58, 0.3, 0.12], 0.5);
    // cyber jacket collar at the neck, purple-trimmed
    part(this.texBox, false, 250, 0, 130 * s, 560 * s, 0, [0.07, 0.09, 0.13], 1);
    part(this.texBox, true, 250, 0, 130 * s, 44 * s, 0, ZGLOW, 0.9);
    part(this.texBox, true, 250, -260 * s, 130 * s, 30 * s, 0, ZGLOW, 0.7);
    part(this.texBox, true, 250, 260 * s, 130 * s, 30 * s, 0, ZGLOW, 0.7);
    // collar ID tag: Gödel's nine identity credentials. The glow steps down
    // with the credentials remaining and flickers on the last one.
    {
      const creds = Math.max(0, Math.min(9, f.curr.lives ?? 9));
      const frac = creds / 9;
      const flick = creds === 1 && !f.reducedMotion
        ? 0.4 + 0.6 * Math.abs(Math.sin(f.visualTime * 11))
        : 1;
      const tagA = (0.22 + 0.78 * frac) * flick;
      const [tagX, tagY] = R(150, 0);
      this.glow(tagX, tagY, 320 * s, CYAN, 0.3 * tagA * fade);
      part(this.texBox, false, 150, 0, 170 * s, 130 * s, 0, [0.04, 0.06, 0.09], 1);
      part(this.texBox, true, 150, 0, 170 * s, 130 * s, 0, CYAN, 0.85 * tagA);
      part(this.texBox, true, 150, 0, 80 * s, 20 * s, 0, [1, 1, 1], 0.85 * tagA);
    }
    part(this.texDisc, false, 470, 60, 620 * s, 640 * s, 0, ORANGE, 1);
    part(this.texDisc, false, 740, 20, 250 * s, 400 * s, 0, CREAM, 1);   // muzzle
    part(this.texDisc, false, 850, 60, 110 * s, 160 * s, 0, ARMOR, 1);   // nose
    // ears
    for (const sd of [-1, 1]) {
      part(this.texTri, false, 360, sd * 250, 300 * s, 420 * s, sd * -0.6, ORANGE, 1);
      part(this.texTri, false, 350, sd * 265, 150 * s, 220 * s, sd * -0.6, CREAM, 1);
      if (stunned) {
        // X-eyes: cartoon knockout while the cat is dizzy
        const [ex, ey] = R(660, sd * 240);
        const xs = 150 * s;
        this.quad(this.texBox, false, ex, ey, xs * 2.1, xs * 0.55, Math.PI / 4 + heading,
          0.08, 0.1, 0.14, fade);
        this.quad(this.texBox, false, ex, ey, xs * 2.1, xs * 0.55, -Math.PI / 4 + heading,
          0.08, 0.1, 0.14, fade);
      } else {
        // eyes: luminous green with a soft glow, per the brand
        const [ex2, ey2] = R(660, sd * 240);
        this.glow(ex2, ey2, 320 * s, EYE, 0.5 * fade);
        part(this.texDisc, false, 660, sd * 240, 170 * s, 130 * s, 0, EYE, 1);
        part(this.texBox, false, 700, sd * 250, 60 * s, 110 * s, 0, [0.05, 0.08, 0.1], 1);
      }
      // whiskers: cyan, per the brand
      const [wxx, wyy] = R(720, sd * 330);
      this.quad(this.texStreak, true, wxx, wyy, 30, 360 * s, Math.PI / 2 + heading + sd * 0.2,
        CYAN[0], CYAN[1], CYAN[2], 0.85 * fade);
    }
    // armor plate + signal spine + stripes + magenta circuitry
    part(this.texBox, false, -20, 120, 500 * s, 520 * s, 0, ARMOR, 1);
    part(this.texBox, true, -20, 200, 380 * s, 80 * s, 0, EYE, 0.95);
    this.glow(px, cy + 200 * s, 700 * s, EYE, 0.3 * fade);
    for (let i = 0; i < 3; i++) {
      part(this.texBox, false, -240 + i * 165, 130, 42 * s, 540 * s, 0, [0.72, 0.36, 0.14], 1);
    }
    // magenta circuit traces on the armor (upper half, clear of the Z)
    part(this.texBox, true, -140, 40, 200 * s, 24 * s, 0, MAGENTA, 0.8);
    part(this.texBox, true, -40, 40, 24 * s, 150 * s, 0, MAGENTA, 0.8);
    part(this.texBox, true, 90, 110, 140 * s, 24 * s, 0.5, MAGENTA, 0.65);
    // glowing Z shoulder emblem — the courier's brand (kept clear of the spine)
    const zx = -30, zy = -60, zs = s;
    this.glow(...R(zx, zy), 420 * zs, ZGLOW, 0.28 * fade);
    part(this.texBox, true, zx, zy + 80 * zs, 220 * zs, 44 * zs, 0, ZGLOW, 0.95);
    part(this.texBox, true, zx, zy - 80 * zs, 220 * zs, 44 * zs, 0, ZGLOW, 0.95);
    part(this.texBox, true, zx, zy, 250 * zs, 44 * zs, -0.62, ZGLOW, 0.95);
  }
}
Renderer._nextTexId = 1;
