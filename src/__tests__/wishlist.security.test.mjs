import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../background/background.js', import.meta.url), 'utf8');
const legacyNoticeSource = await readFile(new URL('../background/legacy_target_notice.js', import.meta.url), 'utf8');
const partialPolicySource = await readFile(new URL('../background/wishlist_partial_policy.js', import.meta.url), 'utf8');
const settingsSource = await readFile(new URL('../utils/settings.js', import.meta.url), 'utf8');

async function loadHarness({ storedState = {}, cursor = 0, scrapeResult, trackedItems = [] } = {}) {
  const storage = new Map([
    ['trackedWishlists', [
      { id: 'LIST-A', url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A', autoSync: true },
      { id: 'LIST-B', url: 'https://www.amazon.com/hz/wishlist/ls/LIST-B', autoSync: true }
    ]],
    ['priceHistory', {}],
    ['settings', {}],
    ['wishlistScrapeCursor', cursor],
    ['wishlistScrapeState', storedState],
    ['trackedItems', trackedItems.map((item) => ({ ...item }))]
  ]);
  const alarmCreates = [];
  let scrapeCalls = 0;

  const context = vm.createContext({
    URL,
    Set,
    Map,
    Date,
    Math,
    Number,
    Promise,
    TextEncoder,
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
        onMessage: { addListener() {} }
      },
      alarms: {
        async create(name, options) { alarmCreates.push({ name, options }); },
        async get(name) { return { name, periodInMinutes: name === 'checkPricesAlarm' ? null : 2 }; },
        async clear() {},
        onAlarm: { addListener() {} }
      },
      storage: { local: { async remove() {} }, onChanged: { addListener() {} } },
      notifications: { create() {}, onButtonClicked: { addListener() {} }, onClicked: { addListener() {} } },
      tabs: { async create() {} },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
    }
  });

  const scraperModule = new vm.SyntheticModule(
    ['scrapeAmazonProduct', 'scrapeAmazonWishlist', 'closeOffscreenDocument'],
    function initialize() {
      this.setExport('scrapeAmazonProduct', async () => ({ success: false }));
      this.setExport('scrapeAmazonWishlist', async () => {
        scrapeCalls += 1;
        return scrapeResult;
      });
      this.setExport('closeOffscreenDocument', async () => {});
    },
    { context }
  );

  const amazonModule = new vm.SyntheticModule(
    ['getAmazonWishlistId', 'migrateLegacyWishlistRecords', 'normalizeStoredAmazonProductUrl', 'parseCanonicalAmazonWishlistUrl', 'sanitizeAmazonImageUrl'],
    function initialize() {
      const parseWishlist = (value) => {
        try {
          const parsed = new URL(value);
          return parsed.protocol === 'https:' && /(^|\.)amazon\.(com(?:\.tr)?|nl|de|fr|es|it|co\.uk)$/i.test(parsed.hostname) &&
            /\/(?:hz\/)?wishlist\/ls\/[a-z0-9_=-]{1,64}(?:[/?#]|$)/i.test(parsed.pathname)
            ? parsed
            : null;
        } catch { return null; }
      };
      this.setExport('getAmazonWishlistId', (value) =>
        parseWishlist(value)?.pathname.match(/\/(?:hz\/)?wishlist\/ls\/([a-z0-9_=-]{1,64})(?:[/?#]|$)/i)?.[1] || null
      );
      this.setExport('migrateLegacyWishlistRecords', (wishlists) => wishlists.map((entry) => ({ ...entry })));
      this.setExport('normalizeStoredAmazonProductUrl', () => null);
      this.setExport('parseCanonicalAmazonWishlistUrl', parseWishlist);
      this.setExport('sanitizeAmazonImageUrl', () => '');
    },
    { context }
  );

  const StorageKeys = {
    TRACKED_ITEMS: 'trackedItems',
    TRACKED_WISHLISTS: 'trackedWishlists',
    SETTINGS: 'settings',
    PRICE_HISTORY: 'priceHistory',
    PRICE_HISTORY_GENERATION: 'priceHistoryGeneration',
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
    ['getTrackedItems', 'saveTrackedItem', 'updateTrackedItems', 'updateTrackedItemsIf', 'updateTrackedItemsWithFinalizer', 'updateTrackedWishlists', 'replaceTrackingData', 'updatePriceHistory', 'clearPriceHistory', 'getStorageData', 'setStorageData', 'setStorageItems', 'formatPrice', 'prunePriceHistory', 'StorageKeys', 'StorageArea'],
    function initialize() {
      this.setExport('getTrackedItems', async () => storage.get('trackedItems') || []);
      this.setExport('saveTrackedItem', async () => {});
      this.setExport('updateTrackedItems', async (updater) => {
        storage.set('trackedItems', updater(storage.get('trackedItems') || []));
      });
      this.setExport('updateTrackedItemsIf', async (updater) => {
        const currentItems = storage.get('trackedItems') || [];
        const outcome = updater(currentItems) || { commit: false };
        if (outcome.commit) storage.set('trackedItems', outcome.items);
        return outcome.result;
      });
      this.setExport('updateTrackedItemsWithFinalizer', async (updater, finalizer) => {
        const currentItems = storage.get('trackedItems') || [];
        const originalItems = currentItems.map((item) => ({ ...item }));
        const outcome = updater(currentItems) || { commit: false };
        if (!outcome.commit) return outcome.result;
        storage.set('trackedItems', outcome.items);
        try {
          await finalizer(outcome.result);
          return outcome.result;
        } catch (error) {
          storage.set('trackedItems', originalItems);
          throw error;
        }
      });
      this.setExport('updateTrackedWishlists', async (updater) => {
        storage.set(
          'trackedWishlists',
          updater(storage.get('trackedWishlists') || [], storage.get('trackedItems') || [])
        );
      });
      this.setExport('updatePriceHistory', async (updater) => {
        storage.set('priceHistory', updater(storage.get('priceHistory') || {}));
      });
      this.setExport('clearPriceHistory', async () => {});
      this.setExport('replaceTrackingData', async () => {});
      this.setExport('getStorageData', async (key) => storage.has(key) ? storage.get(key) : null);
      this.setExport('setStorageData', async (key, value) => { storage.set(key, value); });
      this.setExport('setStorageItems', async (values) => {
        Object.entries(values).forEach(([key, value]) => storage.set(key, value));
      });
      this.setExport('formatPrice', (price, currency) => `${currency || ''}${price}`);
      this.setExport('prunePriceHistory', async () => {});
      this.setExport('StorageKeys', StorageKeys);
      this.setExport('StorageArea', StorageArea);
    },
    { context }
  );

  const legacyNoticeModule = new vm.SourceTextModule(legacyNoticeSource, { context });
  const partialPolicyModule = new vm.SourceTextModule(partialPolicySource, { context });
  const settingsModule = new vm.SourceTextModule(settingsSource, { context });
  const backupModule = new vm.SyntheticModule(
    ['validateBackupPayload'],
    function initialize() { this.setExport('validateBackupPayload', (backup) => backup); },
    { context }
  );

  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    if (specifier === './scraper.js') return scraperModule;
    if (specifier === '../utils/storage.js') return storageModule;
    if (specifier === '../utils/amazon.js') return amazonModule;
    if (specifier === '../utils/backup.js') return backupModule;
    if (specifier === '../utils/settings.js') return settingsModule;
    if (specifier === './legacy_target_notice.js') return legacyNoticeModule;
    if (specifier === './wishlist_partial_policy.js') return partialPolicyModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();
  await new Promise((resolve) => setTimeout(resolve, 0));

  return { api: module.namespace, storage, alarmCreates, getScrapeCalls: () => scrapeCalls };
}

function wishlistItem(id) {
  return {
    id,
    title: `Product ${id}`,
    url: `https://www.amazon.com/dp/${id}`,
    currentPrice: 10,
    currency: '$',
    inStock: true
  };
}

describe('bounded and fair wishlist continuation', () => {
  it('merges stale scrape appends into the latest price history without losing a concurrent sample', async () => {
    const id = 'B000000001';
    const harness = await loadHarness();
    const staleHistory = { [id]: [{ price: 10, timestamp: 1 }] };
    const baselineLengths = harness.api.captureHistoryLengths(staleHistory);
    staleHistory[id].push({ price: 8, timestamp: 3 });
    harness.storage.set('priceHistory', {
      [id]: [{ price: 10, timestamp: 1 }, { price: 9, timestamp: 2 }]
    });

    await harness.api.persistHistoryAppends(staleHistory, baselineLengths, new Set([id]));
    await harness.api.persistHistoryAppends(staleHistory, baselineLengths, new Set([id]));

    assert.deepEqual(
      Array.from(harness.storage.get('priceHistory')[id], point => point.timestamp),
      [1, 2, 3]
    );
  });

  it('preserves a concurrent individual-tracking decision during stale removal', async () => {
    const id = 'B000000001';
    const harness = await loadHarness({
      trackedItems: [{
        ...wishlistItem(id),
        trackedIndividually: true,
        wishlistIds: ['LIST-A']
      }]
    });

    await harness.api.persistScrapeResults(
      [{ ...wishlistItem(id), trackedIndividually: false, wishlistIds: [] }],
      new Set([id]),
      new Set(),
      new Set([id]),
      'LIST-A'
    );

    const [persisted] = harness.storage.get('trackedItems');
    assert.equal(persisted.id, id);
    assert.equal(persisted.trackedIndividually, true);
    assert.deepEqual(Array.from(persisted.wishlistIds), []);
  });

  it('still removes a latest-state wishlist-only orphan after complete reconciliation', async () => {
    const id = 'B000000001';
    const harness = await loadHarness({
      trackedItems: [{ ...wishlistItem(id), trackedIndividually: false, wishlistIds: ['LIST-A'] }]
    });

    await harness.api.persistScrapeResults(
      [{ ...wishlistItem(id), wishlistIds: [] }],
      new Set([id]),
      new Set(),
      new Set([id]),
      'LIST-A'
    );

    assert.deepEqual(harness.storage.get('trackedItems'), []);
  });

  it('removes a purchased wishlist-only item after a complete reconciliation', async () => {
    const id = 'B000000001';
    const harness = await loadHarness({
      trackedItems: [{ ...wishlistItem(id), trackedIndividually: false, wishlistIds: ['LIST-A'] }],
      scrapeResult: {
        success: true,
        complete: true,
        items: [{ ...wishlistItem(id), isPurchased: true }],
        pagesProcessed: 1,
        bytesProcessed: 1000
      }
    });

    await harness.api.runWishlistCheckBatch();

    assert.deepEqual(harness.storage.get('trackedItems'), []);
  });

  it('does not remove a purchased item from an incomplete wishlist traversal', async () => {
    const id = 'B000000001';
    const harness = await loadHarness({
      trackedItems: [{ ...wishlistItem(id), trackedIndividually: false, wishlistIds: ['LIST-A'] }],
      scrapeResult: {
        success: true,
        complete: false,
        nextPageUrl: 'https://www.amazon.com/hz/wishlist/ls/LIST-A?page=2',
        items: [{ ...wishlistItem(id), isPurchased: true }],
        pagesProcessed: 1,
        bytesProcessed: 1000
      }
    });

    await harness.api.runWishlistCheckBatch();

    assert.equal(harness.storage.get('trackedItems').length, 1);
  });

  it('persists cumulative metrics and advances to the next wishlist after a partial chunk', async () => {
    const startedAt = Date.now() - 60_000;
    const harness = await loadHarness({
      storedState: {
        'LIST-A': {
          nextPageUrl: 'https://www.amazon.com/hz/wishlist/ls/LIST-A?page=2',
          items: [wishlistItem('B000000001')],
          pagesProcessed: 3,
          bytesProcessed: 1000,
          startedAt
        }
      },
      scrapeResult: {
        success: true,
        complete: false,
        nextPageUrl: 'https://www.amazon.com/hz/wishlist/ls/LIST-A?page=4',
        items: [wishlistItem('B000000002')],
        pagesProcessed: 2,
        bytesProcessed: 2000
      }
    });

    await harness.api.runWishlistCheckBatch();

    assert.equal(harness.storage.get('wishlistScrapeCursor'), 1);
    const state = harness.storage.get('wishlistScrapeState')['LIST-A'];
    assert.equal(state.pagesProcessed, 5);
    assert.equal(state.bytesProcessed, 3000);
    assert.equal(state.startedAt, startedAt);
    assert.deepEqual(Array.from(state.items, (item) => item.id), ['B000000001', 'B000000002']);
    assert.ok(harness.alarmCreates.some((entry) => entry.name === 'continueWishlistSyncAlarm'));
  });

  for (const error of ['CAPTCHA_BLOCKED', 'RATE_LIMITED']) {
    it(`preserves partial state and schedules a backed-off continuation after ${error}`, async () => {
      const startedAt = Date.now() - 60_000;
      const harness = await loadHarness({
        storedState: {
          'LIST-A': {
            nextPageUrl: 'https://www.amazon.com/hz/wishlist/ls/LIST-A?page=2',
            items: [wishlistItem('B000000001')],
            pagesProcessed: 1,
            bytesProcessed: 1000,
            startedAt
          }
        },
        scrapeResult: {
          success: true,
          complete: false,
          error,
          nextPageUrl: 'https://www.amazon.com/hz/wishlist/ls/LIST-A?page=3',
          items: [wishlistItem('B000000002')],
          pagesProcessed: 1,
          bytesProcessed: 500
        }
      });

      await harness.api.runWishlistCheckBatch();

      const state = harness.storage.get('wishlistScrapeState')['LIST-A'];
      assert.equal(state.nextPageUrl, 'https://www.amazon.com/hz/wishlist/ls/LIST-A?page=3');
      assert.equal(state.pagesProcessed, 2);
      assert.equal(state.bytesProcessed, 1500);
      assert.equal(state.startedAt, startedAt);
      assert.deepEqual(Array.from(state.items, (item) => item.id), ['B000000001', 'B000000002']);
      assert.ok(Number.isFinite(harness.storage.get('captchaBackoffUntil')));
      assert.equal(harness.storage.get('captchaBackoffAttempts'), 1);
      assert.ok(harness.alarmCreates.some((entry) =>
        entry.name === 'continueWishlistSyncAlarm' &&
        entry.options.when >= harness.storage.get('captchaBackoffUntil')
      ));
    });
  }

  it('discards an expired cumulative state without scraping or deleting tracked data', async () => {
    const harness = await loadHarness({
      storedState: {
        'LIST-A': {
          nextPageUrl: 'https://www.amazon.com/hz/wishlist/ls/LIST-A?page=151',
          items: [wishlistItem('B000000001')],
          pagesProcessed: 150,
          bytesProcessed: 1000,
          startedAt: Date.now() - 60_000
        }
      },
      scrapeResult: { success: false }
    });

    await harness.api.runWishlistCheckBatch();

    assert.equal(harness.getScrapeCalls(), 0);
    assert.equal(harness.storage.get('wishlistScrapeCursor'), 1);
    assert.equal('LIST-A' in harness.storage.get('wishlistScrapeState'), false);
  });
});
