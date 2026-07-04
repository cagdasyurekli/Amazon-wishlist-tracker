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
  CAPTCHA_BACKOFF_UNTIL: 'captchaBackoffUntil',
  CAPTCHA_BACKOFF_ATTEMPTS: 'captchaBackoffAttempts'
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
 * Adds or updates a tracked item. Serialized via the shared mutex to prevent
 * concurrent read-modify-write races on the trackedItems array.
 * @param {Object} item
 * @returns {Promise<void>} resolves once this item's write has persisted
 */
export function saveTrackedItem(item) {
  return withSaveLock(async () => {
    const items = await getTrackedItems();
    const existingIndex = items.findIndex(i => i.id === item.id);

    if (existingIndex > -1) {
      items[existingIndex] = { ...items[existingIndex], ...item, updatedAt: Date.now() };
    } else {
      items.push({ ...item, addedAt: Date.now(), updatedAt: Date.now() });
    }

    await setStorageData(StorageKeys.TRACKED_ITEMS, items, StorageArea.LOCAL);
  });
}

/**
 * Replaces the tracked item collection in a single storage write.
 * Use this for background batch jobs so sync storage is not rewritten once per
 * scraped product.
 * @param {Array<Object>} items
 */
export async function saveTrackedItems(items) {
  await setStorageData(StorageKeys.TRACKED_ITEMS, items, StorageArea.LOCAL);
}

/**
 * Removes a tracked item by id. Serialized through the same mutex as
 * saveTrackedItem so a removal can't clobber a concurrent price-check write
 * (or vice versa) with a stale copy of the array.
 * @param {string} id
 * @returns {Promise<void>}
 */
export function removeTrackedItem(id) {
  return withSaveLock(async () => {
    const items = await getTrackedItems();
    const next = items.filter(i => i.id !== id);
    await setStorageData(StorageKeys.TRACKED_ITEMS, next, StorageArea.LOCAL);
  });
}

/**
 * Prunes old price history to prevent local storage from exceeding limits.
 * Keeps only 1 data point per day for data older than 30 days.
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

    const daySeen = new Set();
    history[itemId] = dataPoints.filter(dp => {
      if (dp.timestamp > cutoffTime) return true; // Keep recent

      // For old data, keep only if it's the first one we see for that day
      const day = new Date(dp.timestamp).toDateString();
      if (!daySeen.has(day)) {
        daySeen.add(day);
        return true;
      }
      prunedCount++;
      return false;
    });
  }

  if (prunedCount > 0) {
    console.log(`Pruned ${prunedCount} old price history data points.`);
    await setStorageData(StorageKeys.PRICE_HISTORY, history, StorageArea.LOCAL);
  }
}
