/**
 * Synthetic MediaPipe hand landmarks for unit tests.
 * The geometry is simplified but obeys the same rules the gesture engine uses:
 * an extended fingertip is farther from the wrist than its PIP joint, and the
 * pinch ratio is the thumb-tip/index-tip gap divided by the wrist/middle-MCP gap.
 */

const FINGERS = [
  { mcp: 5, pip: 6, dip: 7, tip: 8, x: 0.44, y: 0.6 },
  { mcp: 9, pip: 10, dip: 11, tip: 12, x: 0.5, y: 0.6 },
  { mcp: 13, pip: 14, dip: 15, tip: 16, x: 0.56, y: 0.61 },
  { mcp: 17, pip: 18, dip: 19, tip: 20, x: 0.61, y: 0.64 }
];

export function makeHand({
  extended = [true, true, true, true],
  pinch = false,
  gap = 0.01,
  tipX = null,
  xOffset = 0,
  yOffset = 0
} = {}) {
  const landmarks = new Array(21);
  const shift = (x, y) => ({ x: x + xOffset, y: y + yOffset });

  landmarks[0] = shift(0.5, 0.9);   // wrist
  landmarks[1] = shift(0.4, 0.82);  // thumb
  landmarks[2] = shift(0.33, 0.73);
  landmarks[3] = shift(0.27, 0.64);

  for (let i = 0; i < FINGERS.length; i += 1) {
    const finger = FINGERS[i];
    const up = Boolean(extended[i]);
    landmarks[finger.mcp] = shift(finger.x, finger.y);
    if (up) {
      landmarks[finger.pip] = shift(finger.x, finger.y - 0.12);
      landmarks[finger.dip] = shift(finger.x, finger.y - 0.21);
      const x = finger.tip === 8 && tipX !== null ? tipX : finger.x;
      landmarks[finger.tip] = shift(x, finger.y - 0.3);
    } else {
      landmarks[finger.pip] = shift(finger.x, finger.y - 0.06);
      landmarks[finger.dip] = shift(finger.x, finger.y - 0.03);
      landmarks[finger.tip] = shift(finger.x, finger.y);
    }
  }

  landmarks[4] = pinch
    ? { x: landmarks[8].x + gap, y: landmarks[8].y }
    : shift(0.18, 0.54);

  return landmarks;
}

export const openHand = (options = {}) => makeHand({ ...options, extended: [true, true, true, true] });
export const pointHand = (options = {}) => makeHand({ ...options, extended: [true, false, false, false] });
export const pinchHand = (options = {}) => makeHand({ ...options, extended: [true, false, false, false], pinch: true });
export const fistHand = (options = {}) => makeHand({ ...options, extended: [false, false, false, false] });
export const scrollHand = (options = {}) => makeHand({ ...options, extended: [true, true, false, false] });

/**
 * Simulates the same hand closer to or farther from the camera by scaling all
 * landmarks around a fixed point. Motion offsets need to be scaled with it.
 */
export function scaleHand(landmarks, factor, center = { x: 0.5, y: 0.5 }) {
  return landmarks.map((point) => ({
    x: center.x + (point.x - center.x) * factor,
    y: center.y + (point.y - center.y) * factor
  }));
}
