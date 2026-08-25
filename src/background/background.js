import { scrapeAmazonProduct, scrapeAmazonWishlist, closeOffscreenDocument } from './scraper.js';
import { getTrackedItems, saveTrackedItem, updateTrackedItems, updateTrackedItemsWithFinalizer, replaceTrackingData, updatePriceHistory, clearPriceHistory, getStorageData, setStorageData, setStorageItems, formatPrice, prunePriceHistory, StorageKeys, StorageArea } from '../utils/storage.js';
import { normalizeStoredAmazonProductUrl, sanitizeAmazonImageUrl } from '../utils/amazon.js';
import { validateBackupPayload } from '../utils/backup.js';
import './legacy_target_notice.js';
import './wishlist_partial_policy.js';

const AMAZON_HOST_PATTERN = /(^|\.)amazon\.(com|nl|de|fr|es|it|co\.uk)$/i;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const PRODUCT_PATH_PATTERN = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i;
const MAX_TRACKED_ITEMS = 5000;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 2048;
const MAX_PRICE_VALUE = 1_000_000_000;
const ADD_RATE_WINDOW_MS = 1500;
const MAX_BULK_IMPORT_ITEMS = 2000;
const recentAddsByTab = new Map();
const WISHLIST_CHUNK_MAX_PAGES = 8;
const WISHLIST_TOTAL_MAX_PAGES = 150;
const WISHLIST_TOTAL_MAX_ITEMS = 2000;
const WISHLIST_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const WISHLIST_TOTAL_MAX_ELAPSED_MS = 6 * 60 * 60 * 1000;
const WISHLIST_STATE_MAX_BYTES = 12 * 1024 * 1024;
const {
  LEGACY_TARGET_NOTIFICATION_ID,
  decideLegacyTargetNotice,
  isLegacyTargetNoticeNotification
} = globalThis.LegacyTargetNotice;
let legacyTargetNoticeQueue = Promise.resolve();

const STANDARD_PRICE_ALARM = 'checkPricesAlarm';
const STANDARD_BATCH_DELAY_MS = 30 * 1000;
const WISHLIST_CONTINUE_ALARM = 'continueWishlistSyncAlarm';
const WISHLIST_CONTINUE_DELAY_MS = 60 * 1000;
const ALARM_DEFINITIONS = [
  ['checkPriorityPricesAlarm', { periodInMinutes: 2 }],
  ['checkWishlistsAlarm', { periodInMinutes: 15 }]
];

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

    await setStorageData(StorageKeys.LEGACY_TARGET_NOTICE, {
      fingerprint: decision.fingerprint,
      outcome: decision.outcome
    }, StorageArea.LOCAL);
    if (decision.outcome === 'unavailable') {
      console.warn('Could not show legacy target upgrade notice; the Dashboard warning remains available.');
    }
  } catch (error) {
    console.warn('Could not check legacy target upgrade notice:', error);
  }
}

function queueLegacyTargetUpgradeNotice() {
  const run = legacyTargetNoticeQueue.then(maybeNotifyLegacyTargetUpgrade);
  legacyTargetNoticeQueue = run.catch(() => {});
  return run;
}

function productAsinFromUrl(url) {
  const match = url.pathname.match(PRODUCT_PATH_PATTERN);
  const asin = match ? match[1].toUpperCase() : null;
  return asin && ASIN_PATTERN.test(asin) ? asin : null;
}

function boundedPrice(value, fieldName) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE_VALUE) {
    throw new Error(`Invalid ${fieldName}.`);
  }
  return value;
}

