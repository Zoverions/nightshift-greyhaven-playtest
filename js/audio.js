// audio.js — tiny synthesized WebAudio cues for Nightshift.
// No assets; every sound is an oscillator/noise envelope. The context is
// created lazily and resumed on the first user gesture (autoplay policy).

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.enabled = true;
    try {
      this.enabled = localStorage.getItem('nightshift-sound') !== 'off';
    } catch { /* private mode */ }
  }

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem('nightshift-sound', this.enabled ? 'on' : 'off'); } catch {}
    return this.enabled;
  }

  ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
      } catch {
        // No audio on this machine/browser: stay silent, never break the game.
        this.enabled = false;
        return null;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  tone({ freq = 440, freqEnd = null, dur = 0.12, type = 'sine', gain = 0.25, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  noise({ dur = 0.2, gain = 0.3, lowpass = 1200, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  click() { this.tone({ freq: 660, freqEnd: 520, dur: 0.06, type: 'triangle', gain: 0.18 }); }
  jump() { this.tone({ freq: 320, freqEnd: 720, dur: 0.16, type: 'square', gain: 0.12 }); }
  land() { this.noise({ dur: 0.09, gain: 0.16, lowpass: 700 }); }
  pickup(combo = 1) {
    const base = 620 + combo * 60;
    this.tone({ freq: base, dur: 0.09, type: 'sine', gain: 0.22 });
    this.tone({ freq: base * 1.5, dur: 0.12, type: 'sine', gain: 0.18, delay: 0.06 });
  }
  nearMiss() { this.noise({ dur: 0.18, gain: 0.2, lowpass: 3200 }); this.tone({ freq: 900, freqEnd: 1400, dur: 0.14, type: 'sawtooth', gain: 0.06 }); }
  crash() {
    this.noise({ dur: 0.5, gain: 0.4, lowpass: 900 });
    this.tone({ freq: 160, freqEnd: 40, dur: 0.45, type: 'sawtooth', gain: 0.22 });
  }
  hit() {
    // a lost life: a hard thud, lighter than the final crash
    this.noise({ dur: 0.25, gain: 0.32, lowpass: 700 });
    this.tone({ freq: 220, freqEnd: 70, dur: 0.28, type: 'sawtooth', gain: 0.18 });
  }
  dizzy() {
    // woozy warble: the pitch wobbles downward like cartoon dizziness
    const seq = [520, 440, 470, 380, 410, 320];
    seq.forEach((f, i) => this.tone({
      freq: f, freqEnd: f * 0.92, dur: 0.11, type: 'sine', gain: 0.16, delay: i * 0.09,
    }));
  }
  tier() {
    this.tone({ freq: 440, dur: 0.1, type: 'triangle', gain: 0.2 });
    this.tone({ freq: 660, dur: 0.12, type: 'triangle', gain: 0.2, delay: 0.09 });
  }
  start() {
    this.tone({ freq: 330, dur: 0.1, type: 'triangle', gain: 0.2 });
    this.tone({ freq: 495, dur: 0.14, type: 'triangle', gain: 0.2, delay: 0.1 });
  }
}
