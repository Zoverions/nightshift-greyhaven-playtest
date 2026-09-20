// game.js — Nightshift: Greyhaven web-native game shell.
//
// Owns the screen state machine (menu / running / paused / gameover), fixed-
// timestep loop, pointer+touch+keyboard input, HUD, focus-loss auto-pause,
// WebAudio cues, and the ranked/practice run lifecycle against the score
// service. The simulation is the WASM nightshift-v1 core (see ns.js); this
// file contains no gameplay rules.

import createSim from './sim.js';
import { loadSim, EventKind, RULESET, TICK_RATE } from './ns.js';
import { Renderer } from './renderer.js';
import { Sfx } from './audio.js';
import {
  loadConfig, safeApiBase, registerPlayer, issueRun, submitRun,
  fetchBoard, secondsLabel, NAME_RE,
} from './api.js';

const TICK = 1 / TICK_RATE;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

const $ = (id) => document.getElementById(id);

class Game {
  constructor() {
    this.screen = 'boot';
    this.sim = null;
    this.handle = -1;
    this.renderer = null;
    this.sfx = new Sfx();
    this.prev = null;
    this.curr = null;
    this.alpha = 1;
    this.acc = 0;
    this.last = 0;
    this.target = { x: 0, y: -3500 };
    this.jumpPending = false;
    this.keys = new Set();
    this.kbSteer = false;
    this.touchId = null;
    this.heading = { x: 0, y: 1 };
    this.stride = 0;
    this.visualTime = 0;
    this.pulse = 0;
    this.deathAt = 0;
    this.lastScrollDelta = 0;
    this.cue = { text: '', until: 0 };
    this.attract = true;
    this.attractSeed = 1;
    this.mode = 'practice'; // or 'ranked'
    this.ranked = null;     // { token, runId, name }
    this.pendingFrames = null;
    this.submitState = 'idle'; // idle|submitting|accepted|failed|ineligible|local
    this.submitResult = null;
    this.apiBase = null;
    this.interrupted = false;
    this.cssW = 1; this.cssH = 1;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.best = 0;
    try { this.best = Number(localStorage.getItem('nightshift-best') || 0) || 0; } catch {}
  }

  async init() {
    const canvas = $('game-canvas');
    try {
      this.renderer = new Renderer(canvas);
    } catch (e) {
      $('fatal').hidden = false;
      $('fatal').textContent = 'This browser could not start WebGL2, which Nightshift needs to render the city.';
      throw e;
    }
    try {
      const district = await fetch('./data/greyhaven.json').then((r) => r.json());
      this.renderer.setDistrict(district);
    } catch { /* defaults stand */ }
    const config = await loadConfig();
    this.apiBase = safeApiBase(config.apiBase ?? config.apiBaseUrl);

    this.sim = await loadSim(createSim, false);
    this.handle = this.sim.create(1);
    this.resetAttract();

    try {
      const saved = localStorage.getItem('nightshift-name') || '';
      if (saved) $('player-name').value = saved;
    } catch {}
    this.sfx.enabled ? $('sound-btn').textContent = 'SOUND ON' : $('sound-btn').textContent = 'SOUND OFF';

    this.bindInput();
    this.bindUi();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.showScreen('menu');
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    if (this.apiBase) void this.refreshBoard();
  }

  // --- screens ----------------------------------------------------------
  showScreen(name) {
    this.screen = name;
    for (const s of ['menu', 'pause', 'over']) $(`screen-${s}`).hidden = s !== name;
    $('hud').hidden = name !== 'running';
  }

  setCue(text, seconds = 1.2) {
    this.cue = { text, until: this.visualTime + seconds };
  }

  // --- run lifecycle ----------------------------------------------------
  resetAttract() {
    this.attract = true;
    this.attractSeed = (this.attractSeed * 1103515245 + 12345) >>> 0;
    this.sim.reset(this.handle, this.attractSeed || 1);
    this.prev = this.curr = this.sim.snapshot(this.handle);
    this.target = { x: 0, y: -3500 };
  }

