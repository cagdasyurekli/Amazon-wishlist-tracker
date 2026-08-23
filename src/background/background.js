import { scrapeAmazonProduct, scrapeAmazonWishlist, closeOffscreenDocument } from './scraper.js';
import { getTrackedItems, saveTrackedItem, updateTrackedItems, updateTrackedItemsIf, getStorageData, setStorageItems, formatPrice, prunePriceHistory, StorageKeys, StorageArea } from '../utils/storage.js';
import './wishlist_partial_policy.js';
import './legacy_target_notice.js';

const AMAZON_HOST_PATTERN = /(^|\.)amazon\.(com|nl|de|fr|es|it|co\.uk)$/i;

const STANDARD_PRICE_ALARM = 'checkPricesAlarm';
const STANDARD_BATCH_DELAY_MS = 30 * 1000;
const {
  LEGACY_TARGET_NOTIFICATION_ID,
  decideLegacyTargetNotice,
  isLegacyTargetNoticeNotification
} = globalThis.LegacyTargetNotice;
const ALARM_DEFINITIONS = [
  ['checkPriorityPricesAlarm', { periodInMinutes: 2 }],
  ['checkWishlistsAlarm', { periodInMinutes: 15 }]
];

let legacyTargetNoticeQueue = Promise.resolve();

async function maybeNotifyLegacyTargetUpgrade() {
  try {
    const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
    const existingMarker = await getStorageData(StorageKeys.LEGACY_TARGET_NOTICE, StorageArea.LOCAL);
    const decision = await decideLegacyTargetNotice(settings, existingMarker, () =>
      chrome.notifications.create(LEGACY_TARGET_NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: 'assets/icon128.png',
        title: 'Action needed: previous target price',
        message: 'Old global target alerts are paused because their currency is unknown. Open Extension Settings to review it.',
        buttons: [{ title: 'Open Extension Settings' }]
      })
    );

    if (decision.clearMarker) {
      await chrome.storage.local.remove(StorageKeys.LEGACY_TARGET_NOTICE);
      return;
    }
    if (!decision.notify) return;

    // Mark both success and an unavailable notification service. That makes
    // this a one-time, non-spamming upgrade notice; a changed legacy value has
    // a different fingerprint and can still be surfaced once.
    await setStorageData(StorageKeys.LEGACY_TARGET_NOTICE, {
      fingerprint: decision.fingerprint,
      outcome: decision.outcome
    }, StorageArea.LOCAL);
    if (decision.outcome === 'unavailable') {
      console.warn('Could not show legacy target upgrade notice; the Dashboard warning remains available.');
    }
  } catch (error) {
    // Startup and alarms must remain usable if either storage area is briefly
    // unavailable. The dashboard will present its retryable fallback instead.
    console.warn('Could not check legacy target upgrade notice:', error);
  }
}

function queueLegacyTargetUpgradeNotice() {
  const run = legacyTargetNoticeQueue.then(maybeNotifyLegacyTargetUpgrade);
  legacyTargetNoticeQueue = run.catch(() => {});
  return run;
}

async function scheduleStandardPriceCheck(when = Date.now() + STANDARD_BATCH_DELAY_MS) {
  await chrome.alarms.create(STANDARD_PRICE_ALARM, {
    when: Math.max(when, Date.now() + STANDARD_BATCH_DELAY_MS)
  });
}

async function ensureAlarms() {
  const standardAlarm = await chrome.alarms.get(STANDARD_PRICE_ALARM);
  if (!standardAlarm || standardAlarm.periodInMinutes != null) {
    await scheduleStandardPriceCheck();
  }

  for (const [name, config] of ALARM_DEFINITIONS) {
    const existing = await chrome.alarms.get(name);
    if (!existing || existing.periodInMinutes !== config.periodInMinutes) {
      await chrome.alarms.create(name, config);
    }
  }
}

// Process a small slice per alarm instead of one long all-items run. Ensure the
// alarms exist after install, browser startup, and service-worker reload.
chrome.runtime.onInstalled.addListener(() => {
  console.log('Amazon Wishlist Tracker installed.');
  ensureAlarms();
  updateBadgeCount();
  queueLegacyTargetUpgradeNotice();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  updateBadgeCount();
  queueLegacyTargetUpgradeNotice();
});
ensureAlarms();
updateBadgeCount();
queueLegacyTargetUpgradeNotice();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    (areaName === StorageArea.LOCAL && changes[StorageKeys.TRACKED_ITEMS]) ||
    (areaName === StorageArea.SYNC && changes[StorageKeys.SETTINGS])
  ) {
    updateBadgeCount();
  }
  if (areaName === StorageArea.SYNC && changes[StorageKeys.SETTINGS]) {
    queueLegacyTargetUpgradeNotice();
  }
});

