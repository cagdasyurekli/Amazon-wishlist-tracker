import {
  getAmazonWishlistId,
  normalizeStoredAmazonProductUrl,
  parseCanonicalAmazonWishlistUrl,
  sanitizeAmazonImageUrl
} from './amazon.js';
import {
  applyMissingTrackingBaselines,
  compactPriceHistory,
  limitHistoryTotal,
  MAX_HISTORY_POINTS,
  MAX_HISTORY_POINTS_PER_ITEM
} from './history.mjs';

export const BACKUP_FORMAT = 'saved-signal-backup';
export const BACKUP_VERSION = 2;
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const WISHLIST_ID_PATTERN = /^[a-z0-9_=-]{1,64}$/i;
const MAX_ITEMS = 5000;
const MAX_WISHLISTS = 500;
const MAX_PRICE = 1_000_000_000;
const MAX_PRODUCT_AUTHORS = 20;
const MAX_AUTHOR_LENGTH = 160;
const SUPPORTED_BACKUP_VERSIONS = new Set([1, BACKUP_VERSION]);
const ALLOWED_RETENTION = new Set(['30', '90', '365', 'forever']);
const ALLOWED_SORTS = new Set(['recent', 'priceAsc', 'priceDesc', 'discountDesc']);
const ALLOWED_FILTERS = new Set(['all', 'drops', 'priority', 'outOfStock', 'targetReached', 'unchecked']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireString(value, fieldName, maxLength) {
  if (typeof value !== 'string') throw new Error(`Invalid ${fieldName}.`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`Invalid ${fieldName}.`);
  return normalized;
}

function optionalString(value, fieldName, maxLength) {
  if (value == null || value === '') return null;
  return requireString(value, fieldName, maxLength);
}

function optionalNumber(value, fieldName, { min = 0, max = MAX_PRICE } = {}) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${fieldName}.`);
  }
  return value;
}

function optionalTimestamp(value, fieldName) {
  return optionalNumber(value, fieldName, { min: 0, max: Number.MAX_SAFE_INTEGER });
}

function optionalBoolean(value, fieldName, defaultValue = false) {
  if (value == null) return defaultValue;
  if (typeof value !== 'boolean') throw new Error(`Invalid ${fieldName}.`);
  return value;
}

function optionalAuthors(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_PRODUCT_AUTHORS) {
    throw new Error('Invalid product authors.');
  }
  const authors = value.map((entry) => requireString(entry, 'product author', MAX_AUTHOR_LENGTH));
  return [...new Set(authors)];
}

function sanitizeItem(rawItem) {
  if (!isPlainObject(rawItem)) throw new Error('Invalid tracked product.');
  const id = typeof rawItem.id === 'string' ? rawItem.id.toUpperCase() : '';
  if (!ASIN_PATTERN.test(id)) throw new Error('Invalid tracked product identifier.');
  const url = normalizeStoredAmazonProductUrl(rawItem.url, id);
  if (!url) throw new Error(`Invalid product URL for ${id}.`);

  const currency = optionalString(rawItem.currency, 'currency', 8);
  const item = {
    id,
    title: requireString(rawItem.title, 'product title', 300),
    url,
    imageUrl: sanitizeAmazonImageUrl(rawItem.imageUrl || '', url),
    currentPrice: optionalNumber(rawItem.currentPrice, 'current price'),
    originalPrice: optionalNumber(rawItem.originalPrice, 'original price'),
    currency,
    inStock: optionalBoolean(rawItem.inStock, 'stock status', true),
    wishlistIds: Array.isArray(rawItem.wishlistIds)
      ? [...new Set(rawItem.wishlistIds.map((value) => {
          if (typeof value !== 'string' || !WISHLIST_ID_PATTERN.test(value)) {
            throw new Error(`Invalid wishlist ownership for ${id}.`);
          }
          return value;
        }))]
      : [],
    trackedIndividually: optionalBoolean(rawItem.trackedIndividually, 'individual tracking state'),
    isPriority: optionalBoolean(rawItem.isPriority, 'priority state')
  };
  const authors = optionalAuthors(rawItem.authors);
  if (authors.length > 0) item.authors = authors;
  if (item.wishlistIds.length > 20) throw new Error(`Too many wishlist owners for ${id}.`);

  const numericFields = {
    targetPrice: { min: 0.01, max: MAX_PRICE },
    targetDiscountPercentage: { min: 1, max: 99 },
    wishlistPriceDropPercent: { min: 0, max: 100 },
    wishlistPriceWhenAdded: { min: 0, max: MAX_PRICE },
    wishlistPriceDropAmount: { min: 0, max: MAX_PRICE },
    buyBoxPrice: { min: 0, max: MAX_PRICE },
    salesRank: { min: 0, max: MAX_PRICE },
    trackingStartPrice: { min: 0, max: MAX_PRICE }
  };
  for (const [field, bounds] of Object.entries(numericFields)) {
    const value = optionalNumber(rawItem[field], field, bounds);
    if (value != null) item[field] = value;
  }

  for (const field of ['addedAt', 'updatedAt', 'lastChecked', 'trackingStartedAt']) {
    const value = optionalTimestamp(rawItem[field], field);
    if (value != null) item[field] = value;
  }

  const wishlistItemId = optionalString(rawItem.wishlistItemId, 'wishlist item identifier', 128);
  if (wishlistItemId) item.wishlistItemId = wishlistItemId;
  const dropText = optionalString(rawItem.wishlistPriceDropText, 'wishlist price-drop text', 500);
  if (dropText) item.wishlistPriceDropText = dropText;
  if (typeof rawItem.wasInStockPreviously === 'boolean') {
    item.wasInStockPreviously = rawItem.wasInStockPreviously;
  }
  if (typeof rawItem.trackingBaselineExact === 'boolean') {
    item.trackingBaselineExact = rawItem.trackingBaselineExact;
  }

  return item;
}

function sanitizeHistory(rawHistory) {
  if (rawHistory == null) return {};
  if (!isPlainObject(rawHistory)) throw new Error('Invalid price history.');
  const history = Object.create(null);
  let totalPoints = 0;

  for (const [rawId, rawPoints] of Object.entries(rawHistory)) {
    const id = rawId.toUpperCase();
    if (!ASIN_PATTERN.test(id) || !Array.isArray(rawPoints) || rawPoints.length > MAX_HISTORY_POINTS_PER_ITEM) {
      throw new Error(`Invalid price history for ${rawId}.`);
    }
    const points = rawPoints.map((point) => {
      if (!isPlainObject(point)) throw new Error(`Invalid price history point for ${id}.`);
      return {
        price: optionalNumber(point.price, 'history price'),
        timestamp: optionalTimestamp(point.timestamp, 'history timestamp')
      };
    });
    if (points.some((point) => point.price == null || point.timestamp == null)) {
      throw new Error(`Invalid price history point for ${id}.`);
    }
    totalPoints += points.length;
    if (totalPoints > MAX_HISTORY_POINTS) throw new Error('Backup contains too many price-history points.');
    history[id] = points;
  }

  return history;
}

function inferLegacyWishlistOrigin(rawId, items) {
  const origins = new Set();
  for (const item of items) {
    if (!item.wishlistIds?.includes(rawId)) continue;
    try {
      origins.add(new URL(item.url).origin);
    } catch (_error) {}
  }
  return origins.size === 1 ? [...origins][0] : null;
}

function sanitizeWishlists(rawWishlists, items) {
  if (rawWishlists == null) return [];
  if (!Array.isArray(rawWishlists) || rawWishlists.length > MAX_WISHLISTS) {
    throw new Error('Invalid tracked wishlists.');
  }

  const byId = new Map();
  for (const entry of rawWishlists) {
    const legacyId = typeof entry === 'string' ? entry : null;
    const rawId = legacyId || entry?.id;
    if (typeof rawId !== 'string' || !WISHLIST_ID_PATTERN.test(rawId)) {
      throw new Error('Invalid tracked wishlist identifier.');
    }
    if (byId.has(rawId)) throw new Error(`Duplicate tracked wishlist ${rawId}.`);
    const inferredOrigin = legacyId ? inferLegacyWishlistOrigin(rawId, items) : null;
    const unresolved = Boolean(legacyId && !inferredOrigin) || entry?.needsRegionReview === true;
    const rawUrl = legacyId
      ? (inferredOrigin ? `${inferredOrigin}/hz/wishlist/ls/${rawId}` : null)
      : entry.url;
    if (unresolved) {
      byId.set(rawId, {
        id: rawId,
        url: null,
        autoSync: false,
        needsRegionReview: true
      });
      continue;
    }
    const parsed = parseCanonicalAmazonWishlistUrl(rawUrl);
    if (!parsed || getAmazonWishlistId(parsed.href) !== rawId) {
      throw new Error(`Invalid tracked wishlist URL for ${rawId}.`);
    }
    byId.set(rawId, {
      id: rawId,
      url: `https://${parsed.hostname.toLowerCase()}/hz/wishlist/ls/${rawId}`,
      autoSync: optionalBoolean(entry?.autoSync, 'wishlist auto-sync state')
    });
  }
  return [...byId.values()];
}