  startPlay({ mode, seed, ranked = null }) {
    this.sfx.ensure();
    this.attract = false;
    this.mode = mode;
    this.ranked = ranked;
    this.pendingFrames = null;
    this.submitState = 'idle';
    this.submitResult = null;
    this.sim.reset(this.handle, seed >>> 0);
    this.prev = this.curr = this.sim.snapshot(this.handle);
    this.target = { x: 0, y: -3500 };
    this.jumpPending = false;
    this.touchId = null;
    this.kbSteer = false;
    this.keys.clear();
    this.heading = { x: 0, y: 1 };
    this.stride = 0;
    this.acc = 0;
    this.interrupted = false;
    this.setCue('SHIFT STARTED — find your line', 2);
    this.sfx.start();
    this.showScreen('running');
  }

  async startPractice() {
    this.sfx.click();
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.startPlay({ mode: 'practice', seed });
  }

  async startRanked() {
    this.sfx.click();
    const name = $('player-name').value.trim();
    if (!NAME_RE.test(name)) {
      this.setMenuStatus('Display name must be 3–16 characters: letters, numbers, spaces, _ or -.');
      return;
    }
    if (!this.apiBase) {
      this.setMenuStatus('Shared scores are not configured for this copy of the game. Practice is available.');
      return;
    }
    this.setMenuStatus('Registering courier…');
    $('ranked-btn').disabled = true;
    try {
      const token = await registerPlayer(this.apiBase, name);
      try { localStorage.setItem('nightshift-name', name); } catch {}
      this.setMenuStatus('Requesting a ranked shift…');
      const run = await issueRun(this.apiBase, token);
      this.startPlay({ mode: 'ranked', seed: run.seed, ranked: { token, runId: run.runId, name } });
      this.setMenuStatus('');
    } catch (e) {
      this.setMenuStatus(`Could not start a ranked shift: ${e.message}`);
    } finally {
      $('ranked-btn').disabled = false;
    }
  }

  setMenuStatus(text) { $('menu-status').textContent = text || ''; }

  onDeath() {
    this.deathAt = this.visualTime;
    this.sfx.crash();
    this.setCue('COURIER DOWN — one more shift?', 3);
    if (this.curr.score > this.best) {
      this.best = this.curr.score;
      try { localStorage.setItem('nightshift-best', String(this.best)); } catch {}
    }
    this.showScreen('over');
    this.renderOver();
    if (this.mode === 'ranked' && this.ranked) void this.submitScore();
    else {
      this.submitState = 'local';
      this.renderOver();
    }
  }

  async submitScore() {
    const { eligible, frames } = this.sim.segments(this.handle);
    if (!eligible || !frames.length) {
      this.submitState = 'ineligible';
      this.renderOver();
      return;
    }
    this.pendingFrames = frames;
    this.submitState = 'submitting';
    this.renderOver();
    try {
      const result = await submitRun(this.apiBase, this.ranked.token, this.ranked.runId, frames);
      this.submitResult = result;
      this.submitState = 'accepted';
    } catch (e) {
      this.submitState = 'failed';
      this.submitError = e.message;
    }
    this.renderOver();
  }

  async retrySubmit() {
    if (!this.pendingFrames || !this.ranked) return;
    this.sfx.click();
    this.submitState = 'submitting';
    this.renderOver();
    try {
      const result = await submitRun(this.apiBase, this.ranked.token, this.ranked.runId, this.pendingFrames);
      this.submitResult = result;
      this.submitState = 'accepted';
    } catch (e) {
      this.submitState = 'failed';
      this.submitError = e.message;
    }
    this.renderOver();
  }

  renderOver() {
    const c = this.curr;
    $('over-stats').textContent =
      `${c.score.toLocaleString()} points • ${secondsLabel(c.tick)} • ${c.pickupsCollected} signals • ${c.nearMisses} close calls`;
    const el = $('over-status');
    let text = '';
    if (this.mode === 'practice') {
      text = `Practice result — stored locally, never uploaded. Personal best: ${this.best.toLocaleString()}.`;
    } else if (this.submitState === 'submitting') {
      text = 'Uploading the run for verification…';
    } else if (this.submitState === 'accepted' && this.submitResult) {
      text = `Verified by the city: ${this.submitResult.score.toLocaleString()} points — rank #${this.submitResult.rank} of the shared board.`;
    } else if (this.submitState === 'failed') {
      text = `Upload failed (${this.submitError || 'network'}). Your run is kept — retry the same upload.`;
    } else if (this.submitState === 'ineligible') {
      text = 'Upload limit reached — kept as a local result.';
    }
    el.textContent = text;
    $('retry-upload-btn').hidden = this.submitState !== 'failed';
    $('over-again').textContent = this.mode === 'ranked' ? 'ANOTHER RANKED SHIFT' : 'RUN IT AGAIN';
  }