// Adaptive, priority, and wishlist alarms can coincide. Chain all network jobs
// through one queue so they share request pressure and storage ownership.
let scrapeJobQueue = Promise.resolve();
function enqueueScrapeJob(job) {
  const run = scrapeJobQueue.then(job);
  scrapeJobQueue = run.catch(() => {});
  return run;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkPricesAlarm') {
    console.log('Running scheduled price check...');
    try {
      await enqueueScrapeJob(async () => {
        await runPriceCheckBatch();
        await prunePriceHistory();
      });
    } catch (err) {
      console.error('Adaptive price batch failed:', err);
    } finally {
      // A one-shot alarm is removed when it fires. Ensure unexpected failures
      // cannot leave standard tracking permanently unscheduled.
      const nextAlarm = await chrome.alarms.get(STANDARD_PRICE_ALARM);
      if (!nextAlarm) await scheduleStandardPriceCheck(Date.now() + 60 * 1000);
    }
  } else if (alarm.name === 'checkPriorityPricesAlarm') {
    console.log('Running priority price check...');
    await enqueueScrapeJob(runPriorityPriceCheckBatch);
  } else if (alarm.name === 'checkWishlistsAlarm') {
    console.log('Running wishlist bulk scrape...');
    await enqueueScrapeJob(runWishlistCheckBatch);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'UPDATE_TRACKED_ITEM') {
    (async () => {
      try {
        if (!message.item?.id) {
          sendResponse({ error: 'Missing product identifier.' });
          return;
        }
        const itemUpdate = { ...message.item };
        if ('targetPrice' in itemUpdate || 'targetDiscountPercentage' in itemUpdate || 'isPriority' in itemUpdate) {
          itemUpdate.nextPriceCheckAt = Date.now();
          itemUpdate.checkCadence = 'Preference changed · due now';
        }
        await saveTrackedItem(itemUpdate);
        await scheduleStandardPriceCheck();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to update item' });
      }
    })();
    return true;
  }

  if (message.type === 'REMOVE_TRACKED_ITEM') {
    (async () => {
      try {
        if (!message.id) {
          sendResponse({ error: 'Missing product identifier.' });
          return;
        }
        await updateTrackedItems(items => items.filter(item => item.id !== message.id));
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to remove item' });
      }
    })();
    return true;
  }

  if (message.type === 'MIGRATE_LEGACY_TARGET_PRICE') {
    (async () => {
      try {
        const targetPrice = Number(message.targetPrice);
        const currency = typeof message.currency === 'string' ? message.currency.trim() : '';
        const expectedCount = Number(message.expectedCount);
        if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !currency || !Number.isInteger(expectedCount) || expectedCount < 1) {
          sendResponse({ error: 'Invalid legacy target migration.' });
          return;
        }

        const result = await updateTrackedItemsIf((items) => {
          const itemCurrencies = items.map((item) => typeof item.currency === 'string' ? item.currency.trim() : '');
          const allItemsShareRequestedCurrency =
            items.length > 0 &&
            itemCurrencies.every(Boolean) &&
            new Set(itemCurrencies).size === 1 &&
            itemCurrencies[0] === currency;
          const eligibleCount = items.filter((item) => !Number.isFinite(item.targetPrice)).length;
          if (!allItemsShareRequestedCurrency || eligibleCount !== expectedCount) {
            return { commit: false, result: { error: 'Legacy target can no longer be copied safely.' } };
          }

          const dueNow = Date.now();
          return {
            commit: true,
            items: items.map((item) => Number.isFinite(item.targetPrice)
              ? item
              : {
                  ...item,
                  targetPrice,
                  updatedAt: dueNow,
                  nextPriceCheckAt: dueNow,
                  checkCadence: 'Legacy target migration · due now'
                }),
            result: { updated: eligibleCount }
          };
        });
        if (result?.error) {
          sendResponse({ error: result.error });
          return;
        }
        await scheduleStandardPriceCheck();
        sendResponse({ success: true, updated: result?.updated });
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to migrate legacy target price' });
      }
    })();
    return true;
  }

  if (message.type === 'ADD_TRACKED_ITEM') {
    (async () => {
      try {
        const itemUrl = new URL(message.item?.url || '');
        if (!AMAZON_HOST_PATTERN.test(itemUrl.hostname)) {
          sendResponse({ error: 'Unsupported Amazon URL.' });
          return;
        }
        if (!message.item?.id) {
          sendResponse({ error: 'Missing product identifier.' });
          return;
        }

        const items = await getTrackedItems();
        if (items.some(i => i.id === message.item.id)) {
          await saveTrackedItem({ id: message.item.id, trackedIndividually: true });
          sendResponse({ exists: true });
          return;
        }

        // Apply the user's default discount alert (configured in Options) so the
        // setting actually takes effect on newly tracked items.
        const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
        const item = { ...message.item, trackedIndividually: true };
        if (settings.defaultDiscount && !item.targetDiscountPercentage) {
          item.targetDiscountPercentage = parseInt(settings.defaultDiscount, 10);
        }

        await saveTrackedItem(item);
        await scheduleStandardPriceCheck();
        sendResponse({ success: true });
      } catch (err) {
        console.error('Failed to add tracked item:', err);
        sendResponse({ error: err.message || 'Failed to add item' });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (message.type === 'CHECK_IF_TRACKED') {
    (async () => {
      try {
        const items = await getTrackedItems();
        const isTracked = items.some(i => i.id === message.asin);
        sendResponse({ isTracked });
      } catch (err) {
        console.error('Failed to check if tracked:', err);
        sendResponse({ isTracked: false });
      }
    })();
    return true;
  }

  if (message.type === 'EXTRACT_WISHLIST') {
    (async () => {
      try {
        const url = message.url;
        const result = await enqueueScrapeJob(() => scrapeAmazonWishlist(url));
        if (result.success) {
          sendResponse({ success: true, items: result.items });
        } else {
          sendResponse({ error: result.error });
        }
      } catch (err) {
        console.error('Failed to extract wishlist:', err);
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'CLEAR_PRICE_HISTORY') {
    (async () => {
      try {
        await enqueueScrapeJob(() => setStorageItems({
          [StorageKeys.PRICE_HISTORY]: {}
        }, StorageArea.LOCAL));
        sendResponse({ success: true });
      } catch (err) {
        console.error('Failed to clear price history:', err);
        sendResponse({ error: err.message || 'Failed to clear price history' });
      }
    })();
    return true;
  }

  if (message.type === 'BULK_ADD_TRACKED_ITEMS') {
    (async () => {
      try {
        await enqueueScrapeJob(async () => {
          const historyObj = await getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL) || {};
          const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
          const defaultDiscount = settings.defaultDiscount ? parseInt(settings.defaultDiscount, 10) : null;
          const checkedAt = Date.now();

          let itemsChanged = false;
          let historyChanged = false;

          const recordWishlistFetch = (itemId, price) => {
            if (!itemId || !Number.isFinite(price)) return;
            if (!historyObj[itemId]) historyObj[itemId] = [];
            historyObj[itemId].push({ price, timestamp: checkedAt });
            historyChanged = true;
          };

          await updateTrackedItems((items) => {
            message.items.forEach(newItem => {
              const existingItem = items.find(i => i.id === newItem.id);
              if (!existingItem) {
                const itemToSave = {
                  ...newItem,
                  trackedIndividually: Boolean(newItem.trackedIndividually),
                  lastChecked: checkedAt,
                  updatedAt: checkedAt
                };
                if (defaultDiscount && !itemToSave.targetDiscountPercentage) {
                  itemToSave.targetDiscountPercentage = defaultDiscount;
                }
                items.push(itemToSave);
                recordWishlistFetch(itemToSave.id, itemToSave.currentPrice);
                setNextAdaptiveCheck(itemToSave, historyObj, checkedAt);
                itemsChanged = true;
                return;
              }

              for (const field of ['title', 'currentPrice', 'currency', 'inStock']) {
                if (newItem[field] != null) existingItem[field] = newItem[field];
              }
              if (newItem.url) existingItem.url = newItem.url;
              if (newItem.imageUrl) existingItem.imageUrl = newItem.imageUrl;
              if (newItem.originalPrice && (!existingItem.originalPrice || newItem.originalPrice > existingItem.originalPrice)) {
                existingItem.originalPrice = newItem.originalPrice;
              }
              for (const field of ['wishlistPriceDropPercent', 'wishlistPriceWhenAdded', 'wishlistPriceDropAmount', 'wishlistPriceDropText']) {
                if (newItem[field] != null) existingItem[field] = newItem[field];
              }
              if (Array.isArray(newItem.wishlistIds)) {
                existingItem.wishlistIds = [...new Set([...(existingItem.wishlistIds || []), ...newItem.wishlistIds])];
              }
              existingItem.lastChecked = checkedAt;
              existingItem.updatedAt = checkedAt;
              recordWishlistFetch(existingItem.id, newItem.currentPrice);
              setNextAdaptiveCheck(existingItem, historyObj, checkedAt);
              itemsChanged = true;
            });
            return items;
          });
          await scheduleStandardPriceCheck();

          if (itemsChanged || historyChanged) {
            const updates = {};
            if (historyChanged) updates[StorageKeys.PRICE_HISTORY] = historyObj;
            if (Object.keys(updates).length > 0) await setStorageItems(updates, StorageArea.LOCAL);
          }
        });

        sendResponse({ success: true });
      } catch (err) {
        console.error('Failed to bulk add tracked items:', err);
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }
});

// Helper for random delay (Jitter) to prevent scraping blocks
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Generic scrape back-off (covers CAPTCHA and rate-limit responses alike).
const BACKOFF_BASE_MS = 60 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const BACKOFF_ERRORS = new Set(['CAPTCHA_BLOCKED', 'RATE_LIMITED']);
const ITEMS_PER_ALARM = 8;
const MINUTE_MS = 60 * 1000;
const ADAPTIVE_INTERVALS = {
  nearTarget: 10 * MINUTE_MS,
  volatile: 15 * MINUTE_MS,
  stable: 90 * MINUTE_MS,
  unavailable: 3 * 60 * MINUTE_MS,
  retry: 15 * MINUTE_MS
};

const SCRAPE_OWNED_FIELDS = [
  'title', 'url', 'imageUrl', 'currentPrice', 'originalPrice', 'currency',
  'inStock', 'lastChecked', 'updatedAt', 'wasInStockPreviously', 'buyBoxPrice',
  'salesRank', 'wishlistPriceDropPercent', 'wishlistPriceWhenAdded',
  'wishlistPriceDropAmount', 'wishlistPriceDropText', 'wishlistIds',
  'nextPriceCheckAt', 'checkCadence'
];

function getAdaptiveCheckCadence(item, historyObj) {
  if (item.inStock === false) {
    return { delay: ADAPTIVE_INTERVALS.unavailable, reason: 'Out of stock · 3h cadence' };
  }

  if (Number.isFinite(item.targetPrice) && Number.isFinite(item.currentPrice)) {
    const distance = (item.currentPrice - item.targetPrice) / Math.max(item.targetPrice, 0.01);
    if (distance <= 0.1) {
      return { delay: ADAPTIVE_INTERVALS.nearTarget, reason: 'Near target · 10m cadence' };
    }
  }

  const priceDropPercent = item.wishlistPriceDropPercent || 0;
  if (Number.isFinite(item.targetDiscountPercentage) &&
      item.targetDiscountPercentage - priceDropPercent <= 5) {
    return { delay: ADAPTIVE_INTERVALS.nearTarget, reason: 'Near discount target · 10m cadence' };
  }

  const recentPrices = (historyObj[item.id] || [])
    .filter(point => Number.isFinite(point.price))
    .slice(-4)
    .map(point => point.price);
  if (recentPrices.length >= 2) {
    const low = Math.min(...recentPrices);
    const high = Math.max(...recentPrices);
    if (low > 0 && (high - low) / low >= 0.02) {
      return { delay: ADAPTIVE_INTERVALS.volatile, reason: 'Recent price movement · 15m cadence' };
    }
  }

  return { delay: ADAPTIVE_INTERVALS.stable, reason: 'Stable · 90m cadence' };
}

function setNextAdaptiveCheck(item, historyObj, timestamp) {
  const cadence = getAdaptiveCheckCadence(item, historyObj);
  item.nextPriceCheckAt = timestamp + cadence.delay;
  item.checkCadence = cadence.reason;
}

async function persistScrapeResults(scrapedItems, changedIds, newIds = new Set(), removedIds = new Set()) {
  const scrapedById = new Map(scrapedItems.map(item => [item.id, item]));
  await updateTrackedItems((latestItems) => {
    const latestIds = new Set(latestItems.map(item => item.id));
    const merged = latestItems.flatMap((current) => {
      if (removedIds.has(current.id)) return [];
      if (!changedIds.has(current.id)) return [current];
      const scraped = scrapedById.get(current.id);
      if (!scraped || scraped.isPurchased) return [];

      const next = { ...current };
      SCRAPE_OWNED_FIELDS.forEach((field) => {
        if (scraped[field] !== undefined) next[field] = scraped[field];
      });
      return [next];
    });

    newIds.forEach((id) => {
      const scraped = scrapedById.get(id);
      if (scraped && !scraped.isPurchased && !latestIds.has(id)) merged.push(scraped);
    });
    return merged;
  });
}

async function runPriceCheckBatch() {
  const backoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
  if (backoffUntil && Date.now() < backoffUntil) {
    console.warn(`Scraping paused until ${new Date(backoffUntil).toISOString()} due to scrape backoff.`);
    await scheduleStandardPriceCheck(backoffUntil);
    return;
  }
  let isBackoffActive = false;

  const [allItems, history, settings] = await Promise.all([
    getTrackedItems(),
    getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL),
    getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC)
  ]);
  const items = (allItems || []).filter(item => !item.isPriority);
  if (items.length === 0) {
    await scheduleStandardPriceCheck(Date.now() + 5 * MINUTE_MS);
    return;
  }

  const historyObj = history || {};
  const now = Date.now();
  const dueItems = items
    .filter(item => !Number.isFinite(item.nextPriceCheckAt) || item.nextPriceCheckAt <= now)
    .sort((a, b) => {
      const dueA = Number.isFinite(a.nextPriceCheckAt) ? a.nextPriceCheckAt : 0;
      const dueB = Number.isFinite(b.nextPriceCheckAt) ? b.nextPriceCheckAt : 0;
      return dueA - dueB || (a.lastChecked || 0) - (b.lastChecked || 0);
    });

  if (dueItems.length === 0) {
    const earliestNextCheck = Math.min(...items.map(item => item.nextPriceCheckAt));
    await scheduleStandardPriceCheck(earliestNextCheck);
    return;
  }

  const itemsToProcess = dueItems.slice(0, ITEMS_PER_ALARM);
  let changedItems = false;
  const changedIds = new Set();

  try {
    for (let offset = 0; offset < itemsToProcess.length; offset++) {
      const item = itemsToProcess[offset];

      try {
        const result = await scrapeAmazonProduct(item.url);
        const checkedAt = Date.now();
        if (result && result.success) {
          processScrapeResult(item, result, historyObj, checkedAt, settings || {});
          setNextAdaptiveCheck(item, historyObj, checkedAt);
          changedItems = true;
          changedIds.add(item.id);
        } else if (result && BACKOFF_ERRORS.has(result.error)) {
          isBackoffActive = true;
          console.error(`${result.error} detected on ${item.url}. Triggering scrape backoff.`);
        } else {
          item.nextPriceCheckAt = checkedAt + ADAPTIVE_INTERVALS.retry;
          item.checkCadence = 'Retry after failed check · 15m';
          changedItems = true;
          changedIds.add(item.id);
          console.warn(`Failed to scrape ${item.url}:`, result?.error);
        }
      } catch (err) {
        if (BACKOFF_ERRORS.has(err.message)) {
          isBackoffActive = true;
        } else {
          item.nextPriceCheckAt = Date.now() + ADAPTIVE_INTERVALS.retry;
          item.checkCadence = 'Retry after failed check · 15m';
          changedItems = true;
          changedIds.add(item.id);
        }
        console.error(`Error processing item ${item.id}:`, err);
      }

      if (isBackoffActive) {
        console.warn('Aborting remaining slice due to scrape backoff.');
        break;
      }

      // Balanced mode: modest jitter keeps throughput high while preserving a
      // sequential request profile and the existing adaptive backoff.
      if (offset + 1 < itemsToProcess.length) {
        const jitter = Math.floor(Math.random() * 1000) + 1000;
        await delay(jitter);
      }
    }
  } finally {
    await closeOffscreenDocument();
  }

  if (isBackoffActive) {
    await activateBackoff();
  } else {
    await clearBackoff();
  }

  // Persist all run state in a single storage write.
  const updates = { [StorageKeys.LAST_SCRAPE_TIME]: Date.now() };
  if (changedItems) {
    await persistScrapeResults(items, changedIds);
    updates[StorageKeys.PRICE_HISTORY] = historyObj;
  }
  await setStorageItems(updates, StorageArea.LOCAL);

  if (isBackoffActive) {
    const activeBackoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
    await scheduleStandardPriceCheck(activeBackoffUntil || Date.now() + BACKOFF_BASE_MS);
    return;
  }

  const scheduleTime = items.some(item => !Number.isFinite(item.nextPriceCheckAt) || item.nextPriceCheckAt <= Date.now())
    ? Date.now() + STANDARD_BATCH_DELAY_MS
    : Math.min(...items.map(item => item.nextPriceCheckAt));
  await scheduleStandardPriceCheck(scheduleTime);
}

async function runPriorityPriceCheckBatch() {
  const backoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
  if (backoffUntil && Date.now() < backoffUntil) return;
  
  let isBackoffActive = false;

  const [allItems, history, cursorValue, settings] = await Promise.all([
    getTrackedItems(),
    getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL),
    getStorageData(StorageKeys.PRIORITY_SCRAPE_CURSOR, StorageArea.LOCAL),
    getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC)
  ]);
  if (!allItems) return;

  // Filter only priority items
  const items = allItems.filter(i => i.isPriority);
  if (items.length === 0) return;

  const historyObj = history || {};
  const startCursor = Number.isInteger(cursorValue) ? cursorValue % items.length : 0;
  // We process up to 5 priority items per fast cycle
  const itemsToProcess = Math.min(5, items.length);
  let changedItems = false;
  let processedCount = 0;
  const changedIds = new Set();

  try {
    for (let offset = 0; offset < itemsToProcess; offset++) {
      const item = items[(startCursor + offset) % items.length];

      try {
        const result = await scrapeAmazonProduct(item.url);
        const checkedAt = Date.now();
        processedCount++;
        if (result && result.success) {
          processScrapeResult(item, result, historyObj, checkedAt, settings || {});
          item.nextPriceCheckAt = checkedAt + 2 * MINUTE_MS;
          item.checkCadence = 'Priority · 2m queue';
          changedItems = true;
          changedIds.add(item.id);
          // Sync changes back to the main array
          const mainIndex = allItems.findIndex(i => i.id === item.id);
          if (mainIndex > -1) allItems[mainIndex] = item;
        } else if (result && BACKOFF_ERRORS.has(result.error)) {
          isBackoffActive = true;
        } else {
          item.nextPriceCheckAt = checkedAt + ADAPTIVE_INTERVALS.retry;
          item.checkCadence = 'Retry after failed check · 15m';
          changedItems = true;
          changedIds.add(item.id);
        }
      } catch (err) {
        processedCount++;
        if (BACKOFF_ERRORS.has(err.message)) {
          isBackoffActive = true;
        } else {
          item.nextPriceCheckAt = Date.now() + ADAPTIVE_INTERVALS.retry;
          item.checkCadence = 'Retry after failed check · 15m';
          changedItems = true;
          changedIds.add(item.id);
        }
      }

      if (isBackoffActive) break;

      if (offset + 1 < itemsToProcess) {
        const jitter = Math.floor(Math.random() * 1000) + 1000;
        await delay(jitter);
      }
    }
  } finally {
    await closeOffscreenDocument();
  }

  if (isBackoffActive) {
    await activateBackoff();
  } else {
    await clearBackoff();
  }

  const updates = {};
  if (changedItems) {
    await persistScrapeResults(allItems, changedIds);
    updates[StorageKeys.PRICE_HISTORY] = historyObj;
  }
  if (processedCount > 0) {
    updates[StorageKeys.PRIORITY_SCRAPE_CURSOR] = (startCursor + processedCount) % items.length;
  }
  if (Object.keys(updates).length > 0) {
    await setStorageItems(updates, StorageArea.LOCAL);
  }
}

async function runWishlistCheckBatch() {
  const [trackedWishlists, items, storedHistory, settings, cursorValue, storedSyncState] = await Promise.all([
    getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL),
    getTrackedItems(),
    getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL),
    getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC),
    getStorageData(StorageKeys.WISHLIST_SCRAPE_CURSOR, StorageArea.LOCAL),
    getStorageData(StorageKeys.WISHLIST_SCRAPE_STATE, StorageArea.LOCAL)
  ]);
  const wishlists = trackedWishlists || [];
  const historyObj = storedHistory || {};
  const effectiveSettings = settings || {};
  const defaultDiscount = effectiveSettings.defaultDiscount ? parseInt(effectiveSettings.defaultDiscount, 10) : null;
  
  // Note: an empty tracked-items list must NOT skip the run — a wishlist with
  // autoSync can be the very thing that adds the first items.
  if (!wishlists.length) return;

  const backoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
  if (backoffUntil && Date.now() < backoffUntil) return;

  let isBackoffActive = false;
  const now = Date.now();
  let changedItems = false;
  const changedIds = new Set();
  const newIds = new Set();
  const removedIds = new Set();
  const startCursor = Number.isInteger(cursorValue) ? cursorValue % wishlists.length : 0;
  const wl = wishlists[startCursor];
  const wishlistId = typeof wl === 'string' ? wl : wl.id;
  const url = typeof wl === 'string'
    ? `https://www.amazon.com/hz/wishlist/ls/${wl}?viewType=list`
    : wl.url;
  const stateKey = wishlistId || url;
  const syncState = storedSyncState || {};
  const previousState = stateKey ? syncState[stateKey] : null;
  const scrapeUrl = previousState?.nextPageUrl || url;

  try {
    if (scrapeUrl) {
      try {
        const result = await scrapeAmazonWishlist(scrapeUrl, { maxPages: 8 });
        if (result && result.success && result.items) {
          const accumulatedById = new Map((previousState?.items || []).map(item => [item.id, item]));
          result.items.forEach(item => accumulatedById.set(item.id, item));
          result.items = [...accumulatedById.values()];

          const partialDisposition = globalThis.wishlistPartialPolicy.getPartialWishlistDisposition(result);
          if (partialDisposition.preservesResumeState && stateKey) {
            syncState[stateKey] = {
              nextPageUrl: result.nextPageUrl,
              items: result.items,
              startedAt: previousState?.startedAt || now,
              updatedAt: now
            };
            await setStorageItems({ [StorageKeys.WISHLIST_SCRAPE_STATE]: syncState }, StorageArea.LOCAL);

            // `scrapeAmazonWishlist` deliberately returns the pages it did
            // finish when a later page is blocked. Preserve that resume state,
            // but do not mistake a partial success for a clean traversal: the
            // global circuit breaker must still protect every scrape route.
            if (partialDisposition.activatesBackoff) {
              await activateBackoff();
              const activeBackoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
              await scheduleStandardPriceCheck(activeBackoffUntil || Date.now() + BACKOFF_BASE_MS);
            } else {
              await clearBackoff();
            }
            return;
          }

          if (stateKey) delete syncState[stateKey];
          result.items.forEach(extractedItem => {
            const trackedItem = items.find(i => i.id === extractedItem.id);
            const simulatedResult = {
              success: true,
              price: extractedItem.currentPrice,
              currency: extractedItem.currency,
              wishlistPriceDropPercent: extractedItem.wishlistPriceDropPercent,
              wishlistPriceWhenAdded: extractedItem.wishlistPriceWhenAdded,
              wishlistPriceDropAmount: extractedItem.wishlistPriceDropAmount,
              wishlistPriceDropText: extractedItem.wishlistPriceDropText,
              inStock: extractedItem.inStock,
              isPurchased: extractedItem.isPurchased,
              buyBoxPrice: null,
              salesRank: null
            };
            
            if (trackedItem) {
              processScrapeResult(trackedItem, simulatedResult, historyObj, now, settings || {});
              setNextAdaptiveCheck(trackedItem, historyObj, now);
              changedItems = true;
              changedIds.add(trackedItem.id);
            } else if (typeof wl !== 'string' && wl.autoSync) {
              const newItem = {
                id: extractedItem.id,
                url: extractedItem.url,
                title: extractedItem.title,
                addedAt: now,
                updatedAt: now,
                lastChecked: now,
                currentPrice: extractedItem.currentPrice,
                currency: extractedItem.currency,
                inStock: extractedItem.inStock,
                originalPrice: extractedItem.originalPrice || extractedItem.currentPrice,
                wishlistPriceDropPercent: extractedItem.wishlistPriceDropPercent,
                wishlistPriceWhenAdded: extractedItem.wishlistPriceWhenAdded,
                wishlistPriceDropAmount: extractedItem.wishlistPriceDropAmount,
                wishlistPriceDropText: extractedItem.wishlistPriceDropText,
                wishlistIds: wishlistId ? [wishlistId] : []
              };
              if (defaultDiscount) newItem.targetDiscountPercentage = defaultDiscount;
              
              items.push(newItem);
              processScrapeResult(newItem, simulatedResult, historyObj, now, settings || {});
              setNextAdaptiveCheck(newItem, historyObj, now);
              changedItems = true;
              changedIds.add(newItem.id);
              newIds.add(newItem.id);
            }
          });

          // Only reconcile removals after a complete traversal. A partial
          // pagination result must never make missing rows look deleted.
          if (typeof wl !== 'string' && wl.autoSync && wishlistId && result.complete !== false) {
            const visibleIds = new Set(result.items.map(item => item.id));
            items.forEach((item) => {
              if (!item.wishlistIds?.includes(wishlistId) || visibleIds.has(item.id)) return;
              item.wishlistIds = item.wishlistIds.filter(id => id !== wishlistId);
              if (item.wishlistIds.length === 0 && !item.trackedIndividually) {
                removedIds.add(item.id);
                delete historyObj[item.id];
              } else {
                changedIds.add(item.id);
              }
              changedItems = true;
            });
          }
        } else if (result && BACKOFF_ERRORS.has(result.error)) {
          isBackoffActive = true;
        }
      } catch (err) {
        if (BACKOFF_ERRORS.has(err.message)) isBackoffActive = true;
      }
    }
  } finally {
    await closeOffscreenDocument();
  }

  if (isBackoffActive) {
    await activateBackoff();
  } else {
    await clearBackoff();
  }

  const updates = {
    [StorageKeys.WISHLIST_SCRAPE_CURSOR]: (startCursor + 1) % wishlists.length,
    [StorageKeys.WISHLIST_SCRAPE_STATE]: syncState
  };
  if (changedItems) {
    await persistScrapeResults(items, changedIds, newIds, removedIds);
    updates[StorageKeys.PRICE_HISTORY] = historyObj;
  }
  await setStorageItems(updates, StorageArea.LOCAL);
}

