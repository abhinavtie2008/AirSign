import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLICK_COOLDOWN_MS,
  createGestureEngine,
  derivePinchCalibration,
  fingerExtended,
  normalizePinchCalibration,
  pinchRatio,
  PINCH_OFF,
  PINCH_ON,
  REACH_PRESETS
} from '../lib/gestures.mjs';
import {
  fistHand,
  openHand,
  pinchHand,
  pointHand,
  scaleHand,
  scrollHand
} from './landmarks.mjs';

function feed(engine, hand, count, start, step = 33) {
  let frame = null;
  for (let i = 0; i < count; i += 1) frame = engine.update(hand, start + i * step);
  return frame;
}

test('landmark helpers follow the geometry the engine expects', () => {
  assert.equal(fingerExtended(openHand(), 8, 6), true);
  assert.equal(fingerExtended(fistHand(), 8, 6), false);

  const ratio = pinchRatio(pinchHand({ gap: 0.015 }));
  assert.ok(Math.abs(ratio - 0.05) < 1e-9);
  assert.ok(pinchRatio(openHand()) > 1);
});

test('an open hand is idle rather than a pointing gesture', () => {
  const engine = createGestureEngine();
  const first = engine.update(openHand(), 0);
  assert.equal(first.pose, 'none', 'pose changes need stable frames');

  const settled = feed(engine, openHand(), 3, 33);
  assert.equal(settled.pose, 'idle');
  assert.equal(settled.raw, 'idle');
  assert.equal(settled.handPresent, true);
});

test('pointing moves the cursor after two stable frames', () => {
  const engine = createGestureEngine();
  const hand = pointHand({ tipX: 0.5 });

  const first = engine.update(hand, 0);
  assert.equal(first.pose, 'none');

  const second = engine.update(hand, 33);
  assert.equal(second.pose, 'point');
  assert.ok(Math.abs(second.x - 0.5) < 1e-9);
  assert.ok(Math.abs(second.y - (0.3 - REACH_PRESETS.balanced.y0) / (REACH_PRESETS.balanced.y1 - REACH_PRESETS.balanced.y0)) < 1e-9);
});

test('a pinch that is already closed at startup cannot click', () => {
  const engine = createGestureEngine();
  const frame = feed(engine, pinchHand(), 5, 0);

  assert.equal(frame.pose, 'point');
  assert.equal(engine.pinchActive, true);
  assert.equal(engine.suppressClick, true);
  assert.equal(engine.lock, null);
});

test('pinching after opening the hand fires one click', () => {
  const engine = createGestureEngine();
  feed(engine, openHand(), 3, 0);

  const frame = feed(engine, pinchHand(), 2, 100);
  assert.equal(frame.pose, 'click');
  assert.equal(frame.previousPose, 'idle');
  assert.ok(engine.lock, 'click locks the cursor position');
  assert.equal(engine.suppressClick, false);
  assert.ok(frame.pinchRatio < PINCH_ON);
});

test('the click locks the cursor while the hand keeps moving', () => {
  const engine = createGestureEngine();
  feed(engine, openHand(), 3, 0);
  feed(engine, pointHand({ tipX: 0.3 }), 3, 100);
  feed(engine, pointHand({ tipX: 0.7 }), 4, 200);

  const clicked = feed(engine, pinchHand({ tipX: 0.7 }), 3, 400);
  assert.equal(clicked.pose, 'click');
  const lockedX = engine.lock.x;
  assert.equal(clicked.x, lockedX);

  const moved = feed(engine, pinchHand({ tipX: 0.2 }), 3, 500);
  assert.equal(moved.pose, 'click');
  assert.equal(moved.x, lockedX);
  assert.equal(engine.lock.x, lockedX);
});

test('a fist drags and suppresses the next click until the pinch is released', () => {
  const engine = createGestureEngine();
  feed(engine, openHand(), 3, 0);

  const dragged = feed(engine, fistHand(), 3, 100);
  assert.equal(dragged.pose, 'drag');
  assert.equal(engine.suppressClick, true);

  const pinchedTooSoon = feed(engine, pinchHand(), 4, 200);
  assert.notEqual(pinchedTooSoon.pose, 'click');
  assert.equal(pinchedTooSoon.pose, 'point');

  feed(engine, pointHand(), 2, 300);
  assert.equal(engine.suppressClick, false);

  const clicked = feed(engine, pinchHand(), 3, 400);
  assert.equal(clicked.pose, 'click');
});