  pause(reason) {
    if (this.screen !== 'running') return;
    this.screen = 'pause';
    this.acc = 0;
    this.alpha = 1;
    this.prev = this.curr;
    this.touchId = null;
    this.jumpPending = false;
    this.kbSteer = false;
    $('pause-reason').textContent = reason || 'Paused. Resume when ready.';
    this.showScreen('pause');
  }

  resume() {
    if (this.screen !== 'pause') return;
    this.sfx.click();
    if (document.visibilityState !== 'visible' || !document.hasFocus()) {
      $('pause-reason').textContent = 'The window must be focused before you resume.';
      return;
    }
    this.interrupted = false;
    this.acc = 0;
    this.prev = this.curr;
    this.showScreen('running');
  }

  toMenu() {
    this.sfx.click();
    this.ranked = null;
    this.resetAttract();
    this.setMenuStatus('');
    this.showScreen('menu');
    if (this.apiBase) void this.refreshBoard();
  }

  // --- fixed-timestep loop ----------------------------------------------
  frame(now) {
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (this.screen === 'running') {
      // Mirrors FixedClock: stall time is dropped, never more than 0.1s
      // (six ticks) of catch-up per render frame.
      this.acc += Math.min(dt, 0.1);
      let guard = 0;
      while (this.acc >= TICK && this.screen === 'running' && guard < 8) {
        this.acc -= TICK;
        guard++;
        this.stepOnce();
      }
      this.alpha = this.screen === 'running' ? Math.min(1, this.acc / TICK) : 1;
      this.visualTime += dt;
      this.pulse = Math.max(0, this.pulse - dt * 2.5);
    } else if (this.screen === 'menu' && this.attract) {
      // Attract mode: the city scrolls behind the menu with a wandering cat.
      this.acc += Math.min(dt, 0.1);
      let guard = 0;
      while (this.acc >= TICK && guard < 8) {
        this.acc -= TICK;
        guard++;
        const t = this.curr.tick;
        const tx = Math.sin(t * 0.011) * 4200;
        this.prev = this.curr;
        this.curr = this.sim.step(this.handle, Math.round(tx), -3500, false);
        this.lastScrollDelta = this.curr.distance - this.prev.distance;
        if (this.curr.dead) this.resetAttract();
      }
      this.alpha = 1;
      this.visualTime += dt;
    }
    this.render();
    this.updateHud();
    requestAnimationFrame((t) => this.frame(t));
  }

  stepOnce() {
    const p = this.curr.player;
    let tx = this.target.x, ty = this.target.y;
    // Keyboard steering alternative (mirrors ANightshiftController).
    const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) -
               (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
    const ky = (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0) -
               (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0);
    if (kx !== 0 || ky !== 0) {
      const n = Math.hypot(kx, ky);
      tx = clampInt(p.x + (kx / n) * 2400, -8400, 8400);
      ty = clampInt(p.y + (ky / n) * 2400, -6500, 6500);
      this.kbSteer = true;
    } else if (this.kbSteer) {
      tx = p.x; ty = p.y;
      this.kbSteer = false;
    }
    // While airborne on touch, the aim target stays near the cat.
    if (this.touchId !== null && p.airborne) {
      const dx = tx - p.x, dy = ty - p.y;
      const d = Math.hypot(dx, dy);
      if (d > 1400) { tx = clampInt(p.x + (dx / d) * 1400, -8400, 8400); ty = clampInt(p.y + (dy / d) * 1400, -6500, 6500); }
    }
    this.target.x = tx; this.target.y = ty;
    const jump = this.jumpPending;
    this.jumpPending = false; // edge: exactly one tick, like ConsumeInput
    this.prev = this.curr;
    this.curr = this.sim.step(this.handle, tx, ty, jump);
    const fwd = (this.curr.distance - this.prev.distance) + (this.curr.player.y - this.prev.player.y);
    const side = this.curr.player.x - this.prev.player.x;
    this.lastScrollDelta = this.curr.distance - this.prev.distance;
    this.stride += TICK * Math.min(4, Math.max(0, Math.hypot(fwd, side) / 65)) * 13;
    if (p.vx !== 0 || p.vy !== 0) {
      const s = Math.hypot(p.vx, p.vy);
      this.heading = { x: p.vx / s, y: p.vy / s };
    }
    for (const e of this.curr.events) this.onEvent(e);
    if (this.curr.dead) this.onDeath();
  }

