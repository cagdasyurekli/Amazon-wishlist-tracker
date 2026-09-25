import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activePointIndex,
  formatDuration,
  niceTicks,
  priceSegments,
  summarizeHistory,
  timeLabelStyle,
  timeTicks,
  validHistory
} from '../utils/price_chart.mjs';

const HOUR = 60 * 60 * 1000;

test('validHistory drops malformed points and sorts by time', () => {
  const points = [{ price: 2, timestamp: 20 }, { price: null, timestamp: 5 }, { price: 1, timestamp: 10 }, null];
  assert.deepEqual(validHistory(points), [{ price: 1, timestamp: 10 }, { price: 2, timestamp: 20 }]);
  assert.deepEqual(validHistory(undefined), []);
});

test('priceSegments collapses repeated checks into held-price runs', () => {
  const segments = priceSegments([
    { price: 25, timestamp: 0 },
    { price: 25, timestamp: HOUR },
    { price: 20, timestamp: 2 * HOUR },
    { price: 20, timestamp: 3 * HOUR },
    { price: 20, timestamp: 4 * HOUR },
    { price: 25, timestamp: 5 * HOUR }
  ]);
  assert.deepEqual(segments, [
    { price: 25, from: 0, to: HOUR, samples: 2 },
    { price: 20, from: 2 * HOUR, to: 4 * HOUR, samples: 3 },
    { price: 25, from: 5 * HOUR, to: 5 * HOUR, samples: 1 }
  ]);
});

test('summarizeHistory reports low/high, change, and change count', () => {
  const summary = summarizeHistory([
    { price: 30, timestamp: 1 },
    { price: 20, timestamp: 2 },
    { price: 20, timestamp: 3 },
    { price: 24, timestamp: 4 }
  ]);
  assert.equal(summary.low.timestamp, 3, 'ties resolve to the most recent low');
  assert.equal(summary.lowFrom, 2, 'lowFrom is where that low run started');
  assert.equal(summary.highFrom, 1);
  assert.equal(summary.high.price, 30);
  assert.equal(summary.change, -6);
  assert.equal(summary.changePercent, -20);
  assert.equal(summary.sampleCount, 4);
  assert.equal(summary.changeCount, 2);
  assert.equal(summarizeHistory([]), null);
});

test('activePointIndex returns the step in effect at a time', () => {
  const points = [{ timestamp: 10 }, { timestamp: 20 }, { timestamp: 30 }];
  assert.equal(activePointIndex(points, 0), 0);
  assert.equal(activePointIndex(points, 10), 0);
  assert.equal(activePointIndex(points, 19), 0);
  assert.equal(activePointIndex(points, 20), 1);
  assert.equal(activePointIndex(points, 99), 2);
  assert.equal(activePointIndex([], 5), -1);
});

test('niceTicks produces round, covering values', () => {
  assert.deepEqual(niceTicks(19.99, 24.99, 4), [18, 20, 22, 24, 26]);
  assert.deepEqual(niceTicks(0.5, 1.2, 4), [0.5, 0.75, 1, 1.25]);
  const flat = niceTicks(10, 10, 4);
  assert.ok(flat[0] < 10 && flat[flat.length - 1] > 10, 'flat series still gets a visible range');
  assert.deepEqual(niceTicks(NaN, 1), []);
  assert.ok(niceTicks(0.99, 0.99, 4).every((tick) => tick >= 0), 'flat cheap item gets no negative tick');
  assert.deepEqual(niceTicks(1000, 1001, 4, 1), [1000, 1001], 'yen ticks stay on whole units');
  assert.ok(niceTicks(0, 5, 4)[0] === 0);
});

test('timeTicks spreads labels evenly and handles single-point spans', () => {
  assert.deepEqual(timeTicks(0, 100, 5), [0, 25, 50, 75, 100]);
  assert.deepEqual(timeTicks(7, 7), [7]);
});

test('formatDuration and timeLabelStyle pick readable units', () => {
  assert.equal(formatDuration(30 * 1000), '<1m');
  assert.equal(formatDuration(5 * 60 * 1000), '5m');
  assert.equal(formatDuration(3 * HOUR), '3h');
  assert.equal(formatDuration(50 * HOUR), '2d');
  assert.equal(timeLabelStyle(HOUR), 'time');
  assert.equal(timeLabelStyle(60 * HOUR, 15 * HOUR), 'time', '2.5 days over 5 ticks would repeat day labels');
  assert.equal(timeLabelStyle(10 * 24 * HOUR, 60 * HOUR), 'day');
  assert.equal(timeLabelStyle(400 * 24 * HOUR, 100 * 24 * HOUR), 'month');
  assert.equal(timeLabelStyle(200 * 24 * HOUR, 50 * 24 * HOUR), 'day');
});

test('getTrackingBaseline prefers the durable start price, else the earliest retained sample', async () => {
  const { getTrackingBaseline } = await import('../utils/history.mjs');
  assert.deepEqual(
    getTrackingBaseline({ trackingStartPrice: 50, trackingStartedAt: 7, trackingBaselineExact: true }, []),
    { price: 50, timestamp: 7, exact: true }
  );
  assert.deepEqual(
    getTrackingBaseline({}, [{ price: 9, timestamp: 20 }, { price: 12, timestamp: 10 }, { price: null, timestamp: 1 }]),
    { price: 12, timestamp: 10, exact: false }
  );
  assert.equal(getTrackingBaseline({}, []), null);
});

test('getTrackingChange signs the change and hides moves under 0.5%', async () => {
  const { getTrackingChange } = await import('../utils/history.mjs');
  const drop = getTrackingChange({ currentPrice: 278, trackingStartPrice: 399.99 }, []);
  assert.ok(Math.abs(drop.percent - -30.4983) < 0.001);
  assert.ok(Math.abs(drop.amount - -121.99) < 1e-9);
  assert.equal(getTrackingChange({ currentPrice: 100.4, trackingStartPrice: 100 }, []), null);
  assert.ok(getTrackingChange({ currentPrice: 110, trackingStartPrice: 100 }, []).percent > 0);
  assert.equal(getTrackingChange({ currentPrice: 5, trackingStartPrice: 0 }, []), null);
  assert.equal(getTrackingChange({ trackingStartPrice: 10 }, []), null);
});
