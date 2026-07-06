import { scrapeAmazonProduct, scrapeAmazonWishlist, closeOffscreenDocument } from './scraper.js';
import { getTrackedItems, saveTrackedItem, saveTrackedItems, getStorageData, setStorageItems, formatPrice, prunePriceHistory, StorageKeys, StorageArea } from '../utils/storage.js';

const AMAZON_HOST_PATTERN = /(^|\.)amazon\.(com|nl|de|fr|es|it|co\.uk)$/i;

const ALARM_DEFINITIONS = [
  ['checkPricesAlarm', { periodInMinutes: 5 }],
  ['checkPriorityPricesAlarm', { periodInMinutes: 5 }],
  ['checkWishlistsAlarm', { periodInMinutes: 360 }]
];

async function ensureAlarms() {
  for (const [name, config] of ALARM_DEFINITIONS) {
    const existing = await chrome.alarms.get(name);
    if (!existing) {
      chrome.alarms.create(name, config);
    }
  }
}

// Process a small slice per alarm instead of one long all-items run. Ensure the
// alarms exist after install, browser startup, and service-worker reload.
chrome.runtime.onInstalled.addListener(() => {
  console.log('Amazon Wishlist Tracker installed.');
  ensureAlarms();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
});
ensureAlarms();

// The alarms regularly coincide (5-min priority vs 15-min batch), and each job
// read-modify-writes the whole trackedItems array. Running them concurrently
// makes the last bulk write silently discard the other job's updates, so every
// scrape job is chained onto a single queue.
let scrapeJobQueue = Promise.resolve();
function enqueueScrapeJob(job) {
  const run = scrapeJobQueue.then(job);
  scrapeJobQueue = run.catch(() => {});
  return run;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkPricesAlarm') {
    console.log('Running scheduled price check...');
    await enqueueScrapeJob(runPriceCheckBatch);
    // Prune history occasionally
    await prunePriceHistory();
  } else if (alarm.name === 'checkPriorityPricesAlarm') {
    console.log('Running priority price check...');
    await enqueueScrapeJob(runPriorityPriceCheckBatch);
  } else if (alarm.name === 'checkWishlistsAlarm') {
    console.log('Running wishlist bulk scrape...');
    await enqueueScrapeJob(runWishlistCheckBatch);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
          sendResponse({ exists: true });
          return;
        }

        // Apply the user's default discount alert (configured in Options) so the
        // setting actually takes effect on newly tracked items.
        const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
        const item = { ...message.item };
        if (settings.defaultDiscount && !item.targetDiscountPercentage) {
          item.targetDiscountPercentage = parseInt(settings.defaultDiscount, 10);
        }

        await saveTrackedItem(item);
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
        const result = await scrapeAmazonWishlist(url);
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

  if (message.type === 'BULK_ADD_TRACKED_ITEMS') {
    (async () => {
      try {
        const items = await getTrackedItems();
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
        
        message.items.forEach(newItem => {
          const existingItem = items.find(i => i.id === newItem.id);
          if (!existingItem) {
            const itemToSave = {
              ...newItem,
              lastChecked: checkedAt,
              updatedAt: checkedAt
            };
            if (defaultDiscount && !itemToSave.targetDiscountPercentage) {
              itemToSave.targetDiscountPercentage = defaultDiscount;
            }
            items.push(itemToSave);
            recordWishlistFetch(itemToSave.id, itemToSave.currentPrice);
            itemsChanged = true;
          } else {
            // Merge newly extracted original prices or region-specific URLs into existing tracked items
            let updated = false;
            for (const field of ['title', 'currentPrice', 'currency', 'inStock']) {
              if (newItem[field] != null && newItem[field] !== existingItem[field]) {
                existingItem[field] = newItem[field];
                updated = true;
              }
            }
            if (newItem.url && newItem.url !== existingItem.url) {
              existingItem.url = newItem.url;
              updated = true;
            }
            if (newItem.imageUrl && newItem.imageUrl !== existingItem.imageUrl) {
              existingItem.imageUrl = newItem.imageUrl;
              updated = true;
            }
            if (newItem.originalPrice && (!existingItem.originalPrice || newItem.originalPrice > existingItem.originalPrice)) {
              existingItem.originalPrice = newItem.originalPrice;
              updated = true;
            }
            for (const field of ['wishlistPriceDropPercent', 'wishlistPriceWhenAdded', 'wishlistPriceDropAmount', 'wishlistPriceDropText']) {
              if (newItem[field] != null && newItem[field] !== existingItem[field]) {
                existingItem[field] = newItem[field];
                updated = true;
              }
            }
            existingItem.lastChecked = checkedAt;
            existingItem.updatedAt = checkedAt;
            recordWishlistFetch(existingItem.id, newItem.currentPrice);
            updated = true;
            if (updated) {
              itemsChanged = true;
            }
          }
        });

        if (itemsChanged || historyChanged) {
          const updates = {};
          if (itemsChanged) updates[StorageKeys.TRACKED_ITEMS] = items;
          if (historyChanged) updates[StorageKeys.PRICE_HISTORY] = historyObj;
          await setStorageItems(updates, StorageArea.LOCAL);
        }
        
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
const ITEMS_PER_ALARM = 30;

async function runPriceCheckBatch() {
  const backoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
  if (backoffUntil && Date.now() < backoffUntil) {
    console.warn(`Scraping paused until ${new Date(backoffUntil).toISOString()} due to scrape backoff.`);
    return;
  }
  let isBackoffActive = false;

  const [items, history, cursorValue, settings] = await Promise.all([
    getTrackedItems(),
    getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL),
    getStorageData(StorageKeys.SCRAPE_CURSOR, StorageArea.LOCAL),
    getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC)
  ]);
  if (!items || items.length === 0) return;

  const historyObj = history || {};
  const startCursor = Number.isInteger(cursorValue) ? cursorValue % items.length : 0;
  const itemsToProcess = Math.min(ITEMS_PER_ALARM, items.length);
  const now = Date.now();
  let changedItems = false;
  let processedCount = 0;

  try {
    for (let offset = 0; offset < itemsToProcess; offset++) {
      const item = items[(startCursor + offset) % items.length];

      try {
        const result = await scrapeAmazonProduct(item.url);
        processedCount++;
        if (result && result.success) {
          processScrapeResult(item, result, historyObj, now, settings || {});
          changedItems = true;
        } else if (result && BACKOFF_ERRORS.has(result.error)) {
          isBackoffActive = true;
          console.error(`${result.error} detected on ${item.url}. Triggering scrape backoff.`);
        } else {
          console.warn(`Failed to scrape ${item.url}:`, result?.error);
        }
      } catch (err) {
        processedCount++;
        if (BACKOFF_ERRORS.has(err.message)) {
          isBackoffActive = true;
        }
        console.error(`Error processing item ${item.id}:`, err);
      }

      if (isBackoffActive) {
        console.warn('Aborting remaining slice due to scrape backoff.');
        break;
      }

      // Random delay between requests (2 to 5 seconds)
      if (offset + 1 < itemsToProcess) {
        const jitter = Math.floor(Math.random() * 3000) + 2000;
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
    await saveTrackedItems(items);
    updates[StorageKeys.PRICE_HISTORY] = historyObj;
  }
  if (processedCount > 0) {
    updates[StorageKeys.SCRAPE_CURSOR] = (startCursor + processedCount) % items.length;
  }
  await setStorageItems(updates, StorageArea.LOCAL);
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
  const now = Date.now();
  let changedItems = false;
  let processedCount = 0;

  try {
    for (let offset = 0; offset < itemsToProcess; offset++) {
      const item = items[(startCursor + offset) % items.length];

      try {
        const result = await scrapeAmazonProduct(item.url);
        processedCount++;
        if (result && result.success) {
          processScrapeResult(item, result, historyObj, now, settings || {});
          changedItems = true;
          // Sync changes back to the main array
          const mainIndex = allItems.findIndex(i => i.id === item.id);
          if (mainIndex > -1) allItems[mainIndex] = item;
        } else if (result && BACKOFF_ERRORS.has(result.error)) {
          isBackoffActive = true;
        }
      } catch (err) {
        processedCount++;
        if (BACKOFF_ERRORS.has(err.message)) isBackoffActive = true;
      }

      if (isBackoffActive) break;

      if (offset + 1 < itemsToProcess) {
        const jitter = Math.floor(Math.random() * 3000) + 2000;
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
    await saveTrackedItems(allItems);
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
  const trackedWishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];
  const items = await getTrackedItems();
  const historyObj = await getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL) || {};
  const settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
  const defaultDiscount = settings.defaultDiscount ? parseInt(settings.defaultDiscount, 10) : null;
  
  // Note: an empty tracked-items list must NOT skip the run — a wishlist with
  // autoSync can be the very thing that adds the first items.
  if (!trackedWishlists.length) return;

  const backoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
  if (backoffUntil && Date.now() < backoffUntil) return;

  let isBackoffActive = false;
  const now = Date.now();
  let changedItems = false;

  try {
    for (const wl of trackedWishlists) {
      // Handle legacy string format or newer object format { id, url }
      const url = typeof wl === 'string' ? `https://www.amazon.com/hz/wishlist/ls/${wl}?viewType=list` : wl.url;
      if (!url) continue;

      try {
        const result = await scrapeAmazonWishlist(url);
        if (result && result.success && result.items) {
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
              buyBoxPrice: null,
              salesRank: null
            };
            
            if (trackedItem) {
              processScrapeResult(trackedItem, simulatedResult, historyObj, now, settings || {});
              changedItems = true;
            } else if (wl.autoSync) {
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
                wishlistPriceDropText: extractedItem.wishlistPriceDropText
              };
              if (defaultDiscount) newItem.targetDiscountPercentage = defaultDiscount;
              
              items.push(newItem);
              processScrapeResult(newItem, simulatedResult, historyObj, now, settings || {});
              changedItems = true;
            }
          });
        } else if (result && BACKOFF_ERRORS.has(result.error)) {
          isBackoffActive = true;
        }
      } catch (err) {
        if (BACKOFF_ERRORS.has(err.message)) isBackoffActive = true;
      }

      if (isBackoffActive) break;
      await delay(Math.floor(Math.random() * 2000) + 2000); // Wait 2-4s between wishlists
    }
  } finally {
    await closeOffscreenDocument();
  }

  if (isBackoffActive) {
    await activateBackoff();
  } else {
    await clearBackoff();
  }

  if (changedItems) {
    await saveTrackedItems(items);
    await setStorageItems({ [StorageKeys.PRICE_HISTORY]: historyObj }, StorageArea.LOCAL);
  }
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
  const targetPrice = item.targetPrice || settings.defaultTargetPrice;
  if (targetPrice && currentPrice <= targetPrice && (previousPrice == null || previousPrice > targetPrice)) {
    alertTriggered = true;
    alertMessage = `Price dropped to or below your target of ${formatPrice(targetPrice, item.currency)}! Now: ${formatPrice(currentPrice, item.currency)}`;
  }

  // 2. Discount Percentage Alert
  const targetDiscount = item.targetDiscountPercentage || settings.defaultDiscount;
  if (targetDiscount && item.originalPrice) {
    const discount = ((item.originalPrice - currentPrice) / item.originalPrice) * 100;
    if (discount >= targetDiscount && previousPrice > currentPrice) {
      alertTriggered = true;
      alertMessage = `Discount reached ${discount.toFixed(1)}%! Now: ${formatPrice(currentPrice, item.currency)}`;
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

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    await openTrackedItem(notificationId);
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  await openTrackedItem(notificationId);
});