test('pinch hysteresis holds through the release band and clears above it', () => {
  const engine = createGestureEngine();
  feed(engine, openHand(), 3, 0);

  const clicked = feed(engine, pinchHand({ gap: 0.03 }), 3, 100);
  assert.equal(clicked.pose, 'click');

  const bandFrame = feed(engine, pinchHand({ gap: 0.114 }), 2, 200);
  const bandRatio = pinchRatio(pinchHand({ gap: 0.114 }));
  assert.ok(bandRatio > PINCH_ON && bandRatio < PINCH_OFF);
  assert.equal(engine.pinchActive, true);
  assert.equal(bandFrame.pose, 'click');

  const released = feed(engine, pinchHand({ gap: 0.15 }), 2, 300);
  assert.ok(released.pinchRatio > PINCH_OFF);
  assert.equal(engine.pinchActive, false);
  assert.equal(released.pose, 'point');
});

test('two-finger scroll needs three frames and follows vertical hand movement', () => {
  const engine = createGestureEngine();
  const first = engine.update(scrollHand(), 1000);
  const second = engine.update(scrollHand(), 1033);
  assert.equal(first.pose, 'none');
  assert.equal(second.pose, 'none');

  const settled = engine.update(scrollHand(), 1066);
  assert.equal(settled.pose, 'scroll');
  const base = settled.scrollY;

  feed(engine, scrollHand({ yOffset: 0.06 }), 5, 1100);
  const moved = engine.update(scrollHand({ yOffset: 0.06 }), 1300);
  assert.equal(moved.pose, 'scroll');
  assert.ok(moved.scrollY > base + 0.005, `scrollY should rise (${base} -> ${moved.scrollY})`);
});

test('mirror and reach presets map the fingertip predictably', () => {
  const mirrored = createGestureEngine({ reach: 'compact', mirror: true });
  const mirroredFrame = feed(mirrored, pointHand({ tipX: 0.7 }), 3, 0);
  const compact = REACH_PRESETS.compact;
  assert.ok(Math.abs(mirroredFrame.x - (1 - 0.7 - compact.x0) / (compact.x1 - compact.x0)) < 1e-9);
  assert.ok(Math.abs(mirroredFrame.y - (0.3 - compact.y0) / (compact.y1 - compact.y0)) < 1e-9);

  const direct = createGestureEngine({ reach: 'compact', mirror: false });
  const directFrame = feed(direct, pointHand({ tipX: 0.7 }), 3, 0);
  assert.ok(Math.abs(directFrame.x - (0.7 - compact.x0) / (compact.x1 - compact.x0)) < 1e-9);
});

test('cursor positions clamp at the edges of the active zone', () => {
  const engine = createGestureEngine({ reach: 'compact', mirror: true });
  const frame = feed(engine, pointHand({ tipX: 0.95 }), 3, 0);
  assert.equal(frame.x, 0);
});

test('palm coordinates move with a dragging fist', () => {
  const engine = createGestureEngine();
  feed(engine, openHand(), 3, 0);
  const dragged = feed(engine, fistHand(), 3, 100);
  assert.equal(dragged.pose, 'drag');
  const basePalmX = dragged.palmX;

  const moved = feed(engine, fistHand({ xOffset: -0.05 }), 4, 200);
  assert.equal(moved.pose, 'drag');
  assert.ok(moved.palmX > basePalmX + 0.01, `palm should shift (${basePalmX} -> ${moved.palmX})`);
});

test('losing the hand resets the gesture and cursor state', () => {
  const engine = createGestureEngine();
  feed(engine, pointHand(), 3, 0);

  const frame = engine.update(null, 200);
  assert.equal(frame.handPresent, false);
  assert.equal(frame.pose, 'none');
  assert.equal(frame.x, 0.5);
  assert.equal(frame.y, 0.5);
  assert.equal(engine.pose, 'none');
  assert.equal(engine.pinchActive, false);
  assert.equal(engine.lastOutput, null);

  const afterGap = engine.update(openHand(), 300);
  assert.equal(afterGap.pose, 'none', 'the first frame after a dropout is not trusted');
});

test('configure updates tuning and clears smoothing history', () => {
  const engine = createGestureEngine({ smoothing: 35 });
  feed(engine, pointHand({ tipX: 0.5 }), 3, 0);

  engine.configure({ smoothing: 90, reach: 'wide', mirror: false });
  assert.equal(engine.smoothing, 90);
  assert.equal(engine.reach, 'wide');
  assert.equal(engine.mirror, false);
  assert.equal(engine.history.length, 0);
  assert.equal(engine.lastOutput, null);
});