  onEvent(e) {
    switch (e.kind) {
      case EventKind.Pickup:
        this.sfx.pickup(this.curr.combo);
        this.setCue(`SIGNAL +${e.value.toLocaleString()}`);
        break;
      case EventKind.NearMiss:
        this.sfx.nearMiss();
        this.setCue(`CLOSE CALL +${e.value.toLocaleString()}`);
        break;
      case EventKind.Jump: this.sfx.jump(); break;
      case EventKind.Land: this.sfx.land(); break;
      case EventKind.Tier:
        this.sfx.tier();
        this.setCue('TRAFFIC INTENSIFYING', 2);
        break;
      case EventKind.Crash: break; // handled by onDeath
    }
    this.pulse = 1;
  }

  // --- rendering / HUD ----------------------------------------------------
  render() {
    if (!this.curr) return;
    this.renderer.render({
      prev: this.prev, curr: this.curr, alpha: this.alpha,
      targetX: this.screen === 'running' ? this.target.x : 0,
      targetY: this.screen === 'running' ? this.target.y : -3500,
      visualTime: this.visualTime, pulse: this.pulse,
      stride: this.stride, scrollDelta: this.lastScrollDelta,
      deathAt: this.deathAt, reducedMotion: this.reducedMotion,
    });
  }

  updateHud() {
    if (this.screen !== 'running' || !this.curr) return;
    const c = this.curr;
    $('hud-score').textContent =
      `NIGHTSHIFT ${c.score.toLocaleString()} PTS ×${c.combo}`;
    $('hud-sub').textContent =
      `${secondsLabel(c.tick)} • ${this.renderer.phaseName(c.tick)}`;
    let cue = this.cue.text;
    if (!cue || this.visualTime > this.cue.until) {
      const p = c.player;
      cue = p.airborne ? 'AIRBORNE' : p.jumpCooldown > 0 ? 'LANDING — jump recharging' : 'JUMP READY';
      if (this.mode === 'ranked' && !this.sim.eligible(this.handle)) {
        cue = 'Upload limit reached — continuing as a local result';
      }
    }
    $('hud-cue').textContent = cue;
    $('hud-cue').classList.toggle('on', cue.length > 0);
  }

  // --- input --------------------------------------------------------------
  screenToWorld(clientX, clientY) {
    const v = this.renderer.view;
    const dpr = v.w / this.cssW;
    const mmPerCssPx = dpr / v.scale;
    return {
      x: clampInt((clientX - this.cssW / 2) * mmPerCssPx + v.cx, -8400, 8400),
      y: clampInt((this.cssH / 2 - clientY) * mmPerCssPx + v.cy, -6500, 6500),
    };
  }

  aimAt(clientX, clientY) {
    const w = this.screenToWorld(clientX, clientY);
    this.target.x = w.x;
    this.target.y = w.y;
    this.kbSteer = false;
  }

  focusLost() {
    this.touchId = null;
    this.jumpPending = false;
    if (this.screen === 'running') {
      this.interrupted = true;
      this.pause('Input paused after focus loss. Resume when ready.');
    }
  }