async function activateBackoff() {
  const attempts = (await getStorageData(StorageKeys.CAPTCHA_BACKOFF_ATTEMPTS, StorageArea.LOCAL) || 0) + 1;
  const backoffMs = Math.min(BACKOFF_BASE_MS * (2 ** (attempts - 1)), BACKOFF_MAX_MS);

  await setStorageItems({
    [StorageKeys.CAPTCHA_BACKOFF_ATTEMPTS]: attempts,
    [StorageKeys.CAPTCHA_BACKOFF_UNTIL]: Date.now() + backoffMs
  }, StorageArea.LOCAL);
  console.warn(`Scrape backoff active for ${Math.round(backoffMs / 60000)} minutes.`);
}

async function clearBackoff() {
  await setStorageItems({
    [StorageKeys.CAPTCHA_BACKOFF_ATTEMPTS]: 0,
    [StorageKeys.CAPTCHA_BACKOFF_UNTIL]: 0
  }, StorageArea.LOCAL);
}

function processScrapeResult(item, result, historyObj, timestamp = Date.now(), settings = {}) {
  if (result.isPurchased) {
    item.isPurchased = true;
    delete historyObj[item.id];
    sendNotification(item, `This item has been purchased and is removed from tracking.`);
    return;
  }

  if (result.price == null) {
    console.warn(`Skipping history and price alerts for ${item.id}: no price found.`);
    item.inStock = result.inStock;
    item.currency = result.currency || item.currency;
    applyWishlistPriceDrop(item, result);
    item.salesRank = result.salesRank;
    item.lastChecked = timestamp;
    item.updatedAt = timestamp;
    item.wasInStockPreviously = result.inStock;
    return;
  }

  // Initialize history array if needed
  if (!historyObj[item.id]) {
    historyObj[item.id] = [];
  }

  const currentPrice = result.price;
  const previousPrice = item.currentPrice;

  // Update item data
  item.currentPrice = currentPrice;
  item.inStock = result.inStock;
  item.currency = result.currency || item.currency;
  applyWishlistPriceDrop(item, result);
  item.buyBoxPrice = result.buyBoxPrice;
  item.salesRank = result.salesRank;
  item.lastChecked = timestamp;
  item.updatedAt = timestamp;

  // Save to history
  historyObj[item.id].push({
    price: currentPrice,
    timestamp
  });

  // Check for alerts
  let alertTriggered = false;
  let alertMessage = '';

  // 1. Target Price Alert
  const targetPrice = item.targetPrice;
  if (targetPrice && currentPrice <= targetPrice && (previousPrice == null || previousPrice > targetPrice)) {
    alertTriggered = true;
    alertMessage = `Price dropped to or below your target of ${formatPrice(targetPrice, item.currency)}! Now: ${formatPrice(currentPrice, item.currency)}`;
  }

  // 2. Discount Percentage Alert
  const targetDiscount = item.targetDiscountPercentage || settings.defaultDiscount;
  if (targetDiscount) {
    let currentDiscount = 0;
    if (item.originalPrice && item.originalPrice > currentPrice) {
      currentDiscount = ((item.originalPrice - currentPrice) / item.originalPrice) * 100;
    } else if (result.wishlistPriceDropPercent != null) {
      currentDiscount = result.wishlistPriceDropPercent;
    }
    
    if (currentDiscount >= targetDiscount && (previousPrice == null || previousPrice > currentPrice)) {
      alertTriggered = true;
      alertMessage = `Discount reached ${currentDiscount.toFixed(1)}%! Now: ${formatPrice(currentPrice, item.currency)}`;
    }
  }

  // 3. Restock Alert
  if (result.inStock && item.wasInStockPreviously === false) {
    alertTriggered = true;
    alertMessage = `Item is back in stock at ${formatPrice(currentPrice, item.currency)}`;
  }
  
  item.wasInStockPreviously = result.inStock;

  // Dispatch Notification
  if (alertTriggered) {
    sendNotification(item, alertMessage);
  }
}