function sanitizeSettings(rawSettings) {
  if (rawSettings == null) return {};
  if (!isPlainObject(rawSettings)) throw new Error('Invalid settings.');
  const settings = {};

  if (rawSettings.defaultDiscount != null) {
    const discount = Number(rawSettings.defaultDiscount);
    if (!Number.isInteger(discount) || discount < 1 || discount > 99) {
      throw new Error('Invalid default discount.');
    }
    settings.defaultDiscount = discount;
  }
  if (rawSettings.historyRetentionDays != null) {
    const retention = String(rawSettings.historyRetentionDays);
    if (!ALLOWED_RETENTION.has(retention)) throw new Error('Invalid history retention.');
    settings.historyRetentionDays = retention;
  }
  if (rawSettings.dashboardSort != null) {
    if (!ALLOWED_SORTS.has(rawSettings.dashboardSort)) throw new Error('Invalid dashboard sort.');
    settings.dashboardSort = rawSettings.dashboardSort;
  }
  if (rawSettings.dashboardFilter != null) {
    if (!ALLOWED_FILTERS.has(rawSettings.dashboardFilter)) throw new Error('Invalid dashboard filter.');
    settings.dashboardFilter = rawSettings.dashboardFilter;
  }
  return settings;
}

export function createBackupPayload({ items, history, trackedWishlists, settings }) {
  const retention = settings?.historyRetentionDays || '30';
  const baselines = applyMissingTrackingBaselines(items, history);
  const compacted = compactPriceHistory(history, { retention });
  const bounded = limitHistoryTotal(compacted.history);
  const canonical = validateBackupPayload({
    items: baselines.items,
    history: bounded.history,
    trackedWishlists: Array.isArray(trackedWishlists) ? trackedWishlists : [],
    settings: isPlainObject(settings) ? settings : {}
  });
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    historyPolicy: {
      recentRawDays: 7,
      olderResolution: 'daily-low-high; monthly-low-high after one year',
      compacted: compacted.compacted || bounded.compacted,
      removedPointCount: compacted.removedCount + bounded.removedCount
    },
    items: canonical.items,
    history: canonical.history,
    trackedWishlists: canonical.trackedWishlists,
    settings: canonical.settings
  };
  // Keep export and restore on exactly the same data contract. This also makes
  // future format changes fail closed if the writer drifts from the reader.
  validateBackupPayload(payload);
  return payload;
}

