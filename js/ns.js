// ns.js — JavaScript wrapper around the Emscripten RunnerCore module.
//
// The simulation itself is the untouched nightshift-v1 C++ core compiled to
// WebAssembly. This file only marshals flat little-endian buffers produced by
// wasm/bridge.cpp into JS objects. No gameplay logic lives here.

export const HazardKind = Object.freeze({ Block: 0, Barrier: 1, Gap: 2, Sweeper: 3 });
export const EventKind = Object.freeze({
  Pickup: 0, NearMiss: 1, Jump: 2, Land: 3, Crash: 4, Tier: 5,
});
export const RULESET = 'nightshift-v1';
export const TICK_RATE = 60;

function parseSnapshot(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = () => { const x = v.getUint32(o, true); o += 4; return x; };
  const i32 = () => { const x = v.getInt32(o, true); o += 4; return x; };
  const i64 = () => { const x = v.getBigInt64(o, true); o += 8; return Number(x); };
  const snap = {
    tick: u32(), dead: u32() === 1, distance: i64(), score: i64(),
    pickupsCollected: u32(), nearMisses: u32(), combo: i32(), tier: i32(),
    player: {
      x: i32(), y: i32(), z: i32(), vx: i32(), vy: i32(),
      airborne: u32() === 1, jumpCooldown: i32(),
    },
    hazards: [], pickups: [], events: [],
  };
  const nHz = u32();
  for (let i = 0; i < nHz; i++) {
    snap.hazards.push({
      id: u32(), kind: u32(), x: i32(), y: i32(),
      halfWidth: i32(), halfDepth: i32(), height: i32(),
    });
  }
  const nPk = u32();
  for (let i = 0; i < nPk; i++) snap.pickups.push({ id: u32(), x: i32(), y: i32() });
  const nEv = u32();
  for (let i = 0; i < nEv; i++) {
    snap.events.push({ kind: u32(), x: i32(), y: i32(), value: i32() });
  }
  return snap;
}

function parseSegments(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const count = v.getUint32(0, true); o = 4;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const c = v.getUint32(o, true); o += 4;
    const x = v.getInt32(o, true); o += 4;
    const y = v.getInt32(o, true); o += 4;
    const j = v.getUint32(o, true); o += 4;
    frames.push([c, x, y, j]);
  }
  return frames;
}

// Wraps one instantiated Emscripten module. `probes` is true for the
// NIGHTSHIFT_TESTING parity module; the production game never enables it.
export function wrapSim(mod, probes = false) {
  const heap = () => mod.HEAPU8;
  const copy = (ptr, len) => heap().slice(ptr, ptr + len);

  const api = {
    create(seed) {
      const h = mod._ns_create(seed >>> 0);
      if (h < 0) throw new Error('sim handle exhausted');
      return h;
    },
    destroy(h) { mod._ns_destroy(h); },
    reset(h, seed) { mod._ns_reset(h, seed >>> 0); },
    // Advances one tick and returns the parsed snapshot.
    step(h, targetX, targetY, jump) {
      mod._ns_step(h, targetX | 0, targetY | 0, jump ? 1 : 0);
      return api.snapshot(h);
    },
    snapshot(h) {
      const ptr = mod._ns_snapshot_ptr(h);
      const len = mod._ns_snapshot_len(h);
      if (!ptr || !len) throw new Error('sim snapshot unavailable');
      return parseSnapshot(copy(ptr, len));
    },
    // Raw snapshot bytes (for byte-exact parity comparisons).
    snapshotBytes(h) {
      const ptr = mod._ns_snapshot_ptr(h);
      const len = mod._ns_snapshot_len(h);
      return copy(ptr, len);
    },
    // Replay-protocol frames [[count,x,y,jump],...] captured by the
    // adapter-only recorder inside the module — identical logic to the
    // native client's RunCapture.
    segments(h) {
      const count = mod._ns_segment_count(h);
      if (!count) return { eligible: api.eligible(h), frames: [] };
      const ptr = mod._ns_segments_ptr(h);
      let len = 4 + count * 16;
      const bytes = copy(ptr, len);
      return { eligible: api.eligible(h), frames: parseSegments(bytes) };
    },
    eligible(h) { return mod._ns_capture_eligible(h) === 1; },
  };

  if (probes) {
    api.testClearWorld = (h) => mod._ns_test_clear_world(h);
    api.testInjectHazard = (h, id, kind, x, y, hw, hd, height) =>
      mod._ns_test_inject_hazard(h, id >>> 0, kind | 0, x | 0, y | 0, hw | 0, hd | 0, height | 0);
    api.testSpeed = (h) => mod._ns_test_speed(h);
    api.testSafeTarget = (h) => mod._ns_test_safe_target(h);
    api.testSafeCorridors = (h) => {
      const ptr = mod._ns_test_safe_corridors_ptr(h);
      const len = mod._ns_test_safe_corridors_len(h);
      const bytes = copy(ptr, len);
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const n = v.getUint32(0, true);
      const out = [];
      for (let i = 0; i < n; i++) out.push(v.getInt32(4 + i * 4, true));
      return out;
    };
  }
  return api;
}

// `factory` is the Emscripten ES6 module factory (default export of sim.js).
export async function loadSim(factory, probes = false) {
  const mod = await factory();
  return wrapSim(mod, probes);
}
