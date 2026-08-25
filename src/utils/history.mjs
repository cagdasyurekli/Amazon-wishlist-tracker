export const MAX_HISTORY_POINTS = 500000;
export const MAX_HISTORY_POINTS_PER_ITEM = 10000;

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_RAW_MS = 7 * DAY_MS;
const DAILY_RESOLUTION_MS = 365 * DAY_MS;

export function applyMissingTrackingBaselines(items, history) {
  let updatedCount = 0;
  const updatedItems = (Array.isArray(items) ? items : []).map((item) => {
    if (Number.isFinite(item?.trackingStartPrice) && Number.isFinite(item?.trackingStartedAt)) {
      if (typeof item.trackingBaselineExact === 'boolean') return item;
      updatedCount++;
      return { ...item, trackingBaselineExact: false };
    }
    const firstPoint = (Array.isArray(history?.[item?.id]) ? history[item.id] : [])
      .filter((point) => Number.isFinite(point?.price) && Number.isFinite(point?.timestamp))
      .reduce((earliest, point) => !earliest || point.timestamp < earliest.timestamp ? point : earliest, null);
    if (!firstPoint) return item;
    updatedCount++;
    return {
      ...item,
      trackingStartPrice: firstPoint.price,
      trackingStartedAt: firstPoint.timestamp,
      trackingBaselineExact: false
    };
  });
  return { items: updatedItems, updatedCount };
}

function pointKey(point) {
  return `${point.timestamp}:${point.price}`;
}

function extrema(points) {
  if (points.length === 0) return [];
  let low = points[0];
  let high = points[0];
  for (const point of points.slice(1)) {
    if (point.price < low.price) low = point;
    if (point.price > high.price) high = point;
  }
  return low.price === high.price
    ? [points[points.length - 1]]
    : [low, high].sort((a, b) => a.timestamp - b.timestamp);
}

function bucketExtrema(points, keyForPoint) {
  const buckets = new Map();
  for (const point of points) {
    const key = keyForPoint(point);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(point);
  }
  return [...buckets.values()].flatMap(extrema);
}

function utcDayKey(point) {
  return new Date(point.timestamp).toISOString().slice(0, 10);
}

function utcMonthKey(point) {
  return new Date(point.timestamp).toISOString().slice(0, 7);
}

function capSeries(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  if (maxPoints <= 1) return points.slice(-1);
  return [points[0], ...points.slice(-(maxPoints - 1))];
}

export function compactHistorySeries(points, {
  now = Date.now(),
  retention = '30',
  maxPoints = MAX_HISTORY_POINTS_PER_ITEM
} = {}) {
  const cutoff = retention === 'forever'
    ? Number.NEGATIVE_INFINITY
    : now - (Number.parseInt(retention, 10) || 30) * DAY_MS;
  const unique = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    if (!Number.isFinite(point?.price) || !Number.isFinite(point?.timestamp) || point.timestamp < cutoff) continue;
    const normalized = { price: point.price, timestamp: point.timestamp };
    unique.set(pointKey(normalized), normalized);
  }
  const sorted = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
  const recent = [];
  const daily = [];
  const monthly = [];
  for (const point of sorted) {
    const age = Math.max(0, now - point.timestamp);
    if (age <= RECENT_RAW_MS) recent.push(point);
    else if (age <= DAILY_RESOLUTION_MS) daily.push(point);
    else monthly.push(point);
  }
  const compacted = [
    ...bucketExtrema(monthly, utcMonthKey),
    ...bucketExtrema(daily, utcDayKey),
    ...recent
  ].sort((a, b) => a.timestamp - b.timestamp);
  const bounded = capSeries(compacted, maxPoints);
  const removedCount = Math.max(0, (Array.isArray(points) ? points.length : 0) - bounded.length);
  return {
    points: bounded,
    compacted: removedCount > 0,
    removedCount
  };
}

export function compactPriceHistory(history, options = {}) {
  const compactedHistory = Object.create(null);
  let compacted = false;
  let removedCount = 0;
  for (const [id, points] of Object.entries(history || {})) {
    const result = compactHistorySeries(points, options);
    compactedHistory[id] = result.points;
    compacted ||= result.compacted;
    removedCount += result.removedCount;
  }
  return { history: compactedHistory, compacted, removedCount };
}

export function limitHistoryTotal(history, maxPoints = MAX_HISTORY_POINTS) {
  maxPoints = Math.max(0, Math.floor(Number(maxPoints) || 0));
  const entries = Object.entries(history || {});
  const total = entries.reduce((sum, [, points]) => sum + points.length, 0);
  if (total <= maxPoints) return { history, compacted: false, removedCount: 0 };

  const selected = new Map(entries.map(([id]) => [id, new Map()]));
  const candidates = [];
  for (const [id, points] of entries) {
    if (points.length === 0) continue;
    selected.get(id).set(pointKey(points[0]), points[0]);
    selected.get(id).set(pointKey(points[points.length - 1]), points[points.length - 1]);
    for (const point of points.slice(1, -1)) candidates.push({ id, point });
  }

  let selectedCount = [...selected.values()].reduce((sum, points) => sum + points.size, 0);
  if (selectedCount > maxPoints) {
    const endpoints = [];
    for (const [id, points] of selected) {
      for (const point of points.values()) endpoints.push({ id, point });
      points.clear();
    }
    endpoints.sort((a, b) => b.point.timestamp - a.point.timestamp);
    for (const { id, point } of endpoints.slice(0, maxPoints)) {
      selected.get(id).set(pointKey(point), point);
    }
    selectedCount = maxPoints;
  }

  let remaining = Math.max(0, maxPoints - selectedCount);
  candidates.sort((a, b) => b.point.timestamp - a.point.timestamp);
  for (const candidate of candidates) {
    if (remaining === 0) break;
    const itemPoints = selected.get(candidate.id);
    const key = pointKey(candidate.point);
    if (itemPoints.has(key)) continue;
    itemPoints.set(key, candidate.point);
    remaining--;
  }

  const bounded = Object.create(null);
  for (const [id, points] of selected) {
    bounded[id] = [...points.values()].sort((a, b) => a.timestamp - b.timestamp);
  }
  const kept = Object.values(bounded).reduce((sum, points) => sum + points.length, 0);
  return { history: bounded, compacted: true, removedCount: total - kept };
}
