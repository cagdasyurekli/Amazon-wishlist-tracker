// Pure helpers for the dashboard price-history chart. No DOM access so they stay unit-testable.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function validHistory(points) {
  return (Array.isArray(points) ? points : [])
    .filter((point) => Number.isFinite(point?.price) && Number.isFinite(point?.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// Collapses consecutive samples with the same price into "held from/to" runs.
// `to` is the last sample that still observed the price, not the next change.
export function priceSegments(points) {
  const segments = [];
  for (const point of validHistory(points)) {
    const current = segments[segments.length - 1];
    if (current && current.price === point.price) {
      current.to = point.timestamp;
      current.samples++;
    } else {
      segments.push({ price: point.price, from: point.timestamp, to: point.timestamp, samples: 1 });
    }
  }
  return segments;
}

export function summarizeHistory(points) {
  const valid = validHistory(points);
  if (valid.length === 0) return null;
  let low = valid[0];
  let high = valid[0];
  for (const point of valid) {
    // Prefer the most recent occurrence of a tie so "Low" points at the latest time it happened.
    if (point.price <= low.price) low = point;
    if (point.price >= high.price) high = point;
  }
  const first = valid[0];
  const latest = valid[valid.length - 1];
  const change = latest.price - first.price;
  const segments = priceSegments(valid);
  // Start of the run that contains a point, so "Low · since <date>" says when it began.
  const runStart = (point) => segments.findLast((segment) => segment.from <= point.timestamp).from;
  return {
    first,
    latest,
    low,
    high,
    lowFrom: runStart(low),
    highFrom: runStart(high),
    change,
    changePercent: first.price > 0 ? (change / first.price) * 100 : null,
    sampleCount: valid.length,
    changeCount: segments.length - 1
  };
}

// Index of the sample whose price was in effect at `timestamp` (step-after semantics).
export function activePointIndex(points, timestamp) {
  if (points.length === 0) return -1;
  let lo = 0;
  let hi = points.length - 1;
  if (timestamp <= points[0].timestamp) return 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].timestamp <= timestamp) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Round-number axis ticks (1, 2, 2.5, 5 × 10^n) covering [min, max].
export function niceTicks(min, max, maxTicks = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.05, 1);
    min -= pad;
    max += pad;
  }
  const rawStep = (max - min) / Math.max(1, maxTicks - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rawStep);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

export function timeTicks(start, end, maxTicks = 5) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return Number.isFinite(start) ? [start] : [];
  const count = Math.max(2, maxTicks);
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, index) => Math.round(start + index * step));
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < MINUTE_MS) return '<1m';
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

// Picks a date label granularity that stays distinct across the visible span.
export function timeLabelStyle(spanMs) {
  if (spanMs < 2 * DAY_MS) return 'time';
  if (spanMs < 300 * DAY_MS) return 'day';
  return 'month';
}
