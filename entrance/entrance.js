const FULL_TURN = Math.PI * 2;

function wrappedDelta(next, previous) {
  let delta = next - previous;
  while (delta > Math.PI) delta -= FULL_TURN;
  while (delta < -Math.PI) delta += FULL_TURN;
  return delta;
}

export class RewindGesture {
  constructor({ threshold = Math.PI * 5 / 3, minimumRadius = 18 } = {}) {
    this.threshold = threshold;
    this.minimumRadius = minimumRadius;
    this.cancel();
  }

  start({ x, y }) {
    const radius = Math.hypot(x, y);
    this.cancel();
    if (!Number.isFinite(radius) || radius < this.minimumRadius) return false;
    this.active = true;
    this.previousAngle = Math.atan2(y, x);
    this.samples = 1;
    return true;
  }

  move({ x, y }) {
    if (!this.active || this.activated) return false;
    const radius = Math.hypot(x, y);
    if (!Number.isFinite(radius) || radius < this.minimumRadius * 0.55) {
      this.cancel();
      return false;
    }
    const angle = Math.atan2(y, x);
    const delta = wrappedDelta(angle, this.previousAngle);
    this.previousAngle = angle;
    this.samples += 1;
    if (delta < 0) this.progress += -delta;
    else this.progress = Math.max(0, this.progress - delta * 1.5);
    if (this.progress >= this.threshold && this.samples >= 5) {
      this.activated = true;
      return true;
    }
    return false;
  }

  end() { this.cancel(); }

  cancel() {
    this.active = false;
    this.activated = false;
    this.previousAngle = 0;
    this.progress = 0;
    this.samples = 0;
  }
}

export function keyboardActivation(event) {
  return event.key === 'Enter' && event.repeat !== true;
}

function configuredDestination(value, base) {
  if (!value) return null;
  try {
    const destination = new URL(value, base);
    if (destination.origin === new URL(base).origin || destination.protocol === 'https:' ||
        (destination.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname))) {
      return destination.href;
    }
  } catch { /* inactive configuration */ }
  return null;
}

export function installRewindEntrance(element, options = {}) {
  const windowObject = options.window ?? window;
  const destination = configuredDestination(element.dataset.nightshiftUrl, windowObject.location.href);
  if (!destination) return () => {};
  element.hidden = false;
  const dial = element.querySelector('[data-rewind-dial]');
  if (!dial) throw new Error('Nightshift entrance is missing its rewind dial');
  const gesture = new RewindGesture();
  let pointerId = null;

  const localPoint = (event) => {
    const bounds = dial.getBoundingClientRect();
    return { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 };
  };
  const activate = () => {
    element.classList.add('nightshift-entrance--opening');
    windowObject.location.assign(destination);
  };
  const pointerDown = (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0) || pointerId !== null) return;
    if (!gesture.start(localPoint(event))) return;
    pointerId = event.pointerId;
    dial.setPointerCapture?.(pointerId);
  };
  const pointerMove = (event) => {
    if (event.pointerId !== pointerId) return;
    if (gesture.move(localPoint(event))) activate();
    if (gesture.progress > 0.35) event.preventDefault();
  };
  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    if (dial.hasPointerCapture?.(pointerId)) dial.releasePointerCapture(pointerId);
    pointerId = null;
    gesture.end();
  };
  const keyDown = (event) => {
    if (!keyboardActivation(event)) return;
    event.preventDefault();
    activate();
  };
  dial.addEventListener('pointerdown', pointerDown);
  dial.addEventListener('pointermove', pointerMove, { passive: false });
  dial.addEventListener('pointerup', finish);
  dial.addEventListener('pointercancel', finish);
  dial.addEventListener('lostpointercapture', finish);
  dial.addEventListener('keydown', keyDown);

  return () => {
    dial.removeEventListener('pointerdown', pointerDown);
    dial.removeEventListener('pointermove', pointerMove);
    dial.removeEventListener('pointerup', finish);
    dial.removeEventListener('pointercancel', finish);
    dial.removeEventListener('lostpointercapture', finish);
    dial.removeEventListener('keydown', keyDown);
    pointerId = null;
    gesture.cancel();
  };
}

if (typeof document !== 'undefined') {
  for (const element of document.querySelectorAll('[data-nightshift-entrance]')) installRewindEntrance(element);
}
