import test from 'node:test';
import assert from 'node:assert/strict';

import { OneEuroFilter } from '../lib/one-euro.mjs';

test('the first sample passes through unchanged', () => {
  const filter = new OneEuroFilter({ minCutoff: 2.5, beta: 0 });
  assert.equal(filter.filter(0.42, 1000), 0.42);
  assert.equal(filter.filter(0.42, 1016), 0.42);
});

test('a step change is smoothed rather than copied', () => {
  const filter = new OneEuroFilter({ minCutoff: 2.5, beta: 0 });
  filter.filter(0, 0);

  const first = filter.filter(1, 16);
  assert.ok(first > 0 && first < 1, `expected a damped value, got ${first}`);

  let value = first;
  for (let i = 2; i <= 12; i += 1) value = filter.filter(1, i * 16);
  assert.ok(value > 0.8 && value <= 1, `expected convergence, got ${value}`);
});

test('reset makes the next sample pass through again', () => {
  const filter = new OneEuroFilter({ minCutoff: 1, beta: 1 });
  filter.filter(0, 0);
  filter.filter(1, 16);
  filter.reset();
  assert.equal(filter.filter(5, 100), 5);
});

test('a non-finite value keeps the last finite position', () => {
  const filter = new OneEuroFilter();
  filter.filter(0.25, 0);
  assert.equal(filter.filter(Number.NaN, 16), 0.25);
  assert.equal(filter.filter(Number.POSITIVE_INFINITY, 32), 0.25);
});

test('timestamps that do not advance stay finite', () => {
  const filter = new OneEuroFilter();
  filter.filter(0, 100);
  const value = filter.filter(1, 100);
  assert.ok(Number.isFinite(value));
  assert.ok(value >= 0 && value <= 1);
});

test('a higher beta reacts more strongly to fast motion', () => {
  const smooth = new OneEuroFilter({ minCutoff: 1, beta: 0 });
  const responsive = new OneEuroFilter({ minCutoff: 1, beta: 20 });
  smooth.filter(0, 0);
  responsive.filter(0, 0);

  const slow = smooth.filter(1, 16);
  const fast = responsive.filter(1, 16);
  assert.ok(fast > slow, `expected beta to open the filter (${slow} vs ${fast})`);
});
