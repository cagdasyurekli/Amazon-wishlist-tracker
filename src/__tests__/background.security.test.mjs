import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const backgroundSource = await readFile(new URL('../background/background.js', import.meta.url), 'utf8');
const legacyNoticeSource = await readFile(new URL('../background/legacy_target_notice.js', import.meta.url), 'utf8');
const partialPolicySource = await readFile(new URL('../background/wishlist_partial_policy.js', import.meta.url), 'utf8');

async function loadBackground(initialItems = [], options = {}) {
  let trackedItems = initialItems.map((item) => ({ ...item }));
  let currentSettings = { ...(options.settings || {}) };
  let settingsWriteCompleted = false;
  let messageListener;
  const savedItems = [];
  const notifications = [];
  const badgeTexts = [];

  const context = vm.createContext({
    URL,
    Set,
    Map,
    Date,
    Math,
    Number,
    Promise,
    parseInt,
    setTimeout,
    clearTimeout,
    console,
    chrome: {
      runtime: {
        id: 'test-extension',
        getURL: (path) => `chrome-extension://test-extension/${path}`,
        async openOptionsPage() {},
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener(listener) { messageListener = listener; } }
      },
      alarms: {
        async create() {},
        async get(name) { return { name, periodInMinutes: name === 'checkPricesAlarm' ? null : 2 }; },
        async clear() {},
        onAlarm: { addListener() {} }
      },
      storage: { local: { async remove() {} }, onChanged: { addListener() {} } },
      notifications: {
        create(id, options) { notifications.push({ id, options }); },
        onButtonClicked: { addListener() {} },
        onClicked: { addListener() {} }
      },
      tabs: { async create() {} },
      action: {
        async setBadgeText({ text }) { badgeTexts.push(text); },
        async setBadgeBackgroundColor() {}
      }
    }
  });

  const scraperModule = new vm.SyntheticModule(
    ['scrapeAmazonProduct', 'scrapeAmazonWishlist', 'closeOffscreenDocument'],
    function initialize() {
      this.setExport('scrapeAmazonProduct', async () => ({ success: false }));
      this.setExport('scrapeAmazonWishlist', async () => ({ success: false }));
      this.setExport('closeOffscreenDocument', async () => {});
    },
    { context }
  );

  const amazonModule = new vm.SyntheticModule(
    ['normalizeStoredAmazonProductUrl', 'sanitizeAmazonImageUrl'],
    function initialize() {
      this.setExport('normalizeStoredAmazonProductUrl', (value, expectedAsin) => {
        try {
          const parsed = new URL(value);
          const asin = parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase();
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port ||
              !/(^|\.)amazon\.(com|nl|de|fr|es|it|co\.uk)$/i.test(parsed.hostname) || asin !== expectedAsin) return null;
          return `https://${parsed.hostname.toLowerCase()}/dp/${asin}`;
        } catch { return null; }
      });
      this.setExport('sanitizeAmazonImageUrl', () => '');
    },
    { context }
  );

  const StorageKeys = {
    TRACKED_ITEMS: 'trackedItems',
    TRACKED_WISHLISTS: 'trackedWishlists',
    SETTINGS: 'settings',
    PRICE_HISTORY: 'priceHistory',
    LAST_SCRAPE_TIME: 'lastScrapeTime',
    SCRAPE_CURSOR: 'scrapeCursor',
    PRIORITY_SCRAPE_CURSOR: 'priorityScrapeCursor',
    WISHLIST_SCRAPE_CURSOR: 'wishlistScrapeCursor',
    WISHLIST_SCRAPE_STATE: 'wishlistScrapeState',
    CAPTCHA_BACKOFF_UNTIL: 'captchaBackoffUntil',
    CAPTCHA_BACKOFF_ATTEMPTS: 'captchaBackoffAttempts',
    LEGACY_TARGET_NOTICE: 'legacyTargetNotice'
  };
  const StorageArea = { LOCAL: 'local', SYNC: 'sync' };
  const storageModule = new vm.SyntheticModule(
    [
      'getTrackedItems', 'saveTrackedItem', 'updateTrackedItems', 'updateTrackedItemsIf', 'updateTrackedItemsWithFinalizer', 'updatePriceHistory', 'getStorageData',
      'setStorageData', 'setStorageItems', 'formatPrice', 'prunePriceHistory', 'StorageKeys', 'StorageArea'
    ],
    function initialize() {
      this.setExport('getTrackedItems', async () => trackedItems);
      this.setExport('saveTrackedItem', async (item) => {
        savedItems.push({ ...item });
        const index = trackedItems.findIndex((entry) => entry.id === item.id);
        if (index >= 0) trackedItems[index] = { ...trackedItems[index], ...item };
        else trackedItems.push({ ...item });
      });
      this.setExport('updateTrackedItems', async (updater) => {
        trackedItems = updater(trackedItems);
      });
      this.setExport('updateTrackedItemsIf', async (updater) => {
        const outcome = updater(trackedItems) || { commit: false };
        if (outcome.commit) trackedItems = outcome.items;
        return outcome.result;
      });
      this.setExport('updateTrackedItemsWithFinalizer', async (updater, finalizer) => {
        const originalItems = trackedItems.map((entry) => ({ ...entry }));
        const outcome = updater(trackedItems) || { commit: false };
        if (!outcome.commit) return outcome.result;
        trackedItems = outcome.items;
        try {
          await finalizer(outcome.result);
          return outcome.result;
        } catch (error) {
          trackedItems = originalItems;
          throw error;
        }
      });
      this.setExport('updatePriceHistory', async (updater) => { updater({}); });
      this.setExport('getStorageData', async (key, area) => {
        if (key === StorageKeys.SETTINGS && area === StorageArea.SYNC) {
          if (options.failSettingsReadAfterWrite && settingsWriteCompleted) {
            throw new Error('Synthetic Sync readback failure');
          }
          return { ...currentSettings };
        }
        return null;
      });
      this.setExport('setStorageData', async (key, value, area) => {
        if (key === StorageKeys.SETTINGS && area === StorageArea.SYNC) {
          if (options.failSettingsWrite) throw new Error('Synthetic Sync write failure');
          currentSettings = { ...value };
          settingsWriteCompleted = true;
        }
      });
      this.setExport('setStorageItems', async () => {});
      this.setExport('formatPrice', (price, currency) => `${currency || ''}${price}`);
      this.setExport('prunePriceHistory', async () => {});
      this.setExport('StorageKeys', StorageKeys);
      this.setExport('StorageArea', StorageArea);
    },
    { context }
  );

  const legacyNoticeModule = new vm.SourceTextModule(legacyNoticeSource, { context });
  const partialPolicyModule = new vm.SourceTextModule(partialPolicySource, { context });

  const module = new vm.SourceTextModule(backgroundSource, { context });
  await module.link((specifier) => {
    if (specifier === './scraper.js') return scraperModule;
    if (specifier === '../utils/storage.js') return storageModule;
    if (specifier === '../utils/amazon.js') return amazonModule;
    if (specifier === './legacy_target_notice.js') return legacyNoticeModule;
    if (specifier === './wishlist_partial_policy.js') return partialPolicyModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const sendMessage = (message, sender) => new Promise((resolve) => {
    assert.equal(messageListener(message, sender, resolve), true);
  });

  return {
    api: module.namespace,
    sendMessage,
    savedItems,
    notifications,
    badgeTexts,
    getTrackedItems: () => trackedItems,
    getSettings: () => currentSettings
  };
}

function item(id = 'B000000001', overrides = {}) {
  return {
    id,
    title: 'A legitimate product',
    url: `https://www.amazon.com/dp/${id}`,
    currentPrice: 19.99,
    currency: '$',
    originalPrice: 19.99,
    ...overrides
  };
}

function sender(id = 'B000000001', overrides = {}) {
  return {
    id: 'test-extension',
    frameId: 0,
    tab: { id: 17, url: `https://www.amazon.com/dp/${id}` },
    ...overrides
  };
}

function dashboardSender(overrides = {}) {
  return {
    id: 'test-extension',
    url: 'chrome-extension://test-extension/src/dashboard/dashboard.html',
    ...overrides
  };
}

function optionsSender(overrides = {}) {
  return {
    id: 'test-extension',
    frameId: 0,
    url: 'chrome-extension://test-extension/src/options/options.html',
    ...overrides
  };
}

describe('ADD_TRACKED_ITEM privilege boundary', () => {
  it('accepts one bounded item from the matching HTTPS Amazon tab', async () => {
    const harness = await loadBackground();

    const response = await harness.sendMessage({ type: 'ADD_TRACKED_ITEM', item: item() }, sender());

    assert.equal(response.success, true);
    assert.equal(harness.savedItems.length, 1);
    assert.deepEqual(harness.savedItems[0], {
      id: 'B000000001',
      title: 'A legitimate product',
      url: 'https://www.amazon.com/dp/B000000001',
      currentPrice: 19.99,
      currency: '$',
      originalPrice: 19.99,
      trackedIndividually: true
    });
  });

  it('preserves the existing-record flow and marks it individually tracked', async () => {
    const harness = await loadBackground([{
      id: 'B000000001',
      title: 'Wishlist copy',
      url: 'https://www.amazon.com/dp/B000000001',
      wishlistIds: ['LIST-1']
    }]);

    const response = await harness.sendMessage({ type: 'ADD_TRACKED_ITEM', item: item() }, sender());

    assert.equal(response.exists, true);
    assert.equal(harness.savedItems.length, 1);
    assert.deepEqual(harness.savedItems[0], {
      id: 'B000000001',
      trackedIndividually: true
    });
    assert.equal(harness.getTrackedItems()[0].wishlistIds[0], 'LIST-1');
  });

  it('rejects unbound senders, plaintext URLs, non-ASIN IDs, mismatches, and oversized fields', async () => {
    const harness = await loadBackground();
    const attempts = [
      [{ type: 'ADD_TRACKED_ITEM', item: item() }, sender('B000000001', { id: 'other-extension' })],
      [{ type: 'ADD_TRACKED_ITEM', item: item('B000000001', { url: 'http://www.amazon.com/dp/B000000001' }) }, sender()],
      [{ type: 'ADD_TRACKED_ITEM', item: item('B000000001', { url: 'https://user:pass@www.amazon.com/dp/B000000001' }) }, sender()],
      [{ type: 'ADD_TRACKED_ITEM', item: item('B000000001', { url: 'https://www.amazon.com:444/dp/B000000001' }) }, sender()],
      [{ type: 'ADD_TRACKED_ITEM', item: item('ID-123') }, sender('ID-123')],
      [{ type: 'ADD_TRACKED_ITEM', item: item('B000000002') }, sender('B000000001')],
      [{ type: 'ADD_TRACKED_ITEM', item: item('B000000003', { title: 'x'.repeat(301) }) }, sender('B000000003')]
    ];

    for (const [message, source] of attempts) {
      const response = await harness.sendMessage(message, source);
      assert.equal(typeof response.error, 'string');
    }
    assert.equal(harness.savedItems.length, 0);
  });

  it('rate-limits repeated adds per tab and caps the total collection', async () => {
    const rateHarness = await loadBackground();
    assert.equal((await rateHarness.sendMessage({ type: 'ADD_TRACKED_ITEM', item: item() }, sender())).success, true);
    const rateResponse = await rateHarness.sendMessage(
      { type: 'ADD_TRACKED_ITEM', item: item('B000000002') },
      sender('B000000002')
    );
    assert.match(rateResponse.error, /wait/i);

    const fullCollection = Array.from({ length: 5000 }, (_, index) => ({ id: `X${String(index).padStart(9, '0')}` }));
    const capHarness = await loadBackground(fullCollection);
    const capResponse = await capHarness.sendMessage({ type: 'ADD_TRACKED_ITEM', item: item() }, sender());
    assert.match(capResponse.error, /5000/);
    assert.equal(capHarness.savedItems.length, 0);
  });
});

describe('scraped purchase text handling', () => {
  it('does not delete history, notify, or remove a tracked record when isPurchased is untrusted', async () => {
    const original = item('B000000001', { currentPrice: 20 });
    const harness = await loadBackground([original]);
    const history = { B000000001: [{ price: 20, timestamp: 1 }] };
    const scraped = { ...original };

    harness.api.processScrapeResult(scraped, {
      success: true,
      isPurchased: true,
      price: 19,
      currency: '$',
      inStock: true,
      buyBoxPrice: 19,
      salesRank: null
    }, history, 2, {});

    assert.equal(history.B000000001.length, 2);
    assert.equal(scraped.isPurchased, undefined);
    assert.equal(harness.notifications.length, 0);

    await harness.api.persistScrapeResults(
      [{ ...scraped, isPurchased: true }],
      new Set(['B000000001'])
    );
    assert.equal(harness.getTrackedItems().length, 1);
    assert.equal(harness.getTrackedItems()[0].id, 'B000000001');
  });
});

describe('target price notifications', () => {
  it('notifies on a downward target crossing, avoids repeat spam, and can notify after a reset', async () => {
    const harness = await loadBackground();
    const tracked = item('B000000001', { currentPrice: 20, targetPrice: 15, inStock: true });
    const history = {};
    const result = (price) => ({
      success: true,
      price,
      currency: '$',
      inStock: true,
      buyBoxPrice: null,
      salesRank: null
    });

    harness.api.processScrapeResult(tracked, result(14), history, 1);
    harness.api.processScrapeResult(tracked, result(13), history, 2);
    harness.api.processScrapeResult(tracked, result(18), history, 3);
    harness.api.processScrapeResult(tracked, result(14), history, 4);

    assert.equal(harness.notifications.length, 2);
    assert.match(harness.notifications[0].options.title, /Amazon Price Alert/);
    assert.match(harness.notifications[0].options.message, /target of \$15/);
    assert.match(harness.notifications[0].options.message, /Now: \$14/);
    assert.equal(history.B000000001.length, 4);
  });
});

describe('legacy target migration transaction', () => {
  it('rejects non-Options senders and restores the exact prior collection when Sync acknowledgement fails', async () => {
    const original = item('B000000001', { currency: '€' });
    const harness = await loadBackground([original], {
      settings: { defaultTargetPrice: 12.5, defaultDiscount: 30 },
      failSettingsWrite: true
    });
    const message = {
      type: 'MIGRATE_LEGACY_TARGET_PRICE',
      targetPrice: 12.5,
      currency: '€',
      expectedCount: 1
    };

    const unauthorized = await harness.sendMessage(message, dashboardSender());
    assert.match(unauthorized.error, /Unauthorized/i);

    const failed = await harness.sendMessage(message, optionsSender());
    assert.match(failed.error, /Synthetic Sync write failure/i);
    assert.deepEqual(harness.getTrackedItems(), [original]);

    const readbackFailure = await loadBackground([original], {
      settings: { defaultTargetPrice: 12.5, defaultDiscount: 30 },
      failSettingsReadAfterWrite: true
    });
    const committed = await readbackFailure.sendMessage(message, optionsSender());
    assert.equal(committed.success, true);
    assert.equal(readbackFailure.getTrackedItems()[0].targetPrice, 12.5);
    assert.deepEqual(readbackFailure.getSettings(), { defaultDiscount: 30 });
  });
});

describe('discount, restock, and badge transitions', () => {
  it('avoids duplicate discount/restock alerts while preserving valid transitions', async () => {
    const discountHarness = await loadBackground();
    const discounted = item('B000000001', {
      currentPrice: 100,
      originalPrice: 100,
      targetDiscountPercentage: 20,
      inStock: true
    });
    const result = (price, inStock = true) => ({
      success: true,
      price,
      currency: '$',
      inStock,
      buyBoxPrice: null,
      salesRank: null
    });

    discountHarness.api.processScrapeResult(discounted, result(79), {}, 1);
    discountHarness.api.processScrapeResult(discounted, result(79), {}, 2);
    discountHarness.api.processScrapeResult(discounted, result(78), {}, 3);
    assert.equal(discountHarness.notifications.length, 2);
    assert.match(discountHarness.notifications[0].options.message, /Discount reached 21\.0%/);

    const restockHarness = await loadBackground();
    const stocked = item('B000000002', { currentPrice: 10 });
    restockHarness.api.processScrapeResult(stocked, result(10, true), {}, 1);
    restockHarness.api.processScrapeResult(stocked, result(10, false), {}, 2);
    restockHarness.api.processScrapeResult(stocked, result(10, true), {}, 3);
    assert.equal(restockHarness.notifications.length, 1);
    assert.match(restockHarness.notifications[0].options.message, /back in stock/);
  });

  it('counts reached target and discount conditions while excluding purchased items from the badge', async () => {
    const harness = await loadBackground([
      item('B000000001', { currentPrice: 9, targetPrice: 10 }),
      item('B000000002', { currentPrice: 75, originalPrice: 100, targetDiscountPercentage: 20 }),
      item('B000000003', { currentPrice: 5, targetPrice: 10, isPurchased: true }),
      item('B000000004', { currentPrice: 20, targetPrice: 10 })
    ]);

    await harness.api.updateBadgeCount();
    assert.equal(harness.badgeTexts.at(-1), '2');
  });
});

describe('bounded wishlist bulk import', () => {
  it('accepts a normal dashboard import and upgrades its legacy HTTP product URL', async () => {
    const harness = await loadBackground();
    const response = await harness.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS',
      items: [item('B000000001', {
        url: 'http://www.amazon.com/gp/product/B000000001?legacy=1',
        wishlistIds: ['LIST_1']
      })]
    }, dashboardSender());

    assert.equal(response.success, true);
    assert.equal(harness.getTrackedItems().length, 1);
    assert.equal(harness.getTrackedItems()[0].url, 'https://www.amazon.com/dp/B000000001');
    assert.deepEqual(Array.from(harness.getTrackedItems()[0].wishlistIds), ['LIST_1']);
  });

  it('accepts the popup auto-import dashboard URL while rejecting other extension pages', async () => {
    const harness = await loadBackground();
    const response = await harness.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS',
      items: [item()]
    }, dashboardSender({
      frameId: 0,
      url: 'chrome-extension://test-extension/src/dashboard/dashboard.html?import=https%3A%2F%2Fwww.amazon.com%2Fhz%2Fwishlist%2Fls%2FLIST1'
    }));
    assert.equal(response.success, true);

    const rejected = await harness.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS',
      items: [item('B000000002')]
    }, dashboardSender({ url: 'chrome-extension://test-extension/src/options/options.html' }));
    assert.match(rejected.error, /Unauthorized/i);
  });

  it('rejects unauthorized, oversized, and collection-overflow imports', async () => {
    const unauthorized = await loadBackground();
    assert.match((await unauthorized.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS', items: [item()]
    }, sender())).error, /Unauthorized/i);

    const oversized = await loadBackground();
    assert.match((await oversized.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS',
      items: Array.from({ length: 2001 }, () => item())
    }, dashboardSender())).error, /2000/);

    const fullCollection = Array.from({ length: 5000 }, (_, index) => ({ id: `X${String(index).padStart(9, '0')}` }));
    const full = await loadBackground(fullCollection);
    assert.match((await full.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS', items: [item()]
    }, dashboardSender())).error, /5000/);
    assert.equal(full.getTrackedItems().length, 5000);
  });
});
