import { OneEuroFilter } from './one-euro.mjs';

export const GESTURE_VERSION = '2.4.0';
export const PINCH_ON = 0.3;
export const PINCH_OFF = 0.46;
export const CLICK_COOLDOWN_MS = 320;

// Dwell-to-click: holding a still point over a target clicks it. The duration
// is a user setting, so the bounds live here and the panel reuses them.
export const DWELL_DEFAULT_MS = 800;
export const DWELL_MIN_MS = 400;
export const DWELL_MAX_MS = 1500;

export function normalizeDwellMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return DWELL_DEFAULT_MS;
  return Math.round(Math.min(DWELL_MAX_MS, Math.max(DWELL_MIN_MS, ms)));
}

// One "hand width" of vertical travel maps to this much scroll offset. Hand
// width normalisation keeps the scroll speed the same at any camera distance.
const SCROLL_UNIT = 0.18;

/**
 * Validates thresholds captured by the side-panel calibration flow. Anything
 * malformed falls back to the defaults so a bad stored value cannot break the
 * gesture engine.
 */
export function normalizePinchCalibration(value) {
  if (!value || typeof value !== 'object') return null;
  const on = Number(value.pinchOn);
  const off = Number(value.pinchOff);
  if (!Number.isFinite(on) || !Number.isFinite(off)) return null;
  if (on < 0.12 || on > 0.55 || off < on + 0.05 || off > 0.8) return null;
  return { pinchOn: on, pinchOff: off };
}

const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * Turns the ratios measured during calibration into click/release thresholds.
 * The click point sits just above the pinched ratio and the release point well
 * into the opening motion, so a relaxed hand never registers as a click.
 */
export function derivePinchCalibration(openRatio, closedRatio, handWidth = NaN) {
  if (!Number.isFinite(openRatio) || !Number.isFinite(closedRatio)) return null;
  if (!(openRatio >= 0.6 && closedRatio <= 0.45 && openRatio - closedRatio >= 0.18)) return null;

  const spread = openRatio - closedRatio;
  const pinchOn = Math.min(0.55, Math.max(closedRatio + 0.05, closedRatio + spread * 0.35));
  const upper = Math.min(0.75, openRatio - 0.05);
  if (pinchOn + 0.06 > upper) return null;
  const pinchOff = Math.max(pinchOn + 0.06, Math.min(upper, closedRatio + spread * 0.7));

  return {
    pinchOn: round3(pinchOn),
    pinchOff: round3(pinchOff),
    openRatio: round3(openRatio),
    closedRatio: round3(closedRatio),
    handWidth: Number.isFinite(handWidth) && handWidth > 0 ? round3(handWidth) : null
  };
}

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

export const POSE_LABELS = {
  none: 'No hand',
  idle: 'Open hand',
  point: 'Pointing',
  click: 'Pinch',
  drag: 'Fist',
  scroll: 'Two fingers'
};

/**
 * How much of the camera frame maps to the whole screen. A smaller zone means
 * the cursor crosses the screen with less arm movement (faster but twitchier).
 */
