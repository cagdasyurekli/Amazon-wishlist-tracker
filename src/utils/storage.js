/**
 * Storage utility for Amazon Wishlist Tracker
 * Wraps chrome.storage API (which natively supports Promises in MV3)
 */

import { applyMissingTrackingBaselines, compactHistorySeries } from './history.mjs';

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
  PRICE_HISTORY_GENERATION: 'priceHistoryGeneration',
  LAST_SCRAPE_TIME: 'lastScrapeTime',
  SCRAPE_CURSOR: 'scrapeCursor',
  PRIORITY_SCRAPE_CURSOR: 'priorityScrapeCursor',
  WISHLIST_SCRAPE_CURSOR: 'wishlistScrapeCursor',
  WISHLIST_SCRAPE_STATE: 'wishlistScrapeState',
  CAPTCHA_BACKOFF_UNTIL: 'captchaBackoffUntil',
  CAPTCHA_BACKOFF_ATTEMPTS: 'captchaBackoffAttempts',

  // Opaque marker for the one-time legacy target migration notice. The old
  // target value itself remains only in settings until the user reviews it.
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
 * Removes a key from chrome storage.
 * @param {string} key
 * @param {string} area 'sync' or 'local'
 * @returns {Promise<void>}
 */
export async function removeStorageData(key, area = StorageArea.SYNC) {
  await chrome.storage[area].remove(key);
}

/**
 * Formats a numeric price with an optional currency symbol, or 'N/A' when the
 * price is not a finite number. Shared by the popup and the background alerts.
 * @param {number} price
 * @param {string} [currency]
 * @param {string|string[]} [locale] defaults to the browser locale
 * @returns {string}
 */
export function formatPrice(price, currency, locale) {
  if (!Number.isFinite(price)) return 'N/A';
  const currencyCodes = {
    '$': 'USD',
    '€': 'EUR',
    '£': 'GBP',
    '¥': 'JPY'
  };
  const currencyCode = currencyCodes[currency] || (/^[A-Z]{3}$/.test(currency || '') ? currency : null);
  try {
    if (currencyCode) {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(price);
    }
    const formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(price);
    return `${currency || ''}${formatted}`;
  } catch (_error) {
    return `${currency || ''}${price.toFixed(2)}`;
  }
}

/**
 * Gets all tracked items.
 * @returns {Promise<Array>}
 */