export function createBackupBlob(payload) {
  validateBackupPayload(payload);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  if (blob.size > MAX_BACKUP_BYTES) {
    throw new Error('Backup is larger than the 32 MB safety limit.');
  }
  return blob;
}

export function validateBackupPayload(payload) {
  if (!isPlainObject(payload)) throw new Error('Backup must be a JSON object.');
  if (payload.format != null && payload.format !== BACKUP_FORMAT) throw new Error('Unsupported backup format.');
  if (payload.version != null && !SUPPORTED_BACKUP_VERSIONS.has(payload.version)) {
    throw new Error('Unsupported backup version.');
  }
  if (!Array.isArray(payload.items) || payload.items.length > MAX_ITEMS) {
    throw new Error(`Backup must contain at most ${MAX_ITEMS} tracked products.`);
  }

  const items = payload.items.map(sanitizeItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error('Backup contains duplicate tracked products.');
  }
  const history = sanitizeHistory(payload.history);
  const trackedWishlists = sanitizeWishlists(payload.trackedWishlists, items);
  const settings = sanitizeSettings(payload.settings);

  return {
    items,
    history,
    trackedWishlists,
    settings,
    summary: {
      itemCount: items.length,
      historyPointCount: Object.values(history).reduce((total, points) => total + points.length, 0),
      wishlistCount: trackedWishlists.length
    }
  };
}
