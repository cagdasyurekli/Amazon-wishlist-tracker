import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const backgroundSource = await readFile(new URL('../background/background.js', import.meta.url), 'utf8');
const legacyNoticeSource = await readFile(new URL('../background/legacy_target_notice.js', import.meta.url), 'utf8');
const partialPolicySource = await readFile(new URL('../background/wishlist_partial_policy.js', import.meta.url), 'utf8');
const settingsSource = await readFile(new URL('../utils/settings.js', import.meta.url), 'utf8');

async function loadBackground(initialItems = [], options = {}) {
  let trackedItems = initialItems.map((item) => ({ ...item }));
  let currentSettings = { ...(options.settings || {}) };
  let settingsWriteCompleted = false;
  let settingsWriteCount = 0;
  let messageListener;
  let alarmListener;
  const savedItems = [];
  const notifications = [];
  const badgeTexts = [];
  const restoredBackups = [];
  const localStorage = new Map(Object.entries(options.localStorage || {}));
  let priceHistory = structuredClone(options.priceHistory || {});
  localStorage.set('priceHistory', priceHistory);
  let wishlistScrapeCalls = 0;
  let offscreenCloseCalls = 0;

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
        onAlarm: { addListener(listener) { alarmListener = listener; } }
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
      this.setExport('scrapeAmazonWishlist', async (url) => {
        wishlistScrapeCalls += 1;
        if (options.scrapeAmazonWishlist) return options.scrapeAmazonWishlist(url);
        return options.wishlistScrapeResult || { success: false };
      });
      this.setExport('closeOffscreenDocument', async () => { offscreenCloseCalls += 1; });
    },
    { context }
  );

  const amazonModule = new vm.SyntheticModule(
    ['getAmazonWishlistId', 'migrateLegacyWishlistRecords', 'normalizeStoredAmazonProductUrl', 'parseCanonicalAmazonWishlistUrl', 'sanitizeAmazonImageUrl'],
    function initialize() {
      const parseWishlist = (value) => {
        try {
          const parsed = new URL(value);
          return parsed.protocol === 'https:' && /(^|\.)amazon\.(com|nl|de|fr|es|it|co\.uk)$/i.test(parsed.hostname) &&
            /\/(?:hz\/)?wishlist\/ls\/[a-z0-9_-]{1,64}(?:[/?#]|$)/i.test(parsed.pathname)
            ? parsed
            : null;
        } catch { return null; }
      };
      this.setExport('getAmazonWishlistId', (value) =>
        parseWishlist(value)?.pathname.match(/\/(?:hz\/)?wishlist\/ls\/([a-z0-9_-]{1,64})(?:[/?#]|$)/i)?.[1] || null
      );
      this.setExport('migrateLegacyWishlistRecords', (wishlists) => wishlists.map((entry) =>
        typeof entry === 'string'
          ? { id: entry, url: null, autoSync: false, needsRegionReview: true }
          : { ...entry }
      ));
      this.setExport('normalizeStoredAmazonProductUrl', (value, expectedAsin) => {
        try {
          const parsed = new URL(value);
          const asin = parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase();
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port ||
              !/(^|\.)amazon\.(com|nl|de|fr|es|it|co\.uk)$/i.test(parsed.hostname) || asin !== expectedAsin) return null;
          return `https://${parsed.hostname.toLowerCase()}/dp/${asin}`;
        } catch { return null; }
      });
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
    [
      'getTrackedItems', 'saveTrackedItem', 'updateTrackedItems', 'updateTrackedItemsIf', 'updateTrackedItemsWithFinalizer', 'updateTrackedWishlists', 'updatePriceHistory', 'getStorageData',
      'replaceTrackingData', 'clearPriceHistory', 'setStorageData', 'setStorageItems', 'formatPrice', 'prunePriceHistory', 'StorageKeys', 'StorageArea'
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
      this.setExport('updateTrackedWishlists', async (updater) => {
        localStorage.set(
          StorageKeys.TRACKED_WISHLISTS,
          updater(localStorage.get(StorageKeys.TRACKED_WISHLISTS) || [], trackedItems)
        );
      });
      this.setExport('updatePriceHistory', async (updater) => {
        priceHistory = updater(priceHistory);
        localStorage.set(StorageKeys.PRICE_HISTORY, priceHistory);
      });
      this.setExport('clearPriceHistory', async () => {
        const nextGeneration = (Number(localStorage.get(StorageKeys.PRICE_HISTORY_GENERATION)) || 0) + 1;
        priceHistory = {};
        localStorage.set(StorageKeys.PRICE_HISTORY, priceHistory);
        localStorage.set(StorageKeys.PRICE_HISTORY_GENERATION, nextGeneration);
        return nextGeneration;
      });
      this.setExport('replaceTrackingData', async (backup) => {
        if (options.beforeRestore) await options.beforeRestore(backup);
        restoredBackups.push(backup);
        trackedItems = backup.items.map((entry) => ({ ...entry }));
        currentSettings = { ...backup.settings };
      });
      this.setExport('getStorageData', async (key, area) => {
        if (key === StorageKeys.SETTINGS && area === StorageArea.SYNC) {
          if (options.failSettingsReadAfterWrite && settingsWriteCompleted) {
            throw new Error('Synthetic Sync readback failure');
          }
          return { ...currentSettings };
        }
        if (area === StorageArea.LOCAL) {
          const value = localStorage.get(key);
          return value == null ? null : structuredClone(value);
        }
        return null;
      });
      this.setExport('setStorageData', async (key, value, area) => {
        if (key === StorageKeys.SETTINGS && area === StorageArea.SYNC) {
          if (options.failSettingsWrite) throw new Error('Synthetic Sync write failure');
          settingsWriteCount += 1;
          if (options.beforeSettingsWrite) await options.beforeSettingsWrite(value, settingsWriteCount);
          currentSettings = { ...value };
          settingsWriteCompleted = true;
          return;
        }
        if (area === StorageArea.LOCAL) localStorage.set(key, value);
      });
      this.setExport('setStorageItems', async (values, area) => {
        if (area !== StorageArea.LOCAL) return;
        Object.entries(values).forEach(([key, value]) => {
          localStorage.set(key, value);
          if (key === StorageKeys.PRICE_HISTORY) priceHistory = value;
        });
      });
      this.setExport('formatPrice', (price, currency) => `${currency || ''}${price}`);
      this.setExport('prunePriceHistory', async () => {
        if (options.prunePriceHistory) await options.prunePriceHistory();
      });
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
    function initialize() {
      this.setExport('validateBackupPayload', (backup) => {
        if (!backup || !Array.isArray(backup.items)) throw new Error('Invalid synthetic backup');
        return backup;
      });
    },
    { context }
  );

  const module = new vm.SourceTextModule(backgroundSource, { context });
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

  const sendMessage = (message, sender) => new Promise((resolve) => {
    assert.equal(messageListener(message, sender, resolve), true);
  });

  return {
    api: module.namespace,
    sendMessage,
    triggerAlarm: (name) => alarmListener({ name }),
    savedItems,
    notifications,
    badgeTexts,
    restoredBackups,
    getTrackedItems: () => trackedItems,
    getSettings: () => currentSettings,
    getSettingsWriteCount: () => settingsWriteCount,
    getPriceHistory: () => priceHistory,
    getLocalStorage: (key) => localStorage.get(key),
    getWishlistScrapeCalls: () => wishlistScrapeCalls,
    getOffscreenCloseCalls: () => offscreenCloseCalls
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

describe('serialized settings patches', () => {
  it('enforces sender-scoped fields and validates supported values', async () => {
    const harness = await loadBackground([], {
      settings: { defaultTargetPrice: 12.5 }
    });

    const optionsPatch = await harness.sendMessage({
      type: 'PATCH_SETTINGS',
      set: { defaultDiscount: 20, historyRetentionDays: '365' }
    }, optionsSender());
    assert.equal(optionsPatch.success, true);
    assert.equal(optionsPatch.settings.defaultTargetPrice, 12.5);
    assert.equal(optionsPatch.settings.defaultDiscount, 20);
    assert.equal(optionsPatch.settings.historyRetentionDays, '365');

    const dashboardPatch = await harness.sendMessage({
      type: 'PATCH_SETTINGS',
      set: { dashboardSort: 'priceAsc', dashboardFilter: 'priority' }
    }, dashboardSender());
    assert.equal(dashboardPatch.success, true);
    assert.equal(dashboardPatch.settings.defaultDiscount, 20);
    assert.equal(dashboardPatch.settings.dashboardSort, 'priceAsc');
    assert.equal(dashboardPatch.settings.dashboardFilter, 'priority');

    const rejected = await Promise.all([
      harness.sendMessage({ type: 'PATCH_SETTINGS', set: { dashboardSort: 'recent' } }, optionsSender()),
      harness.sendMessage({ type: 'PATCH_SETTINGS', set: { defaultDiscount: 25 } }, dashboardSender()),
      harness.sendMessage({ type: 'PATCH_SETTINGS', set: { defaultDiscount: 0 } }, optionsSender()),
      harness.sendMessage({ type: 'PATCH_SETTINGS', set: { historyRetentionDays: '31' } }, optionsSender()),
      harness.sendMessage({ type: 'PATCH_SETTINGS', remove: ['defaultTargetPrice'] }, optionsSender()),
      harness.sendMessage({ type: 'PATCH_SETTINGS', set: { dashboardFilter: 'all' } }, dashboardSender({ frameId: 2 })),
      harness.sendMessage(
        { type: 'PATCH_SETTINGS', set: { defaultDiscount: 25 } },
        optionsSender({ url: 'chrome-extension://test-extension/src/popup/popup.html' })
      )
    ]);
    for (const response of rejected) assert.equal(typeof response.error, 'string');
    assert.equal(harness.getSettingsWriteCount(), 2);

    const removed = await harness.sendMessage({
      type: 'PATCH_SETTINGS',
      remove: ['defaultDiscount']
    }, optionsSender());
    assert.equal(removed.success, true);
    assert.equal(Object.hasOwn(removed.settings, 'defaultDiscount'), false);
    assert.equal(removed.settings.dashboardSort, 'priceAsc');
  });

  it('serializes concurrent Options and Dashboard updates without losing fields', async () => {
    let markFirstWriteStarted;
    let releaseFirstWrite;
    const firstWriteStarted = new Promise((resolve) => { markFirstWriteStarted = resolve; });
    const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
    const harness = await loadBackground([], {
      beforeSettingsWrite: async (_settings, writeCount) => {
        if (writeCount !== 1) return;
        markFirstWriteStarted();
        await firstWriteGate;
      }
    });

    const dashboardUpdate = harness.sendMessage({
      type: 'PATCH_SETTINGS',
      set: { dashboardSort: 'priceDesc' }
    }, dashboardSender());
    await firstWriteStarted;
    const optionsUpdate = harness.sendMessage({
      type: 'PATCH_SETTINGS',
      set: { defaultDiscount: 30 }
    }, optionsSender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.getSettingsWriteCount(), 1);

    releaseFirstWrite();
    assert.equal((await dashboardUpdate).success, true);
    const optionsResponse = await optionsUpdate;
    assert.equal(optionsResponse.success, true);
    assert.equal(optionsResponse.settings.dashboardSort, 'priceDesc');
    assert.equal(optionsResponse.settings.defaultDiscount, 30);
    assert.equal(harness.getSettings().dashboardSort, 'priceDesc');
    assert.equal(harness.getSettings().defaultDiscount, 30);
  });

  it('orders restore and legacy acknowledgement with preference patches', async () => {
    let markFirstWriteStarted;
    let releaseFirstWrite;
    const firstWriteStarted = new Promise((resolve) => { markFirstWriteStarted = resolve; });
    const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
    const harness = await loadBackground([item()], {
      settings: { defaultTargetPrice: 12.5, defaultDiscount: 10 },
      beforeSettingsWrite: async (_settings, writeCount) => {
        if (writeCount !== 1) return;
        markFirstWriteStarted();
        await firstWriteGate;
      }
    });

    const preferenceUpdate = harness.sendMessage({
      type: 'PATCH_SETTINGS',
      set: { defaultDiscount: 40 }
    }, optionsSender());
    await firstWriteStarted;
    const acknowledgement = harness.sendMessage({
      type: 'ACKNOWLEDGE_LEGACY_TARGET_PRICE',
      targetPrice: 12.5
    }, optionsSender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.getSettingsWriteCount(), 1);

    releaseFirstWrite();
    assert.equal((await preferenceUpdate).success, true);
    const acknowledged = await acknowledgement;
    assert.equal(acknowledged.success, true);
    assert.equal(acknowledged.settings.defaultDiscount, 40);
    assert.equal(Object.hasOwn(acknowledged.settings, 'defaultTargetPrice'), false);

    let markSecondPatchStarted;
    let releaseSecondPatch;
    const secondPatchStarted = new Promise((resolve) => { markSecondPatchStarted = resolve; });
    const secondPatchGate = new Promise((resolve) => { releaseSecondPatch = resolve; });
    const restoreHarness = await loadBackground([item()], {
      beforeSettingsWrite: async (_settings, writeCount) => {
        if (writeCount !== 1) return;
        markSecondPatchStarted();
        await secondPatchGate;
      }
    });
    const secondPatch = restoreHarness.sendMessage({
      type: 'PATCH_SETTINGS',
      set: { defaultDiscount: 35 }
    }, optionsSender());
    await secondPatchStarted;
    const backup = {
      items: [item('B000000002')],
      history: {},
      trackedWishlists: [],
      settings: { historyRetentionDays: 'forever' },
      summary: { itemCount: 1, historyPointCount: 0, wishlistCount: 0 }
    };
    const restore = restoreHarness.sendMessage({ type: 'RESTORE_BACKUP', backup }, optionsSender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(restoreHarness.restoredBackups.length, 0);

    releaseSecondPatch();
    assert.equal((await secondPatch).success, true);
    const restored = await restore;
    assert.equal(restored.success, true);
    assert.equal(restored.settings.historyRetentionDays, 'forever');
    assert.equal(restoreHarness.getSettings().historyRetentionDays, 'forever');
    assert.equal(Object.hasOwn(restoreHarness.getSettings(), 'defaultDiscount'), false);
  });
});

describe('tracked wishlist mutation boundary', () => {
  it('keeps unresolved legacy regions fail-closed and accepts review only from Dashboard', async () => {
    const harness = await loadBackground([], {
      localStorage: { trackedWishlists: ['LEGACY_LIST-1'] }
    });

    assert.deepEqual(Array.from(harness.getLocalStorage('trackedWishlists'), (entry) => ({ ...entry })), [{
      id: 'LEGACY_LIST-1',
      url: null,
      autoSync: false,
      needsRegionReview: true
    }]);

    const unauthorizedMigration = await harness.sendMessage(
      { type: 'MIGRATE_LEGACY_WISHLISTS' },
      optionsSender()
    );
    assert.match(unauthorizedMigration.error, /Unauthorized/i);

    const unauthorizedUpdate = await harness.sendMessage({
      type: 'UPSERT_TRACKED_WISHLIST',
      url: 'https://www.amazon.de/hz/wishlist/ls/LEGACY_LIST-1',
      autoSync: true
    }, optionsSender());
    assert.match(unauthorizedUpdate.error, /Unauthorized/i);

    const resolved = await harness.sendMessage({
      type: 'UPSERT_TRACKED_WISHLIST',
      url: 'https://www.amazon.de/hz/wishlist/ls/LEGACY_LIST-1',
      autoSync: true
    }, dashboardSender());
    assert.equal(resolved.success, true);
    assert.deepEqual(Array.from(resolved.wishlists, (entry) => ({ ...entry })), [{
      id: 'LEGACY_LIST-1',
      url: 'https://www.amazon.de/hz/wishlist/ls/LEGACY_LIST-1',
      autoSync: true
    }]);

    const lookalike = await harness.sendMessage({
      type: 'UPSERT_TRACKED_WISHLIST',
      url: 'https://amazon.de.example/hz/wishlist/ls/LEGACY_LIST-1'
    }, dashboardSender());
    assert.match(lookalike.error, /Invalid/i);
  });
});

describe('ADD_TRACKED_ITEM privilege boundary', () => {
  it('accepts one bounded item from the matching HTTPS Amazon tab', async () => {
    const harness = await loadBackground();
    const beforeTracking = Date.now();

    const response = await harness.sendMessage({ type: 'ADD_TRACKED_ITEM', item: item() }, sender());
    const afterTracking = Date.now();

    assert.equal(response.success, true);
    assert.equal(harness.savedItems.length, 1);
    assert.deepEqual(harness.savedItems[0], {
      id: 'B000000001',
      title: 'A legitimate product',
      url: 'https://www.amazon.com/dp/B000000001',
      currentPrice: 19.99,
      currency: '$',
      originalPrice: 19.99,
      trackedIndividually: true,
      trackingStartPrice: 19.99,
      trackingStartedAt: harness.savedItems[0].trackingStartedAt,
      trackingBaselineExact: true
    });
    assert.ok(harness.savedItems[0].trackingStartedAt >= beforeTracking);
    assert.ok(harness.savedItems[0].trackingStartedAt <= afterTracking);
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

describe('backup restore privilege boundary', () => {
  it('accepts restore only from the top-level Options page', async () => {
    const harness = await loadBackground([item()]);
    const backup = {
      items: [item('B000000002')],
      history: {},
      trackedWishlists: [],
      settings: { defaultDiscount: 20 },
      summary: { itemCount: 1, historyPointCount: 0, wishlistCount: 0 }
    };

    const unauthorized = await harness.sendMessage({ type: 'RESTORE_BACKUP', backup }, dashboardSender());
    assert.match(unauthorized.error, /Unauthorized/i);
    assert.equal(harness.restoredBackups.length, 0);

    const nestedFrame = await harness.sendMessage(
      { type: 'RESTORE_BACKUP', backup },
      optionsSender({ frameId: 2 })
    );
    assert.match(nestedFrame.error, /Unauthorized/i);
    assert.equal(harness.restoredBackups.length, 0);

    const restored = await harness.sendMessage({ type: 'RESTORE_BACKUP', backup }, optionsSender());
    assert.equal(restored.success, true);
    assert.deepEqual(restored.summary, backup.summary);
    assert.equal(harness.restoredBackups.length, 1);
    assert.equal(harness.getTrackedItems()[0].id, 'B000000002');
  });

  it('waits for the scrape queue before committing a replacement', async () => {
    const harness = await loadBackground([item()]);
    let releaseScrape;
    const heldScrape = harness.api.enqueueScrapeJob(() => new Promise((resolve) => {
      releaseScrape = resolve;
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const backup = {
      items: [item('B000000002')],
      history: {},
      trackedWishlists: [],
      settings: {},
      summary: { itemCount: 1, historyPointCount: 0, wishlistCount: 0 }
    };

    const restoreResponse = harness.sendMessage({ type: 'RESTORE_BACKUP', backup }, optionsSender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.restoredBackups.length, 0);
    assert.equal(harness.getTrackedItems()[0].id, 'B000000001');

    releaseScrape();
    await heldScrape;
    const response = await restoreResponse;
    assert.equal(response.success, true);
    assert.equal(harness.getTrackedItems()[0].id, 'B000000002');
  });

  it('keeps retention pruning inside the queue before a later restore commits', async () => {
    let releasePrune;
    let markPruneStarted;
    const pruneStarted = new Promise((resolve) => { markPruneStarted = resolve; });
    const pruneBarrier = new Promise((resolve) => { releasePrune = resolve; });
    const harness = await loadBackground([], {
      prunePriceHistory: async () => {
        markPruneStarted();
        await pruneBarrier;
      }
    });
    const backup = {
      items: [item('B000000002')],
      history: { B000000002: [{ price: 8, timestamp: 1 }] },
      trackedWishlists: [],
      settings: { historyRetentionDays: 'forever' },
      summary: { itemCount: 1, historyPointCount: 1, wishlistCount: 0 }
    };

    const alarmRun = harness.triggerAlarm('checkPricesAlarm');
    await pruneStarted;
    const restoreResponse = harness.sendMessage({ type: 'RESTORE_BACKUP', backup }, optionsSender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.restoredBackups.length, 0);

    releasePrune();
    await alarmRun;
    assert.equal((await restoreResponse).success, true);
    assert.equal(harness.restoredBackups.length, 1);
    assert.equal(harness.getTrackedItems()[0].id, 'B000000002');
  });
});

describe('manual wishlist scrape coordination', () => {
  it('requires the Dashboard sender and makes no request during persisted backoff', async () => {
    const backoffUntil = Date.now() + 60_000;
    const harness = await loadBackground([], {
      localStorage: { captchaBackoffUntil: backoffUntil }
    });

    const unauthorized = await harness.sendMessage(
      { type: 'EXTRACT_WISHLIST', url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A' },
      optionsSender()
    );
    assert.match(unauthorized.error, /Unauthorized/i);

    const paused = await harness.sendMessage(
      { type: 'EXTRACT_WISHLIST', url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A' },
      dashboardSender()
    );
    assert.equal(paused.error, 'SCRAPE_BACKOFF_ACTIVE');
    assert.equal(paused.paused, true);
    assert.equal(paused.backoffUntil, backoffUntil);
    assert.equal(harness.getWishlistScrapeCalls(), 0);
    assert.equal(harness.getOffscreenCloseCalls(), 0);
  });

  it('waits for the shared queue, preserves partial items, activates backoff, and closes the parser', async () => {
    const harness = await loadBackground([], {
      wishlistScrapeResult: {
        success: true,
        complete: false,
        error: 'RATE_LIMITED',
        stopReason: 'RATE_LIMITED',
        items: [item()]
      }
    });
    let releaseHeldJob;
    const heldJob = harness.api.enqueueScrapeJob(() => new Promise((resolve) => {
      releaseHeldJob = resolve;
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const responsePromise = harness.sendMessage(
      { type: 'EXTRACT_WISHLIST', url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A' },
      dashboardSender()
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.getWishlistScrapeCalls(), 0);

    releaseHeldJob();
    await heldJob;
    const response = await responsePromise;
    assert.equal(response.success, true);
    assert.equal(response.paused, true);
    assert.equal(response.error, 'RATE_LIMITED');
    assert.equal(response.items[0].id, 'B000000001');
    assert.equal(harness.getWishlistScrapeCalls(), 1);
    assert.equal(harness.getOffscreenCloseCalls(), 1);
    assert.equal(harness.getLocalStorage('captchaBackoffAttempts'), 1);
    assert.ok(harness.getLocalStorage('captchaBackoffUntil') > Date.now());
  });

  it('clears an expired backoff attempt counter after a successful manual read', async () => {
    const harness = await loadBackground([], {
      localStorage: {
        captchaBackoffUntil: Date.now() - 1000,
        captchaBackoffAttempts: 2
      },
      wishlistScrapeResult: {
        success: true,
        complete: true,
        items: [item()]
      }
    });

    const response = await harness.sendMessage(
      { type: 'EXTRACT_WISHLIST', url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A' },
      dashboardSender()
    );

    assert.equal(response.success, true);
    assert.equal(harness.getLocalStorage('captchaBackoffAttempts'), 0);
    assert.equal(harness.getLocalStorage('captchaBackoffUntil'), 0);
    assert.equal(harness.getOffscreenCloseCalls(), 1);
  });
});

describe('price history clear coordination', () => {
  it('requires the Options page and waits behind in-flight history producers', async () => {
    const originalHistory = { B000000001: [{ price: 20, timestamp: 1 }] };
    const harness = await loadBackground([], { priceHistory: originalHistory });

    const unauthorized = await harness.sendMessage({ type: 'CLEAR_PRICE_HISTORY' }, dashboardSender());
    assert.match(unauthorized.error, /Unauthorized/i);
    assert.deepEqual(harness.getPriceHistory(), originalHistory);

    let releaseHeldJob;
    const heldJob = harness.api.enqueueScrapeJob(() => new Promise((resolve) => {
      releaseHeldJob = resolve;
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clearResponse = harness.sendMessage({ type: 'CLEAR_PRICE_HISTORY' }, optionsSender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(harness.getPriceHistory(), originalHistory);

    releaseHeldJob();
    await heldJob;
    assert.equal((await clearResponse).success, true);
    assert.equal(Object.keys(harness.getPriceHistory()).length, 0);
    assert.equal(harness.getLocalStorage('priceHistoryGeneration'), 1);
  });

  it('does not append history from a wishlist read that predates the clear generation', async () => {
    const harness = await loadBackground([], {
      localStorage: { priceHistoryGeneration: 2 }
    });

    const response = await harness.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS',
      items: [item()],
      historyGeneration: 1
    }, dashboardSender());

    assert.equal(response.success, true);
    assert.equal(Object.keys(harness.getPriceHistory()).length, 0);
    assert.equal(harness.getTrackedItems()[0].id, 'B000000001');
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
  it('records the first successful threshold result as a silent baseline', async () => {
    const targetHarness = await loadBackground();
    const targetItem = item('B000000001', { currentPrice: null, targetPrice: 15, inStock: true });
    const result = (price) => ({
      success: true,
      price,
      currency: '$',
      inStock: true,
      buyBoxPrice: null,
      salesRank: null
    });

    targetHarness.api.processScrapeResult(targetItem, result(14), {}, 1);
    assert.equal(targetHarness.notifications.length, 0);
    targetHarness.api.processScrapeResult(targetItem, result(18), {}, 2);
    targetHarness.api.processScrapeResult(targetItem, result(14), {}, 3);
    assert.equal(targetHarness.notifications.length, 1);

    const discountHarness = await loadBackground();
    const discountItem = item('B000000002', {
      currentPrice: null,
      originalPrice: 100,
      targetDiscountPercentage: 20,
      inStock: true
    });
    discountHarness.api.processScrapeResult(discountItem, result(75), {}, 1);
    assert.equal(discountHarness.notifications.length, 0);
    discountHarness.api.processScrapeResult(discountItem, result(90), {}, 2);
    discountHarness.api.processScrapeResult(discountItem, result(79), {}, 3);
    assert.equal(discountHarness.notifications.length, 1);
  });

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
      historyGeneration: 0,
      items: [item('B000000001', {
        url: 'http://www.amazon.com/gp/product/B000000001?legacy=1',
        wishlistIds: ['LIST_1']
      })]
    }, dashboardSender());

    assert.equal(response.success, true);
    assert.equal(harness.getTrackedItems().length, 1);
    assert.equal(harness.getTrackedItems()[0].url, 'https://www.amazon.com/dp/B000000001');
    assert.deepEqual(Array.from(harness.getTrackedItems()[0].wishlistIds), ['LIST_1']);
    assert.equal(harness.getPriceHistory().B000000001.length, 1);
  });

  it('accepts the popup auto-import dashboard URL while rejecting other extension pages', async () => {
    const harness = await loadBackground();
    const response = await harness.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS',
      historyGeneration: 0,
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