function applyWishlistPriceDrop(item, result) {
  if (result.wishlistPriceDropPercent != null) {
    item.wishlistPriceDropPercent = result.wishlistPriceDropPercent;
  }
  if (result.wishlistPriceWhenAdded != null) {
    item.wishlistPriceWhenAdded = result.wishlistPriceWhenAdded;
    if (!item.originalPrice || result.wishlistPriceWhenAdded > item.originalPrice) {
      item.originalPrice = result.wishlistPriceWhenAdded;
    }
  }
  if (result.wishlistPriceDropAmount != null) {
    item.wishlistPriceDropAmount = result.wishlistPriceDropAmount;
  }
  if (result.wishlistPriceDropText) {
    item.wishlistPriceDropText = result.wishlistPriceDropText;
  }
}

function sendNotification(item, message) {
  chrome.notifications.create(item.id, {
    type: 'basic',
    iconUrl: 'assets/icon128.png',
    title: 'Amazon Price Alert: ' + (item.title || 'Tracked Item'),
    message: message,
    buttons: [{ title: 'View on Amazon' }]
  });
}

async function openTrackedItem(notificationId) {
  const items = await getTrackedItems();
  const item = items.find(i => i.id === notificationId);
  if (item?.url) {
    chrome.tabs.create({ url: item.url });
  }
}