test('calibration validation rejects unusable thresholds', () => {
  assert.equal(normalizePinchCalibration(null), null);
  assert.equal(normalizePinchCalibration({ pinchOn: 0.5, pinchOff: 0.4 }), null);
  assert.equal(normalizePinchCalibration({ pinchOn: 0.3, pinchOff: 0.32 }), null);

  const engine = createGestureEngine({ calibration: { pinchOn: 2, pinchOff: 3 } });
  assert.equal(engine.pinchOn, PINCH_ON);
  assert.equal(engine.pinchOff, PINCH_OFF);
});

test('calibration derives usable thresholds from open and pinched ratios', () => {
  const open = pinchRatio(openHand());
  const closed = pinchRatio(pinchHand({ gap: 0.015 }));
  const calibration = derivePinchCalibration(open, closed, 0.3);

  assert.ok(calibration);
  assert.ok(calibration.pinchOn > closed);
  assert.ok(calibration.pinchOff > calibration.pinchOn);
  assert.ok(calibration.pinchOn < open);
  assert.equal(calibration.handWidth, 0.3);

  const engine = createGestureEngine({ calibration });
  const idle = feed(engine, openHand(), 3, 0);
  assert.equal(idle.pose, 'idle');
  const clicked = feed(engine, pinchHand({ gap: 0.015 }), 2, 100);
  assert.equal(clicked.pose, 'click');

  assert.equal(derivePinchCalibration(0.7, 0.6), null, 'open and pinched are too close');
  assert.equal(derivePinchCalibration(0.5, 0.1), null, 'open ratio is implausibly small');
  assert.equal(derivePinchCalibration(1, 0.5), null, 'closed ratio is too high');
  assert.equal(derivePinchCalibration(NaN, 0.1), null);
});

test('calibrated pinch thresholds replace the defaults', () => {
  const calibration = { pinchOn: 0.42, pinchOff: 0.5 };
  const engine = createGestureEngine({ calibration });
  assert.equal(engine.pinchOn, 0.42);
  assert.equal(engine.pinchOff, 0.5);

  feed(engine, openHand(), 3, 0);
  const clicked = feed(engine, pinchHand({ gap: 0.114 }), 3, 100);
  assert.equal(clicked.pose, 'click');

  const band = feed(engine, pinchHand({ gap: 0.145 }), 2, 200);
  const bandRatio = pinchRatio(pinchHand({ gap: 0.145 }));
  assert.ok(bandRatio > 0.42 && bandRatio < 0.5);
  assert.equal(engine.pinchActive, true);
  assert.equal(band.pose, 'click');

  const released = feed(engine, pinchHand({ gap: 0.155 }), 2, 300);
  assert.equal(engine.pinchActive, false);
  assert.equal(released.pose, 'point');

  engine.configure({ calibration: null });
  assert.equal(engine.pinchOn, PINCH_ON);
  assert.equal(engine.pinchOff, PINCH_OFF);
});

test('a second pinch cannot click during the cooldown window', () => {
  const engine = createGestureEngine();
  feed(engine, openHand(), 3, 0);

  const clicked = feed(engine, pinchHand(), 2, 100);
  assert.equal(clicked.pose, 'click');
  const clickedAt = engine.lastClickAt;
  assert.ok(clickedAt >= 100);

  feed(engine, pointHand(), 3, 200);
  const tooSoon = feed(engine, pinchHand(), 2, 300);
  assert.ok(300 - clickedAt < CLICK_COOLDOWN_MS);
  assert.notEqual(tooSoon.pose, 'click');

  const afterCooldown = feed(engine, pinchHand(), 8, clickedAt + CLICK_COOLDOWN_MS);
  assert.equal(afterCooldown.pose, 'click');
});

test('scroll travel is normalised across camera distances', () => {
  const run = (factor) => {
    const engine = createGestureEngine();
    const base = scaleHand(scrollHand(), factor);
    const moved = scaleHand(scrollHand({ yOffset: 0.06 }), factor);
    feed(engine, base, 3, 0);
    const start = engine.update(base, 200);
    assert.equal(start.pose, 'scroll');
    const after = feed(engine, moved, 8, 300);
    return after.scrollY - start.scrollY;
  };

  const near = run(1.2);
  const far = run(0.65);
  assert.ok(near > 0.01, `scroll should move (${near})`);
  assert.ok(Math.abs(near - far) < 0.005, `near ${near} vs far ${far}`);
});

