// api.js — Nightshift score-service client.
// Mirrors the validation in Web/nightshift.js: HTTPS endpoints only, with
// loopback HTTP allowed for local development. No bearer tokens in URLs.

export const RULESET = 'nightshift-v1';
export const NAME_RE = /^[A-Za-z0-9 _-]{3,16}$/;

let configPromise = null;
export function loadConfig() {
  if (!configPromise) {
    configPromise = fetch('./config.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return configPromise;
}

export function safeApiBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.href);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return url.href.replace(/\/$/, '') + '/';
  } catch {
    return null;
  }
}

async function postJson(base, path, body, token) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.error || `request failed (${response.status})`);
    err.code = payload.error;
    err.status = response.status;
    throw err;
  }
  return payload;
}

export async function registerPlayer(base, name) {
  if (!NAME_RE.test(name)) throw new Error('Display name must be 3–16 characters: letters, numbers, spaces, _ or -.');
  const { playerToken } = await postJson(base, 'api/player', { name });
  if (typeof playerToken !== 'string' || !playerToken) throw new Error('registration failed');
  return playerToken;
}

export async function issueRun(base, token) {
  const run = await postJson(base, 'api/run', {}, token);
  if (!run.runId || !Number.isSafeInteger(run.seed) || run.ruleset !== RULESET) {
    throw new Error('run issuance failed');
  }
  return run;
}

// frames: [[count,x,y,jump],...] in the exact replay-protocol shape the
// service validates. The server re-simulates with the native validator and
// never trusts the client score.
export async function submitRun(base, token, runId, frames) {
  const result = await postJson(base, 'api/submit', { runId, frames }, token);
  if (!result.accepted) throw new Error('submission rejected');
  return result; // { accepted, score, ticks, rank }
}

export async function fetchBoard(base, limit = 50) {
  const response = await fetch(`${base}api/leaderboard?limit=${limit}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error('leaderboard unavailable');
  const payload = await response.json();
  if (payload.ruleset !== RULESET || !Array.isArray(payload.entries)) {
    throw new Error('invalid leaderboard');
  }
  return payload.entries;
}

export function secondsLabel(ticks) {
  const total = Math.floor(ticks / 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