  bindInput() {
    const canvas = $('game-canvas');
    // Focus-loss auto-pause bridge (mirrors Web/stream-input.js semantics).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.focusLost();
    });
    window.addEventListener('blur', () => this.focusLost());
    window.addEventListener('pagehide', () => this.focusLost());
    document.addEventListener('pointercancel', (e) => {
      if (e.pointerId === this.touchId) this.focusLost();
    });

    canvas.addEventListener('pointerdown', (e) => {
      this.sfx.ensure();
      if (this.screen !== 'running') return;
      if (e.pointerType === 'mouse') {
        if (e.button === 0) this.jumpPending = true;
        return;
      }
      if (this.touchId !== null) return; // only the primary touch steers
      this.touchId = e.pointerId;
      this.aimAt(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.screen !== 'running') return;
      if (e.pointerType === 'mouse' || e.pointerId === this.touchId) {
        this.aimAt(e.clientX, e.clientY);
      }
    });
    const endTouch = (e) => {
      if (e.pointerId !== this.touchId) return;
      this.touchId = null;
      if (this.screen !== 'running') return;
      // Release-to-jump with heading continuation (mirrors TouchEnd).
      const p = this.curr.player;
      this.target.x = clampInt(p.x + this.heading.x * 1800, -8400, 8400);
      this.target.y = clampInt(p.y + this.heading.y * 1800, -6500, 6500);
      this.jumpPending = true;
    };
    canvas.addEventListener('pointerup', endTouch);
    // pointercancel on the active touch pauses (handled above via focusLost).

    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright') {
        e.preventDefault();
      }
      if (e.repeat) return;
      if (k === ' ') {
        if (this.screen === 'running') { this.jumpPending = true; this.sfx.ensure(); }
        else if (this.screen === 'menu') void this.startPractice();
      } else if (k === 'escape') {
        if (this.screen === 'running') this.pause('Paused. Resume when ready.');
        else if (this.screen === 'pause') this.resume();
      } else if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        this.keys.add(k);
      } else if (k === 'enter' && this.screen === 'menu' && document.activeElement === $('player-name')) {
        void this.startRanked();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  bindUi() {
    $('practice-btn').addEventListener('click', () => void this.startPractice());
    $('ranked-btn').addEventListener('click', () => void this.startRanked());
    $('resume-btn').addEventListener('click', () => this.resume());
    $('quit-btn').addEventListener('click', () => this.toMenu());
    $('over-menu-btn').addEventListener('click', () => this.toMenu());
    $('over-practice-btn').addEventListener('click', () => void this.startPractice());
    $('over-again').addEventListener('click', () => {
      if (this.mode === 'ranked' && this.ranked) {
        // A fresh ranked shift needs a fresh server-issued seed.
        // Capture the name BEFORE toMenu() clears this.ranked.
        const name = this.ranked.name;
        this.sfx.click();
        this.toMenu();
        $('player-name').value = name;
        void this.startRanked();
      } else void this.startPractice();
    });
    $('retry-upload-btn').addEventListener('click', () => void this.retrySubmit());
    $('pause-btn').addEventListener('click', () => {
      if (this.screen === 'running') this.pause('Paused. Resume when ready.');
    });
    $('sound-btn').addEventListener('click', () => {
      const on = this.sfx.toggle();
      $('sound-btn').textContent = on ? 'SOUND ON' : 'SOUND OFF';
      if (on) this.sfx.click();
    });
    $('board-btn').addEventListener('click', () => {
      this.sfx.click();
      const open = $('board-panel').hidden;
      $('board-panel').hidden = !open;
      if (open) void this.refreshBoard();
    });
  }

  async refreshBoard() {
    const state = $('board-state');
    if (!this.apiBase) {
      state.textContent = 'Shared scores are not configured for this copy of the game.';
      return;
    }
    state.textContent = 'Reading the Greyhaven signal…';
    try {
      const entries = await fetchBoard(this.apiBase, 50);
      const body = $('board-entries');
      body.replaceChildren();
      if (!entries.length) {
        state.textContent = 'No ranked runs yet. The first signal is still waiting.';
        return;
      }
      for (const e of entries) {
        const tr = document.createElement('tr');
        if (e.rank <= 10) tr.classList.add('top-ten');
        if (e.rank <= 3) tr.classList.add(`place-${e.rank}`);
        const rank = document.createElement('td');
        rank.innerHTML = e.rank === 1 ? '<span class="podium podium--gold">GOLD</span>'
          : e.rank === 2 ? '<span class="podium podium--silver">SILVER</span>'
          : e.rank === 3 ? '<span class="podium podium--bronze">BRONZE</span>'
          : `<span class="rank-number">${e.rank}</span>`;
        const name = document.createElement('th');
        name.scope = 'row';
        name.textContent = e.name;
        tr.append(rank, name);
        for (const v of [e.score.toLocaleString(), secondsLabel(e.ticks),
                         e.pickups.toLocaleString(), e.nearMisses.toLocaleString()]) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.append(td);
        }
        body.append(tr);
      }
      $('board-scroll').hidden = false;
      state.hidden = true;
    } catch {
      state.hidden = false;
      state.textContent = 'The shared scores could not be reached.';
    }
  }

  resize() {
    this.cssW = window.innerWidth;
    this.cssH = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.resize(this.cssW, this.cssH, dpr);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const game = new Game();
  game.init().catch((e) => {
    console.error(e);
    $('fatal').hidden = false;
    $('fatal').textContent = `Nightshift could not start: ${e.message}`;
  });
});