async function openExtensionSettings() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    console.warn('Could not open Extension Settings:', error);
  }
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (isLegacyTargetNoticeNotification(notificationId) && buttonIndex === 0) {
    await openExtensionSettings();
    return;
  }
  if (buttonIndex === 0) {
    await openTrackedItem(notificationId);
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (isLegacyTargetNoticeNotification(notificationId)) {
    await openExtensionSettings();
    return;
  }
  await openTrackedItem(notificationId);
});

async function updateBadgeCount() {
  try {
    const items = await getTrackedItems() || [];
    const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
    
    let discountedCount = 0;
    
    for (const item of items) {
      if (!item.currentPrice || item.isPurchased) continue;
      
      let isDiscounted = false;
      
      const targetDiscount = item.targetDiscountPercentage || settings.defaultDiscount;
      if (targetDiscount) {
        if (item.originalPrice && item.originalPrice > item.currentPrice) {
          const discount = ((item.originalPrice - item.currentPrice) / item.originalPrice) * 100;
          if (discount >= targetDiscount) {
            isDiscounted = true;
          }
        }
        if (!isDiscounted && item.wishlistPriceDropPercent != null && item.wishlistPriceDropPercent >= targetDiscount) {
          isDiscounted = true;
        }
      }
      
      const targetPrice = item.targetPrice;
      if (!isDiscounted && targetPrice && item.currentPrice <= targetPrice) {
        isDiscounted = true;
      }
      
      if (isDiscounted) {
        discountedCount++;
      }
    }
    
    const text = discountedCount > 0 ? discountedCount.toString() : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#ff0000' });
  } catch (err) {
    console.error('Failed to update badge count:', err);
  }
}
