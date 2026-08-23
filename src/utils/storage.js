/**
 * Storage utility for Amazon Wishlist Tracker
 * Wraps chrome.storage API (which natively supports Promises in MV3)
 */

export const StorageArea = {
  SYNC: 'sync',
  LOCAL: 'local'
};

export const StorageKeys = {
  // Local storage: potentially large user data
  TRACKED_ITEMS: 'trackedItems',
  TRACKED_WISHLISTS: 'trackedWishlists',

  // Sync storage: light settings only
  SETTINGS: 'settings',
  
  // Local storage: heavy data (price history, scraping states)
  PRICE_HISTORY: 'priceHistory',
  LAST_SCRAPE_TIME: 'lastScrapeTime',
  SCRAPE_CURSOR: 'scrapeCursor',
  PRIORITY_SCRAPE_CURSOR: 'priorityScrapeCursor',
  WISHLIST_SCRAPE_CURSOR: 'wishlistScrapeCursor',
  WISHLIST_SCRAPE_STATE: 'wishlistScrapeState',
  CAPTCHA_BACKOFF_UNTIL: 'captchaBackoffUntil',
  CAPTCHA_BACKOFF_ATTEMPTS: 'captchaBackoffAttempts',

  // Records only an opaque fingerprint and outcome for the one-time legacy
  // target notice. It deliberately never stores the old target value itself.
  LEGACY_TARGET_NOTICE: 'legacyTargetNotice'
};

/**
 * Get data from chrome storage.
 * @param {string} key 
 * @param {string} area 'sync' or 'local'
 * @returns {Promise<any>}
 */
export async function getStorageData(key, area = StorageArea.SYNC) {
  const result = await chrome.storage[area].get([key]);
  return result[key] || null;
}

/**
 * Set data to chrome storage.
 * @param {string} key
 * @param {any} value
 * @param {string} area 'sync' or 'local'
 * @returns {Promise<void>}
 */
export async function setStorageData(key, value, area = StorageArea.SYNC) {
  await chrome.storage[area].set({ [key]: value });
}

/**
 * Writes several keys in a single chrome.storage call. Cheaper than awaiting
 * one setStorageData per key when a code path updates multiple keys at once.
 * @param {Object} values map of key -> value
 * @param {string} area 'sync' or 'local'
 * @returns {Promise<void>}
 */
export async function setStorageItems(values, area = StorageArea.SYNC) {
  await chrome.storage[area].set(values);
}

/**
 * Formats a numeric price with an optional currency symbol, or 'N/A' when the
 * price is not a finite number. Shared by the popup and the background alerts.
 * @param {number} price
 * @param {string} [currency]
 * @returns {string}
 */
export function formatPrice(price, currency) {
  if (!Number.isFinite(price)) return 'N/A';
  return `${currency || ''}${price.toFixed(2)}`;
}

/**
 * Gets all tracked items.
 * @returns {Promise<Array>}
 */
export async function getTrackedItems() {
  const localItems = await getStorageData(StorageKeys.TRACKED_ITEMS, StorageArea.LOCAL);
  if (localItems) {
    return localItems;
  }

  const legacySyncItems = await getStorageData(StorageKeys.TRACKED_ITEMS, StorageArea.SYNC);
  if (legacySyncItems) {
    await setStorageData(StorageKeys.TRACKED_ITEMS, legacySyncItems, StorageArea.LOCAL);
    return legacySyncItems;
  }

  return [];
}

// Serializes read-modify-write operations so concurrent callers can't clobber
// each other. Each call chains its work onto the previous call's promise.
let saveMutex = Promise.resolve();

/**
 * Runs `fn` serialized behind the shared tracked-items mutex so concurrent
 * read-modify-write callers can't clobber each other.
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>} resolves once `fn` has run
 */
function withSaveLock(fn) {
  const run = saveMutex.then(fn);
  // Advance the lock to this run, but swallow rejections on the *chain* so one
  // failed write doesn't permanently poison the mutex for later callers.
  saveMutex = run.catch(() => {});
  return run;
}

/**
 * Performs an atomic read-modify-write of tracked items within this extension
 * context. Use this for batch merges so long-running jobs apply their results
 * to the latest collection instead of replacing it with a stale snapshot.
 * @param {(items: Array<Object>) => Array<Object>} updater
 * @returns {Promise<void>}
 */
export function updateTrackedItems(updater) {
  return withSaveLock(async () => {
    const items = await getTrackedItems();
    const next = updater(items);
    await setStorageData(StorageKeys.TRACKED_ITEMS, next, StorageArea.LOCAL);
  });
}

/**
 * Runs a validated tracked-item mutation under the same lock as ordinary
 * updates. Returning `{ commit: false }` leaves storage untouched, which is
 * useful when the latest collection no longer meets a UI-time predicate.
 * @param {(items: Array<Object>) => {commit: boolean, items?: Array<Object>, result?: any}} updater
 * @returns {Promise<any>} the updater's result
 */
export function updateTrackedItemsIf(updater) {
  return withSaveLock(async () => {
    const items = await getTrackedItems();
    const outcome = updater(items) || { commit: false };
    if (!outcome.commit) return outcome.result;
    await setStorageData(StorageKeys.TRACKED_ITEMS, outcome.items, StorageArea.LOCAL);
    return outcome.result;
  });
}

/**
 * Adds or updates a tracked item. Serialized via the shared mutex to prevent
 * concurrent read-modify-write races on the trackedItems array.
 * @param {Object} item
 * @returns {Promise<void>} resolves once this item's write has persisted
 */
export function saveTrackedItem(item) {
  return updateTrackedItems((items) => {
    const existingIndex = items.findIndex(i => i.id === item.id);

    if (existingIndex > -1) {
      items[existingIndex] = { ...items[existingIndex], ...item, updatedAt: Date.now() };
    } else {
      items.push({ ...item, addedAt: Date.now(), updatedAt: Date.now() });
    }

    return items;
  });
}

/**
 * Removes a tracked item by id. Serialized through the same mutex as
 * saveTrackedItem so a removal can't clobber a concurrent price-check write
 * (or vice versa) with a stale copy of the array.
 * @param {string} id
 * @returns {Promise<void>}
 */
export function removeTrackedItem(id) {
  return updateTrackedItems((items) => items.filter(i => i.id !== id));
}

/**
 * Prunes price history outside the configured retention period.
 */
export async function prunePriceHistory() {
  const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
  const retention = settings.historyRetentionDays || "30";
  
  if (retention === "forever") {
    console.log("Price history retention is set to forever. Skipping pruning.");
    return;
  }

  const daysToKeep = parseInt(retention, 10);
  const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

  const history = await getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL) || {};
  let prunedCount = 0;
  
  for (const itemId in history) {
    const dataPoints = history[itemId];
    if (!Array.isArray(dataPoints)) continue;

    history[itemId] = dataPoints.filter(dp => {
      const keep = Number.isFinite(dp.timestamp) && dp.timestamp >= cutoffTime;
      if (!keep) prunedCount++;
      return keep;
    });
  }

  if (prunedCount > 0) {
    console.log(`Pruned ${prunedCount} old price history data points.`);
    await setStorageData(StorageKeys.PRICE_HISTORY, history, StorageArea.LOCAL);
  }
}