function optionalBoundedNumber(value, fieldName, { min = 0, max = MAX_PRICE_VALUE } = {}) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${fieldName}.`);
  }
  return value;
}

function sanitizeBulkTrackedItem(rawItem, fallbackItem = null) {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new Error('Invalid wishlist item.');
  }
  const id = typeof rawItem.id === 'string' ? rawItem.id.toUpperCase() : '';
  if (!ASIN_PATTERN.test(id)) throw new Error('Invalid wishlist product identifier.');
  const url = normalizeStoredAmazonProductUrl(rawItem.url || fallbackItem?.url, id);
  if (!url) throw new Error('Invalid wishlist product URL.');
  const titleSource = rawItem.title ?? fallbackItem?.title;
  const title = typeof titleSource === 'string' ? titleSource.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) throw new Error('Invalid wishlist product title.');
  const currencySource = rawItem.currency ?? fallbackItem?.currency;
  const currency = currencySource == null ? null : String(currencySource).trim();
  if (currency && currency.length > 8) throw new Error('Invalid wishlist currency.');
  const wishlistIds = Array.isArray(rawItem.wishlistIds)
    ? [...new Set(rawItem.wishlistIds.filter((value) => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value)))].slice(0, 20)
    : (Array.isArray(fallbackItem?.wishlistIds) ? fallbackItem.wishlistIds.slice(0, 20) : []);
  const dropText = typeof rawItem.wishlistPriceDropText === 'string'
    ? rawItem.wishlistPriceDropText.replace(/\s+/g, ' ').trim().slice(0, 500)
    : null;

  return {
    id,
    title,
    url,
    imageUrl: sanitizeAmazonImageUrl(rawItem.imageUrl || fallbackItem?.imageUrl || '', url),
    currentPrice: optionalBoundedNumber(rawItem.currentPrice ?? fallbackItem?.currentPrice, 'wishlist current price'),
    originalPrice: optionalBoundedNumber(rawItem.originalPrice ?? fallbackItem?.originalPrice, 'wishlist original price'),
    currency: currency || null,
    inStock: rawItem.inStock ?? fallbackItem?.inStock ?? true,
    wishlistItemId: typeof (rawItem.wishlistItemId ?? fallbackItem?.wishlistItemId) === 'string' ? (rawItem.wishlistItemId ?? fallbackItem.wishlistItemId).slice(0, 128) : null,
    wishlistPriceDropPercent: optionalBoundedNumber(rawItem.wishlistPriceDropPercent ?? fallbackItem?.wishlistPriceDropPercent, 'wishlist drop percent', { max: 100 }),
    wishlistPriceWhenAdded: optionalBoundedNumber(rawItem.wishlistPriceWhenAdded ?? fallbackItem?.wishlistPriceWhenAdded, 'wishlist price when added'),
    wishlistPriceDropAmount: optionalBoundedNumber(rawItem.wishlistPriceDropAmount ?? fallbackItem?.wishlistPriceDropAmount, 'wishlist drop amount'),
    wishlistPriceDropText: dropText,
    wishlistIds,
    trackedIndividually: Boolean(rawItem.trackedIndividually ?? fallbackItem?.trackedIndividually)
  };
}

// ADD_TRACKED_ITEM is accepted only from this extension's top-frame content
// script and is bound to the exact HTTPS Amazon product visible in that tab.
export function validateAddTrackedItemRequest(message, sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id)) {
    throw new Error('Unauthorized tracking request.');
  }
  if (Number.isInteger(sender.frameId) && sender.frameId !== 0) {
    throw new Error('Tracking is only allowed from the top-level product page.');
  }

  const rawItem = message?.item;
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new Error('Invalid tracked item.');
  }
  if (typeof rawItem.url !== 'string' || rawItem.url.length > MAX_URL_LENGTH ||
      typeof sender.tab.url !== 'string' || sender.tab.url.length > MAX_URL_LENGTH) {
    throw new Error('Invalid product URL.');
  }

  const itemUrl = new URL(rawItem.url);
  const senderUrl = new URL(sender.tab.url);
  if (itemUrl.protocol !== 'https:' || senderUrl.protocol !== 'https:' ||
      itemUrl.username || itemUrl.password || itemUrl.port ||
      senderUrl.username || senderUrl.password || senderUrl.port ||
      !AMAZON_HOST_PATTERN.test(itemUrl.hostname) ||
      !AMAZON_HOST_PATTERN.test(senderUrl.hostname) ||
      itemUrl.hostname.toLowerCase() !== senderUrl.hostname.toLowerCase()) {
    throw new Error('Unsupported Amazon URL.');
  }

  const itemAsin = productAsinFromUrl(itemUrl);
  const senderAsin = productAsinFromUrl(senderUrl);
  if (!ASIN_PATTERN.test(rawItem.id || '') || rawItem.id !== itemAsin || itemAsin !== senderAsin) {
    throw new Error('Product identifier does not match the active tab.');
  }

  if (typeof rawItem.title !== 'string') throw new Error('Missing product title.');
  const title = rawItem.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length > MAX_TITLE_LENGTH) throw new Error('Invalid product title.');
  if (rawItem.currency != null &&
      (typeof rawItem.currency !== 'string' || rawItem.currency.length > 8)) {
    throw new Error('Invalid currency.');
  }

  return {
    tabId: sender.tab.id,
    item: {
      id: itemAsin,
      title,
      url: `${itemUrl.origin}/dp/${itemAsin}`,
      currentPrice: boundedPrice(rawItem.currentPrice, 'current price'),
      currency: rawItem.currency || null,
      originalPrice: boundedPrice(rawItem.originalPrice, 'original price')
    }
  };
}

function enforceAddRateLimit(tabId, now = Date.now()) {
  const previousAdd = recentAddsByTab.get(tabId);
  if (Number.isFinite(previousAdd) && now - previousAdd < ADD_RATE_WINDOW_MS) {
    throw new Error('Please wait before tracking another product.');
  }
  recentAddsByTab.set(tabId, now);

  // Keep the service-worker guard bounded even across many short-lived tabs.
  if (recentAddsByTab.size > 1000) {
    for (const [id, timestamp] of recentAddsByTab) {
      if (now - timestamp > 60_000) recentAddsByTab.delete(id);
    }
  }
}

function isAuthorizedDashboardSender(sender) {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  if (Number.isInteger(sender.frameId) && sender.frameId !== 0) return false;
  const dashboardUrl = chrome.runtime.getURL?.('src/dashboard/dashboard.html');
  if (!dashboardUrl || sender.url.length > MAX_URL_LENGTH * 2) return false;
  try {
    const expected = new URL(dashboardUrl);
    const actual = new URL(sender.url);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch (_error) {
    return false;
  }
}

function isAuthorizedOptionsSender(sender) {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  if (Number.isInteger(sender.frameId) && sender.frameId !== 0) return false;
  const optionsUrl = chrome.runtime.getURL?.('src/options/options.html');
  if (!optionsUrl || sender.url.length > MAX_URL_LENGTH * 2) return false;
  try {
    const expected = new URL(optionsUrl);
    const actual = new URL(sender.url);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch (_error) {
    return false;
  }
}

async function acknowledgeLegacyTargetPrice(expectedTargetPrice) {
  const latestSettings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
  const latestTargetPrice = Number(latestSettings.defaultTargetPrice);
  if (!Object.hasOwn(latestSettings, 'defaultTargetPrice') ||
      !Number.isFinite(latestTargetPrice) || latestTargetPrice !== expectedTargetPrice) {
    return { error: 'The previous target changed. Reload Extension Settings and review it again.' };
  }

  const nextSettings = { ...latestSettings };
  delete nextSettings.defaultTargetPrice;
  await setStorageData(StorageKeys.SETTINGS, nextSettings, StorageArea.SYNC);
  let persistedSettings;
  try {
    persistedSettings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
  } catch (error) {
    // A resolved chrome.storage.set is the commit point. If only the optional
    // verification read fails, rolling Local items back would leave neither
    // the legacy setting nor the copied targets. Preserve the committed pair
    // and let later UI/storage reads observe the acknowledged state.
    console.warn('Legacy target acknowledgement committed but readback was unavailable:', error);
    return { settings: nextSettings, readbackUnavailable: true };
  }
  if (Object.hasOwn(persistedSettings, 'defaultTargetPrice')) {
    return { error: 'The previous target could not be acknowledged safely.' };
  }
  return { settings: persistedSettings };
}

async function scheduleStandardPriceCheck(when = Date.now() + STANDARD_BATCH_DELAY_MS) {
  await chrome.alarms.create(STANDARD_PRICE_ALARM, {
    when: Math.max(when, Date.now() + STANDARD_BATCH_DELAY_MS)
  });
}

async function scheduleWishlistContinuation(when = Date.now() + WISHLIST_CONTINUE_DELAY_MS) {
  await chrome.alarms.create(WISHLIST_CONTINUE_ALARM, {
    when: Math.max(when, Date.now() + WISHLIST_CONTINUE_DELAY_MS)
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

  const pendingWishlistSync = await getStorageData(StorageKeys.WISHLIST_SCRAPE_STATE, StorageArea.LOCAL);
  if (pendingWishlistSync && Object.keys(pendingWishlistSync).length > 0) {
    const continuationAlarm = await chrome.alarms.get(WISHLIST_CONTINUE_ALARM);
    if (!continuationAlarm) await scheduleWishlistContinuation();
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
export function enqueueScrapeJob(job) {
  const run = scrapeJobQueue.then(job);
  scrapeJobQueue = run.catch(() => {});
  return run;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkPricesAlarm') {
    console.log('Running scheduled price check...');
    try {
      // Keep retention maintenance inside the same ordering boundary as the
      // batch so restore/clear cannot commit between its settings read and
      // history write.
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
  } else if (alarm.name === 'checkWishlistsAlarm' || alarm.name === WISHLIST_CONTINUE_ALARM) {
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
        if (!isAuthorizedOptionsSender(sender)) {
          sendResponse({ error: 'Unauthorized legacy target migration.' });
          return;
        }
        const targetPrice = Number(message.targetPrice);
        const currency = typeof message.currency === 'string' ? message.currency.trim() : '';
        const expectedCount = Number(message.expectedCount);
        if (!Number.isFinite(targetPrice) || targetPrice <= 0 || targetPrice > MAX_PRICE_VALUE ||
            !currency || currency.length > 8 || !Number.isInteger(expectedCount) || expectedCount < 1) {
          sendResponse({ error: 'Invalid legacy target migration.' });
          return;
        }

        const latestSettings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
        const latestLegacyTarget = Number(latestSettings.defaultTargetPrice);
        if (!Object.hasOwn(latestSettings, 'defaultTargetPrice') ||
            !Number.isFinite(latestLegacyTarget) || latestLegacyTarget !== targetPrice) {
          sendResponse({ error: 'The previous target changed. Reload Extension Settings and review it again.' });
          return;
        }

        const result = await updateTrackedItemsWithFinalizer((items) => {
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
        }, async () => {
          const acknowledgement = await acknowledgeLegacyTargetPrice(targetPrice);
          if (acknowledgement.error) throw new Error(acknowledgement.error);
        });
        if (result?.error) {
          sendResponse({ error: result.error });
          return;
        }
        await scheduleStandardPriceCheck();
        sendResponse({ success: true, updated: result?.updated });
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to migrate legacy target.' });
      }
    })();
    return true;
  }

  if (message.type === 'ACKNOWLEDGE_LEGACY_TARGET_PRICE') {
    (async () => {
      try {
        if (!isAuthorizedOptionsSender(sender)) {
          sendResponse({ error: 'Unauthorized legacy target acknowledgement.' });
          return;
        }
        const targetPrice = Number(message.targetPrice);
        if (!Number.isFinite(targetPrice)) {
          sendResponse({ error: 'Invalid legacy target acknowledgement.' });
          return;
        }
        const result = await acknowledgeLegacyTargetPrice(targetPrice);
        if (result.error) {
          sendResponse({ error: result.error });
          return;
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to acknowledge legacy target.' });
      }
    })();
    return true;
  }

  if (message.type === 'RESTORE_BACKUP') {
    (async () => {
      try {
        if (!isAuthorizedOptionsSender(sender)) {
          sendResponse({ error: 'Unauthorized backup restore.' });
          return;
        }
        const validated = validateBackupPayload(message.backup);
        // Restore is a replacement boundary. Queue it behind any in-flight
        // network job so a stale scrape cannot commit after the replacement.
        await enqueueScrapeJob(() => replaceTrackingData(validated));
        try {
          await chrome.alarms.clear(WISHLIST_CONTINUE_ALARM);
          await scheduleStandardPriceCheck();
          await updateBadgeCount();
        } catch (maintenanceError) {
          console.warn('Backup restored, but follow-up scheduling will retry later:', maintenanceError);
        }
        sendResponse({ success: true, summary: validated.summary });
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to restore backup.' });
      }
    })();
    return true;
  }

  if (message.type === 'CLEAR_PRICE_HISTORY') {
    (async () => {
      try {
        if (!isAuthorizedOptionsSender(sender)) {
          sendResponse({ error: 'Unauthorized price history clear.' });
          return;
        }
        // A completed clear must be ordered after every scrape or wishlist
        // import that could still append a sample captured before the click.
        await enqueueScrapeJob(clearPriceHistory);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to clear price history.' });
      }
    })();
    return true;
  }

  if (message.type === 'ADD_TRACKED_ITEM') {
    (async () => {
      try {
        const validated = validateAddTrackedItemRequest(message, sender);
        enforceAddRateLimit(validated.tabId);

        const items = await getTrackedItems();
        if (items.some(i => i.id === validated.item.id)) {
          await saveTrackedItem({ id: validated.item.id, trackedIndividually: true });
          sendResponse({ exists: true });
          return;
        }
        if (items.length >= MAX_TRACKED_ITEMS) {
          sendResponse({ error: `Tracking is limited to ${MAX_TRACKED_ITEMS} products.` });
          return;
        }

        // Apply the user's default discount alert (configured in Options) so the
        // setting actually takes effect on newly tracked items.
        const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
        const item = { ...validated.item, trackedIndividually: true };
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
        if (!isAuthorizedDashboardSender(sender)) {
          sendResponse({ error: 'Unauthorized wishlist extraction request.' });
          return;
        }
        const url = message.url;
        const result = await enqueueScrapeJob(async () => {
          const historyGeneration = Number(
            await getStorageData(StorageKeys.PRICE_HISTORY_GENERATION, StorageArea.LOCAL)
          ) || 0;
          const backoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
          if (backoffUntil && Date.now() < backoffUntil) {
            return {
              success: false,
              error: 'SCRAPE_BACKOFF_ACTIVE',
              paused: true,
              backoffUntil,
              historyGeneration
            };
          }

          try {
            const scrapeResult = await scrapeAmazonWishlist(url);
            if (!BACKOFF_ERRORS.has(scrapeResult?.error)) {
              if (scrapeResult?.success) await clearBackoff();
              return { ...scrapeResult, historyGeneration };
            }

            const activatedUntil = await activateBackoff();
            return {
              ...scrapeResult,
              paused: true,
              backoffUntil: activatedUntil,
              historyGeneration
            };
          } finally {
            await closeOffscreenDocument();
          }
        });
        if (result.success) {
          sendResponse({
            success: true,
            items: result.items,
            complete: result.complete === true,
            limited: result.complete !== true,
            stopReason: result.stopReason || null,
            error: result.error || null,
            paused: result.paused === true,
            backoffUntil: result.backoffUntil || null,
            historyGeneration: result.historyGeneration || 0
          });
        } else {
          sendResponse({
            error: result.error,
            paused: result.paused === true,
            backoffUntil: result.backoffUntil || null,
            historyGeneration: result.historyGeneration || 0
          });
        }
      } catch (err) {
        console.error('Failed to extract wishlist:', err);
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (message.type === 'BULK_ADD_TRACKED_ITEMS') {
    (async () => {
      try {
        if (!isAuthorizedDashboardSender(sender)) {
          throw new Error('Unauthorized wishlist import request.');
        }
        await enqueueScrapeJob(async () => {
          if (!Array.isArray(message.items) || message.items.length === 0 || message.items.length > MAX_BULK_IMPORT_ITEMS) {
            throw new Error(`Wishlist imports are limited to ${MAX_BULK_IMPORT_ITEMS} products at a time.`);
          }
          const rawItemsById = new Map();
          message.items.forEach((rawItem) => {
            if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) throw new Error('Invalid wishlist item.');
            const id = typeof rawItem.id === 'string' ? rawItem.id.toUpperCase() : '';
            if (!ASIN_PATTERN.test(id)) throw new Error('Invalid wishlist product identifier.');
            rawItemsById.set(id, { ...rawItem, id });
          });
          const rawItems = [...rawItemsById.values()];
          const historyObj = await getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL) || {};
          const historyBaselineLengths = captureHistoryLengths(historyObj);
          const historyChangedIds = new Set();
          const currentHistoryGeneration = Number(
            await getStorageData(StorageKeys.PRICE_HISTORY_GENERATION, StorageArea.LOCAL)
          ) || 0;
          const requestedHistoryGeneration = Number.isSafeInteger(message.historyGeneration) && message.historyGeneration >= 0
            ? message.historyGeneration
            : null;
          const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
          const defaultDiscount = settings.defaultDiscount ? parseInt(settings.defaultDiscount, 10) : null;
          const checkedAt = Date.now();

          let historyChanged = false;

          const recordWishlistFetch = (itemId, price) => {
            if (!itemId || !Number.isFinite(price)) return;
            if (!historyObj[itemId]) historyObj[itemId] = [];
            historyObj[itemId].push({ price, timestamp: checkedAt });
            historyChangedIds.add(itemId);
            historyChanged = true;
          };

          await updateTrackedItems((items) => {
            const existingIds = new Set(items.map((item) => item.id));
            const newCount = rawItems.filter((item) => !existingIds.has(item.id)).length;
            if (items.length + newCount > MAX_TRACKED_ITEMS) {
              throw new Error(`Tracking is limited to ${MAX_TRACKED_ITEMS} products.`);
            }
            rawItems.forEach(rawItem => {
              const existingItem = items.find(i => i.id === rawItem.id);
              const newItem = sanitizeBulkTrackedItem(rawItem, existingItem || null);
              if (!existingItem) {
                const itemToSave = {
                  ...newItem,
                  addedAt: checkedAt,
                  lastChecked: checkedAt,
                  updatedAt: checkedAt
                };
                if (defaultDiscount && !itemToSave.targetDiscountPercentage) {
                  itemToSave.targetDiscountPercentage = defaultDiscount;
                }
                items.push(itemToSave);
                recordWishlistFetch(itemToSave.id, itemToSave.currentPrice);
                setNextAdaptiveCheck(itemToSave, historyObj, checkedAt);
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
            });
            return items;
          });
          await scheduleStandardPriceCheck();

          if (historyChanged && requestedHistoryGeneration === currentHistoryGeneration) {
            await persistHistoryAppends(historyObj, historyBaselineLengths, historyChangedIds);
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
  'wishlistPriceDropAmount', 'wishlistPriceDropText',
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

export function captureHistoryLengths(historyObj) {
  return new Map(Object.entries(historyObj || {}).map(([id, points]) => [
    id,
    Array.isArray(points) ? points.length : 0
  ]));
}

export async function persistHistoryAppends(historyObj, baselineLengths, candidateIds) {
  const appendsById = new Map();
  for (const id of candidateIds || Object.keys(historyObj || {})) {
    const points = Array.isArray(historyObj?.[id]) ? historyObj[id] : [];
    const baselineLength = baselineLengths.get(id) || 0;
    const appended = points.slice(baselineLength);
    if (appended.length > 0) appendsById.set(id, appended);
  }
  if (appendsById.size === 0) return;

  await updatePriceHistory((latestHistory) => {
    const mergedHistory = { ...latestHistory };
    appendsById.forEach((appended, id) => {
      const mergedPoints = Array.isArray(mergedHistory[id]) ? [...mergedHistory[id]] : [];
      appended.forEach((point) => {
        const duplicate = mergedPoints.some(existing =>
          existing?.price === point?.price && existing?.timestamp === point?.timestamp
        );
        if (!duplicate) mergedPoints.push(point);
      });
      mergedHistory[id] = mergedPoints;
    });
    return mergedHistory;
  });
}

export async function persistScrapeResults(
  scrapedItems,
  changedIds,
  newIds = new Set(),
  removedIds = new Set(),
  removalWishlistId = null
) {
  const scrapedById = new Map(scrapedItems.map(item => [item.id, item]));
  await updateTrackedItems((latestItems) => {
    const latestIds = new Set(latestItems.map(item => item.id));
    const merged = latestItems.flatMap((current) => {
      if (removedIds.has(current.id)) {
        const currentWishlistIds = Array.isArray(current.wishlistIds) ? current.wishlistIds : [];
        const remainingWishlistIds = removalWishlistId
          ? currentWishlistIds.filter(id => id !== removalWishlistId)
          : currentWishlistIds;
        if (current.trackedIndividually || remainingWishlistIds.length > 0) {
          return [{ ...current, wishlistIds: remainingWishlistIds }];
        }
        return [];
      }
      if (!changedIds.has(current.id)) return [current];
      const scraped = scrapedById.get(current.id);
      if (!scraped) return [current];

      const next = { ...current };
      SCRAPE_OWNED_FIELDS.forEach((field) => {
        if (scraped[field] !== undefined) next[field] = scraped[field];
      });
      return [next];
    });

    newIds.forEach((id) => {
      const scraped = scrapedById.get(id);
      if (scraped && !latestIds.has(id)) merged.push(scraped);
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
  const historyBaselineLengths = captureHistoryLengths(historyObj);
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
    await persistHistoryAppends(historyObj, historyBaselineLengths, changedIds);
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
  const historyBaselineLengths = captureHistoryLengths(historyObj);
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
    await persistHistoryAppends(historyObj, historyBaselineLengths, changedIds);
  }
  if (processedCount > 0) {
    updates[StorageKeys.PRIORITY_SCRAPE_CURSOR] = (startCursor + processedCount) % items.length;
  }
  if (Object.keys(updates).length > 0) {
    await setStorageItems(updates, StorageArea.LOCAL);
  }
}

function serializedByteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch (_error) {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function runWishlistCheckBatch() {
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
  const historyBaselineLengths = captureHistoryLengths(historyObj);
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
  const syncState = storedSyncState && typeof storedSyncState === 'object' && !Array.isArray(storedSyncState)
    ? storedSyncState
    : {};
  const activeStateKeys = new Set(wishlists.map((entry) => {
    if (typeof entry === 'string') return entry;
    return entry?.id || entry?.url;
  }).filter(Boolean));
  for (const key of Object.keys(syncState)) {
    if (!activeStateKeys.has(key)) delete syncState[key];
  }
  const previousState = stateKey ? syncState[stateKey] : null;
  const scrapeUrl = previousState?.nextPageUrl || url;
  const previousItems = Array.isArray(previousState?.items)
    ? previousState.items.slice(0, WISHLIST_TOTAL_MAX_ITEMS)
    : [];
  const previousPages = boundedCounter(previousState?.pagesProcessed);
  const previousBytes = boundedCounter(previousState?.bytesProcessed);
  const startedAt = Number.isFinite(previousState?.startedAt) && previousState.startedAt <= now
    ? previousState.startedAt
    : now;
  const remainingPages = WISHLIST_TOTAL_MAX_PAGES - previousPages;
  const remainingItems = WISHLIST_TOTAL_MAX_ITEMS - previousItems.length;
  const remainingBytes = WISHLIST_TOTAL_MAX_BYTES - previousBytes;
  const remainingElapsed = WISHLIST_TOTAL_MAX_ELAPSED_MS - (now - startedAt);
  const trackedById = new Map(items.map((item) => [item.id, item]));

  try {
    if (scrapeUrl && remainingPages > 0 && remainingItems > 0 && remainingBytes > 0 && remainingElapsed > 0) {
      try {
        const result = await scrapeAmazonWishlist(scrapeUrl, {
          maxPages: Math.min(WISHLIST_CHUNK_MAX_PAGES, remainingPages),
          maxItems: remainingItems,
          maxTotalBytes: remainingBytes,
          maxElapsedMs: Math.min(2 * 60 * 1000, remainingElapsed)
        });
        const partialDisposition = globalThis.wishlistPartialPolicy.getPartialWishlistDisposition(result);
        if (BACKOFF_ERRORS.has(result?.error) || partialDisposition.activatesBackoff) isBackoffActive = true;
        if (result && result.success && result.items) {
          const accumulatedById = new Map(previousItems.map(item => [item.id, item]));
          result.items.forEach(item => accumulatedById.set(item.id, item));
          result.items = [...accumulatedById.values()];
          const pagesProcessed = previousPages + boundedCounter(result.pagesProcessed);
          const bytesProcessed = previousBytes + boundedCounter(result.bytesProcessed);

          if (partialDisposition.preservesResumeState && stateKey) {
            const candidateState = {
              nextPageUrl: result.nextPageUrl,
              items: result.items,
              pagesProcessed,
              bytesProcessed,
              startedAt,
              updatedAt: now
            };
            const traversalBudgetReached =
              pagesProcessed >= WISHLIST_TOTAL_MAX_PAGES ||
              result.items.length >= WISHLIST_TOTAL_MAX_ITEMS ||
              bytesProcessed >= WISHLIST_TOTAL_MAX_BYTES ||
              now - startedAt >= WISHLIST_TOTAL_MAX_ELAPSED_MS;
            syncState[stateKey] = candidateState;
            if (traversalBudgetReached || serializedByteLength(syncState) > WISHLIST_STATE_MAX_BYTES) {
              delete syncState[stateKey];
              console.warn(`Wishlist sync paused for ${stateKey}: bounded traversal limit reached.`);
            }
          } else if (result.complete === true) {
            if (stateKey) delete syncState[stateKey];
            result.items.forEach(extractedItem => {
              const trackedItem = trackedById.get(extractedItem.id);
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
              } else if (typeof wl !== 'string' && wl.autoSync && items.length < MAX_TRACKED_ITEMS) {
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
                trackedById.set(newItem.id, newItem);
                processScrapeResult(newItem, simulatedResult, historyObj, now, settings || {});
                setNextAdaptiveCheck(newItem, historyObj, now);
                changedItems = true;
                changedIds.add(newItem.id);
                newIds.add(newItem.id);
              }
            });

            // Only reconcile removals after a complete, structurally validated
            // traversal. Partial or budget-limited results cannot remove data.
            if (typeof wl !== 'string' && wl.autoSync && wishlistId) {
              const visibleIds = new Set(result.items.map(item => item.id));
              items.forEach((item) => {
                if (!item.wishlistIds?.includes(wishlistId) || visibleIds.has(item.id)) return;
                item.wishlistIds = item.wishlistIds.filter(id => id !== wishlistId);
                if (item.wishlistIds.length === 0 && !item.trackedIndividually) {
                  removedIds.add(item.id);
                } else {
                  changedIds.add(item.id);
                }
                changedItems = true;
              });
            }
          }
        } else if (result && BACKOFF_ERRORS.has(result.error)) {
          isBackoffActive = true;
        }
      } catch (err) {
        if (BACKOFF_ERRORS.has(err.message)) isBackoffActive = true;
      }
    } else if (stateKey && previousState) {
      delete syncState[stateKey];
      console.warn(`Wishlist sync state discarded for ${stateKey}: cumulative budget expired.`);
    }
  } finally {
    await closeOffscreenDocument();
  }

  if (isBackoffActive) {
    await activateBackoff();
    if (Object.keys(syncState).length > 0) {
      const retryAt = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
      await scheduleWishlistContinuation(retryAt || Date.now() + BACKOFF_BASE_MS);
    }
  } else {
    await clearBackoff();
  }

  const updates = {
    [StorageKeys.WISHLIST_SCRAPE_CURSOR]: (startCursor + 1) % wishlists.length,
    [StorageKeys.WISHLIST_SCRAPE_STATE]: syncState
  };
  if (changedItems) {
    await persistScrapeResults(items, changedIds, newIds, removedIds, wishlistId);
    await persistHistoryAppends(historyObj, historyBaselineLengths, changedIds);
  }
  await setStorageItems(updates, StorageArea.LOCAL);

  if (Object.keys(syncState).length === 0) {
    await chrome.alarms.clear(WISHLIST_CONTINUE_ALARM);
  } else if (!isBackoffActive) {
    await scheduleWishlistContinuation();
  }
}

async function activateBackoff() {
  const attempts = (await getStorageData(StorageKeys.CAPTCHA_BACKOFF_ATTEMPTS, StorageArea.LOCAL) || 0) + 1;
  const backoffMs = Math.min(BACKOFF_BASE_MS * (2 ** (attempts - 1)), BACKOFF_MAX_MS);

  const backoffUntil = Date.now() + backoffMs;
  await setStorageItems({
    [StorageKeys.CAPTCHA_BACKOFF_ATTEMPTS]: attempts,
    [StorageKeys.CAPTCHA_BACKOFF_UNTIL]: backoffUntil
  }, StorageArea.LOCAL);
  console.warn(`Scrape backoff active for ${Math.round(backoffMs / 60000)} minutes.`);
  return backoffUntil;
}

async function clearBackoff() {
  await setStorageItems({
    [StorageKeys.CAPTCHA_BACKOFF_ATTEMPTS]: 0,
    [StorageKeys.CAPTCHA_BACKOFF_UNTIL]: 0
  }, StorageArea.LOCAL);
}

export function processScrapeResult(item, result, historyObj, timestamp = Date.now(), settings = {}) {
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
    const productUrl = normalizeStoredAmazonProductUrl(item.url, item.id);
    if (productUrl) chrome.tabs.create({ url: productUrl });
  }
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (isLegacyTargetNoticeNotification(notificationId) && buttonIndex === 0) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (buttonIndex === 0) {
    await openTrackedItem(notificationId);
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (isLegacyTargetNoticeNotification(notificationId)) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  await openTrackedItem(notificationId);
});

export async function updateBadgeCount() {
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