export const REACH_PRESETS = {
  compact: { x0: 0.24, x1: 0.76, y0: 0.18, y1: 0.66 },
  balanced: { x0: 0.16, x1: 0.84, y0: 0.1, y1: 0.72 },
  wide: { x0: 0.08, x1: 0.92, y0: 0.05, y1: 0.8 }
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function fingerExtended(landmarks, tip, pip) {
  return distance(landmarks[tip], landmarks[0]) > distance(landmarks[pip], landmarks[0]) * 1.02;
}

export function pinchRatio(landmarks) {
  const scale = distance(landmarks[0], landmarks[9]) || 1e-3;
  return distance(landmarks[4], landmarks[8]) / scale;
}

function mapAxis(value, lo, hi) {
  return clamp01((value - lo) / (hi - lo));
}

function smoothingCutoff(smoothing) {
  const amount = clamp01(Number(smoothing) / 100);
  return 4.5 - 3.6 * amount;
}

/**
 * Turns MediaPipe hand landmarks into cursor and gesture frames.
 * Pure logic: no DOM, no MediaPipe, no Chrome APIs, so it can be unit tested.
 */
export function createGestureEngine(options = {}) {
  const initialCalibration = normalizePinchCalibration(options.calibration);
  const engine = {
    version: GESTURE_VERSION,
    reach: options.reach in REACH_PRESETS ? options.reach : 'balanced',
    smoothing: Number.isFinite(options.smoothing) ? options.smoothing : 35,
    mirror: options.mirror !== false,
    pinchOn: initialCalibration ? initialCalibration.pinchOn : PINCH_ON,
    pinchOff: initialCalibration ? initialCalibration.pinchOff : PINCH_OFF,

    pose: 'none',
    candidate: 'none',
    candidateFrames: 0,
    pinchActive: false,
    suppressClick: true,
    lastClickAt: null,
    lock: null,
    history: [],
    lastOutput: null,
    lastSeen: 0,
    scrollAnchorY: null,
    scrollWidth: 0,

    fx: new OneEuroFilter({ minCutoff: smoothingCutoff(options.smoothing ?? 35), beta: 1.2 }),
    fy: new OneEuroFilter({ minCutoff: smoothingCutoff(options.smoothing ?? 35), beta: 1.2 }),
    palmX: new OneEuroFilter({ minCutoff: smoothingCutoff(options.smoothing ?? 35), beta: 1.5 }),
    palmY: new OneEuroFilter({ minCutoff: smoothingCutoff(options.smoothing ?? 35), beta: 1.5 }),
    scrollFilter: new OneEuroFilter({ minCutoff: 2.5, beta: 1.5 }),

    configure(next = {}) {
      if (next.reach in REACH_PRESETS) this.reach = next.reach;
      if (Number.isFinite(next.smoothing)) this.smoothing = next.smoothing;
      if (typeof next.mirror === 'boolean') this.mirror = next.mirror;
      if ('calibration' in next) {
        const calibration = normalizePinchCalibration(next.calibration);
        this.pinchOn = calibration ? calibration.pinchOn : PINCH_ON;
        this.pinchOff = calibration ? calibration.pinchOff : PINCH_OFF;
        this.pinchActive = false;
        this.suppressClick = true;
        this.lastClickAt = null;
        this.lock = null;
      }

      const cutoff = smoothingCutoff(this.smoothing);
      for (const filter of [this.fx, this.fy, this.palmX, this.palmY]) {
        filter.configure({ minCutoff: cutoff, beta: filter === this.palmX || filter === this.palmY ? 1.5 : 1.2 });
        filter.reset();
      }
      this.history = [];
      this.lastOutput = null;
      this.lock = null;
      this.scrollAnchorY = null;
      this.scrollWidth = 0;
      this.scrollFilter.reset();
    },

    reset() {
      this.pose = 'none';
      this.candidate = 'none';
      this.candidateFrames = 0;
      this.pinchActive = false;
      this.suppressClick = true;
      this.lastClickAt = null;
      this.lock = null;
      this.history = [];
      this.lastOutput = null;
      this.lastSeen = 0;
      this.scrollAnchorY = null;
      this.scrollWidth = 0;
      for (const filter of [this.fx, this.fy, this.palmX, this.palmY, this.scrollFilter]) filter.reset();
    },

    update(landmarks, timestampMs = Date.now()) {
      if (!landmarks || landmarks.length < 21) {
        this.pose = 'none';
        this.candidate = 'none';
        this.candidateFrames = 0;
        this.pinchActive = false;
        this.suppressClick = true;
        this.lock = null;
        this.history = [];
        this.lastOutput = null;
        this.scrollAnchorY = null;
        this.scrollWidth = 0;
        for (const filter of [this.fx, this.fy, this.palmX, this.palmY, this.scrollFilter]) filter.reset();
        return {
          version: this.version,
          handPresent: false,
          pose: 'none',
          x: 0.5,
          y: 0.5,
          palmX: 0.5,
          palmY: 0.5,
          scrollY: 0.5,
          pinchRatio: 0,
          handWidth: 0,
          raw: 'none',
          at: timestampMs
        };
      }

      this.lastSeen = timestampMs;
      const zone = REACH_PRESETS[this.reach];
      const lm = landmarks;
      const scale = distance(lm[0], lm[9]) || 1e-3;
      const ratio = distance(lm[4], lm[8]) / scale;

      const idx = fingerExtended(lm, 8, 6);
      const mid = fingerExtended(lm, 12, 10);
      const ring = fingerExtended(lm, 16, 14);
      const pinky = fingerExtended(lm, 20, 18);
      const isFist = !idx && !mid && !ring && !pinky;

      // Hysteresis keeps the pinch from flickering around the threshold. A fist
      // always cancels the pinch, and after a fist the user must separate thumb
      // and index before a click can fire again (prevents drag -> click slips).
      if (isFist) {
        this.pinchActive = false;
        this.suppressClick = true;
      } else {
        const contact = ratio < (this.pinchActive ? this.pinchOff : this.pinchOn);
        this.pinchActive = contact;
        if (!contact) this.suppressClick = false;
      }

      const twoFinger = idx && mid && !ring && !pinky;

      let raw;
      if (isFist) raw = 'drag';
      else if (twoFinger) raw = 'scroll';
      else if (this.pinchActive && !this.suppressClick) raw = 'click';
      else if (idx && !mid) raw = 'point';
      else raw = 'idle';

      const threshold = raw === 'idle' || raw === 'scroll' ? 3 : 2;
      if (raw === this.candidate) this.candidateFrames += 1;
      else {
        this.candidate = raw;
        this.candidateFrames = 1;
      }

      const previousPose = this.pose;
      const coolingDown =
        raw === 'click' &&
        this.lastClickAt !== null &&
        timestampMs - this.lastClickAt < CLICK_COOLDOWN_MS;
      if (!coolingDown && this.candidateFrames >= threshold && this.pose !== raw) {
        this.pose = raw;
        if (this.pose === 'click') {
          const cutoff = timestampMs - 130;
          const recent = this.history.find((entry) => entry.t >= cutoff) || this.history[this.history.length - 1];
          this.lock = recent ? { x: recent.x, y: recent.y } : this.lastOutput ? { ...this.lastOutput } : null;
          this.lastClickAt = timestampMs;
        } else {
          this.lock = null;
        }
        if (this.pose === 'drag') {
          this.palmX.reset();
          this.palmY.reset();
        }
        if (this.pose === 'scroll') {
          this.scrollFilter.reset();
          this.scrollAnchorY = null;
          this.scrollWidth = 0;
        }
      }

      // Cursor target from the index fingertip, mirrored so your hand moves the
      // same way your reflection does.
      const indexX = this.mirror ? 1 - lm[8].x : lm[8].x;
      const px = this.fx.filter(mapAxis(indexX, zone.x0, zone.x1), timestampMs);
      const py = this.fy.filter(mapAxis(lm[8].y, zone.y0, zone.y1), timestampMs);

      // Palm is the stable point to drag with: a closed fist has no pointing tip.
      const palmRawX = this.mirror ? 1 - (lm[0].x + lm[9].x) / 2 : (lm[0].x + lm[9].x) / 2;
      const palmRawY = (lm[0].y + lm[9].y) / 2;
      const palmX = this.palmX.filter(mapAxis(palmRawX, zone.x0, zone.x1), timestampMs);
      const palmY = this.palmY.filter(mapAxis(palmRawY, zone.y0, zone.y1), timestampMs);

      this.history.push({ t: timestampMs, x: px, y: py });
      while (this.history.length > 24) this.history.shift();
      while (this.history.length && timestampMs - this.history[0].t > 600) this.history.shift();

      if (!this.lastOutput) this.lastOutput = { x: px, y: py };
      if (this.pose === 'point') this.lastOutput = { x: px, y: py };
      else if (this.pose === 'click' && this.lock) this.lastOutput = { ...this.lock };

      // Scroll distance is measured in hand widths, not camera pixels, so the
      // same wrist movement scrolls the same amount near or far from the lens.
      let scrollY = 0.5;
      if (this.pose === 'scroll') {
        const rawScrollY = (lm[8].y + lm[12].y) / 2;
        const filteredScrollY = this.scrollFilter.filter(rawScrollY, timestampMs);
        if (this.scrollAnchorY === null) {
          this.scrollAnchorY = filteredScrollY;
          this.scrollWidth = Math.max(scale, 0.06);
        }
        const offset = ((filteredScrollY - this.scrollAnchorY) / this.scrollWidth) * SCROLL_UNIT;
        scrollY = clamp01(0.5 + offset);
      } else {
        this.scrollAnchorY = null;
        this.scrollWidth = 0;
      }

      const useLive = this.pose === 'point';
      const output = useLive ? { x: px, y: py } : this.lastOutput;
      if (this.pose === 'click' && this.lock) {
        output.x = this.lock.x;
        output.y = this.lock.y;
      }

      return {
        version: this.version,
        handPresent: true,
        pose: this.pose,
        previousPose,
        x: clamp01(output.x),
        y: clamp01(output.y),
        palmX: clamp01(palmX),
        palmY: clamp01(palmY),
        scrollY,
        pinchRatio: ratio,
        handWidth: scale,
        raw,
        at: timestampMs
      };
    }
  };

  return engine;
}