export async function getTrackedItems() {
  const localItems = await getStorageData(StorageKeys.TRACKED_ITEMS, StorageArea.LOCAL);
  if (Array.isArray(localItems)) {
    // Repair profiles migrated by an older build that copied trackedItems to
    // local storage but left the privacy-sensitive legacy Sync key behind.
    try {
      const residualSyncItems = await getStorageData(StorageKeys.TRACKED_ITEMS, StorageArea.SYNC);
      if (Array.isArray(residualSyncItems)) {
        await removeStorageData(StorageKeys.TRACKED_ITEMS, StorageArea.SYNC);
      }
    } catch (err) {
      // Local data remains authoritative and usable. A later read retries this
      // idempotent cleanup if Chrome Sync is temporarily unavailable.
      console.warn('Could not remove legacy tracked items from Chrome Sync:', err);
    }
    return localItems;
  }

  const legacySyncItems = await getStorageData(StorageKeys.TRACKED_ITEMS, StorageArea.SYNC);
  if (Array.isArray(legacySyncItems)) {
    await setStorageData(StorageKeys.TRACKED_ITEMS, legacySyncItems, StorageArea.LOCAL);
    const persistedItems = await getStorageData(StorageKeys.TRACKED_ITEMS, StorageArea.LOCAL);
    if (!Array.isArray(persistedItems) || JSON.stringify(persistedItems) !== JSON.stringify(legacySyncItems)) {
      throw new Error('Legacy tracked-item migration could not be verified.');
    }
    try {
      await removeStorageData(StorageKeys.TRACKED_ITEMS, StorageArea.SYNC);
    } catch (err) {
      // The verified local copy is safe to use; future reads retry deletion.
      console.warn('Could not remove legacy tracked items from Chrome Sync:', err);
    }
    return persistedItems;
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
 * Serializes wishlist read-modify-write operations with the other local
 * tracking mutations in this extension context.
 * @param {(wishlists: Array<Object|string>, items: Array<Object>) => Array<Object>} updater
 * @returns {Promise<void>}
 */
export function updateTrackedWishlists(updater) {
  return withSaveLock(async () => {
    const wishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];
    const items = await getTrackedItems();
    const next = updater(Array.isArray(wishlists) ? wishlists : [], items);
    await setStorageData(StorageKeys.TRACKED_WISHLISTS, next, StorageArea.LOCAL);
  });
}

/**
 * Runs a validated tracked-item mutation under the shared save lock. Returning
 * `{ commit: false }` leaves storage untouched so UI-time assumptions can be
 * rechecked against the latest collection before a migration is applied.
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
 * Applies a tracked-item update and keeps the shared lock until an external
 * finalizer succeeds. If the finalizer fails, the exact pre-update collection
 * is restored before another tracked-item mutation can run.
 * @param {(items: Array<Object>) => {commit: boolean, items?: Array<Object>, result?: any}} updater
 * @param {(result: any) => Promise<void>} finalizer
 * @returns {Promise<any>} the updater's result
 */
export function updateTrackedItemsWithFinalizer(updater, finalizer) {
  return withSaveLock(async () => {
    const items = await getTrackedItems();
    const outcome = updater(items) || { commit: false };
    if (!outcome.commit) return outcome.result;

    await setStorageData(StorageKeys.TRACKED_ITEMS, outcome.items, StorageArea.LOCAL);
    try {
      await finalizer(outcome.result);
      return outcome.result;
    } catch (error) {
      await setStorageData(StorageKeys.TRACKED_ITEMS, items, StorageArea.LOCAL);
      throw error;
    }
  });
}

/**
 * Replaces user-owned tracking data under the tracked-item lock. Local data is
 * written in one storage operation; if the Sync settings write fails, the
 * exact Local snapshot is restored before the lock is released.
 * @param {{items: Array<Object>, history: Object, trackedWishlists: Array<Object>, settings: Object}} data
 * @returns {Promise<void>}
 */
export function replaceTrackingData(data) {
  return withSaveLock(async () => {
    const localKeys = [
      StorageKeys.TRACKED_ITEMS,
      StorageKeys.TRACKED_WISHLISTS,
      StorageKeys.PRICE_HISTORY,
      StorageKeys.PRICE_HISTORY_GENERATION,
      StorageKeys.LAST_SCRAPE_TIME,
      StorageKeys.SCRAPE_CURSOR,
      StorageKeys.PRIORITY_SCRAPE_CURSOR,
      StorageKeys.WISHLIST_SCRAPE_CURSOR,
      StorageKeys.WISHLIST_SCRAPE_STATE
    ];
    const previousLocal = await chrome.storage.local.get(localKeys);
    const nextHistoryGeneration = (Number(previousLocal[StorageKeys.PRICE_HISTORY_GENERATION]) || 0) + 1;
    const nextLocal = {
      [StorageKeys.TRACKED_ITEMS]: data.items,
      [StorageKeys.TRACKED_WISHLISTS]: data.trackedWishlists,
      [StorageKeys.PRICE_HISTORY]: data.history,
      [StorageKeys.PRICE_HISTORY_GENERATION]: nextHistoryGeneration,
      [StorageKeys.LAST_SCRAPE_TIME]: null,
      [StorageKeys.SCRAPE_CURSOR]: 0,
      [StorageKeys.PRIORITY_SCRAPE_CURSOR]: 0,
      [StorageKeys.WISHLIST_SCRAPE_CURSOR]: 0,
      [StorageKeys.WISHLIST_SCRAPE_STATE]: {}
    };

    await chrome.storage.local.set(nextLocal);
    try {
      await setStorageData(StorageKeys.SETTINGS, data.settings, StorageArea.SYNC);
    } catch (error) {
      const absentBefore = localKeys.filter((key) => !Object.hasOwn(previousLocal, key));
      if (absentBefore.length > 0) await chrome.storage.local.remove(absentBefore);
      if (Object.keys(previousLocal).length > 0) await chrome.storage.local.set(previousLocal);
      throw error;
    }
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
 * Performs a serialized read-modify-write of local price history. Background
 * scrape jobs use this to merge only the samples they produced into the latest
 * stored history instead of replacing concurrent samples with a stale snapshot.
 * @param {(history: Object<string, Array<Object>>) => Object<string, Array<Object>>} updater
 * @returns {Promise<void>}
 */
export function updatePriceHistory(updater) {
  return withSaveLock(async () => {
    const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
    const history = await getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL) || {};
    const items = await getTrackedItems();
    // Capture the exact earliest sample before retention or extrema compaction
    // can remove it. The popup then has a durable tracking-start baseline.
    const baselines = applyMissingTrackingBaselines(items, history);
    const next = updater(history);
    const compacted = { ...next };
    for (const [id, points] of Object.entries(next || {})) {
      if (points !== history[id]) {
        compacted[id] = compactHistorySeries(points, {
          retention: settings.historyRetentionDays || '30'
        }).points;
      }
    }
    if (baselines.updatedCount > 0) {
      await setStorageItems({
        [StorageKeys.TRACKED_ITEMS]: baselines.items,
        [StorageKeys.PRICE_HISTORY]: compacted
      }, StorageArea.LOCAL);
    } else {
      await setStorageData(StorageKeys.PRICE_HISTORY, compacted, StorageArea.LOCAL);
    }
  });
}

/**
 * Clears price history and advances the writer generation in one locked Local
 * write so delayed reads, pruning, and restore cannot repopulate the old state.
 * @returns {Promise<number>} the generation established by this clear
 */
export function clearPriceHistory() {
  return withSaveLock(async () => {
    const currentGeneration = Number(
      await getStorageData(StorageKeys.PRICE_HISTORY_GENERATION, StorageArea.LOCAL)
    ) || 0;
    const nextGeneration = currentGeneration + 1;
    await setStorageItems({
      [StorageKeys.PRICE_HISTORY]: {},
      [StorageKeys.PRICE_HISTORY_GENERATION]: nextGeneration
    }, StorageArea.LOCAL);
    return nextGeneration;
  });
}

/**
 * Prunes price history outside the configured retention period.
 */
export async function prunePriceHistory() {
  const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
  const retention = settings.historyRetentionDays || "30";
  const daysToKeep = retention === "forever" ? null : parseInt(retention, 10);
  const cutoffTime = daysToKeep == null ? null : Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

  let prunedCount = 0;

  await updatePriceHistory((history) => {
    const prunedHistory = { ...history };
    for (const itemId in prunedHistory) {
      const dataPoints = prunedHistory[itemId];
      if (!Array.isArray(dataPoints)) continue;

      prunedHistory[itemId] = dataPoints.filter(dp => {
        if (cutoffTime == null) return true;
        const keep = Number.isFinite(dp.timestamp) && dp.timestamp >= cutoffTime;
        if (!keep) prunedCount++;
        return keep;
      });
    }
    return prunedHistory;
  });

  if (prunedCount > 0) {
    console.log(`Pruned ${prunedCount} old price history data points.`);
  }
}
