const path = require('path');
const fs = require('fs');

const EXTENSION_ROOT = path.resolve(__dirname, '../..');

async function getExtensionId(browser) {
  const workerTarget = await browser.waitForTarget(
    (target) =>
      target.type() === 'service_worker' &&
      target.url().startsWith('chrome-extension://'),
    { timeout: 10000 }
  );

  return new URL(workerTarget.url()).host;
}

describe('Chrome extension E2E', () => {
  let browser;
  let extensionId;

  async function launchExtension() {
    const { default: puppeteer } = await import('puppeteer');

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        `--disable-extensions-except=${EXTENSION_ROOT}`,
        `--load-extension=${EXTENSION_ROOT}`,
        '--no-sandbox'
      ]
    });

    extensionId = await getExtensionId(browser);
    expect(extensionId).toMatch(/^[a-p]{32}$/);
  }

  afterEach(async () => {
    if (browser) {
      await browser.close();
      browser = null;
    }
  });

  it('loads the MV3 extension and renders the popup headlessly', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.waitForSelector('.app-container');
    await expect(page.title()).resolves.toBe('Amazon Wishlist Tracker');
    await expect(page.$eval('h1', (node) => node.textContent.trim())).resolves.toBe('Tracked Items');
    // The dashboard must stay reachable from the popup (it has no other entry point).
    await page.waitForSelector('#dashboard-btn');
  }, 30000);

  it('configures balanced adaptive alarms instead of a fixed standard cycle', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    const alarms = await page.evaluate(async () => {
      const all = await chrome.alarms.getAll();
      return Object.fromEntries(all.map(alarm => [alarm.name, alarm]));
    });

    expect(alarms.checkPricesAlarm).toBeDefined();
    expect(alarms.checkPricesAlarm.periodInMinutes).toBeUndefined();
    expect(alarms.checkPriorityPricesAlarm.periodInMinutes).toBe(2);
    expect(alarms.checkWishlistsAlarm.periodInMinutes).toBe(15);
  }, 30000);

  it('persists the dashboard sorting preference across reloads', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{
          id: 'BEXPENSIVE1',
          title: 'Expensive Recent Item',
          currentPrice: 20.00,
          currency: '€',
          inStock: true,
          addedAt: Date.now()
        }, {
          id: 'BCHEAP0001',
          title: 'Cheap Older Item',
          currentPrice: 5.00,
          currency: '€',
          inStock: true,
          addedAt: Date.now() - 1000
        }]
      });
      window.location.reload();
    });

    await page.waitForSelector('.item-card');
    await page.select('#sort-select', 'priceAsc');
    await page.waitForFunction(async () => {
      const { settings } = await chrome.storage.sync.get(['settings']);
      return settings?.dashboardSort === 'priceAsc';
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.item-card');

    await expect(page.$eval('#sort-select', (node) => node.value)).resolves.toBe('priceAsc');
    await expect(page.$eval('.item-card:first-of-type .item-title', (node) => node.textContent)).resolves.toContain('Cheap Older Item');
  }, 30000);

  it('scales the dashboard with progressive rendering, filters, and safe inline actions', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate(async () => {
      const now = Date.now();
      await chrome.storage.local.set({
        trackedItems: Array.from({ length: 75 }, (_, index) => ({
          id: `B${String(index).padStart(9, '0')}`,
          title: `Tracked Product ${index + 1}`,
          currentPrice: 10 + index,
          currency: '€',
          inStock: index % 10 !== 0,
          addedAt: now - index
        }))
      });
      window.location.reload();
    });

    await page.waitForSelector('.item-card');
    await expect(page.$$eval('.item-card', cards => cards.length)).resolves.toBe(50);
    await expect(page.$eval('.list-pagination', node => node.textContent)).resolves.toContain('Showing 50 of 75');
    await expect(page.$eval('#next-checks-summary', node => node.textContent)).resolves.toContain('Standard price checks: 75 due · up to 8 per batch');
    await expect(page.$eval('.item-card .next-check', node => node.textContent)).resolves.toContain('Due now');

    await page.click('.list-pagination button');
    await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 75);

    await page.select('#filter-select', 'outOfStock');
    await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 8);
    await expect(page.$$eval('.stock-status', nodes => nodes.every(node => node.textContent === 'Out of Stock'))).resolves.toBe(true);

    await page.select('#filter-select', 'all');
    await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 50);
    const firstId = await page.$eval('.item-card', card => card.dataset.id);

    await page.click(`.item-card[data-id="${firstId}"] .edit-btn`);
    await page.$eval(`.item-card[data-id="${firstId}"] .target-editor-input`, input => {
      input.value = '7.50';
    });
    await page.click(`.item-card[data-id="${firstId}"] .target-save-btn`);
    await page.waitForFunction(async (id) => {
      const { trackedItems } = await chrome.storage.local.get(['trackedItems']);
      return trackedItems.find(item => item.id === id)?.targetPrice === 7.5;
    }, {}, firstId);

    await page.click(`.item-card[data-id="${firstId}"] .remove-btn`);
    await expect(page.$eval(`.item-card[data-id="${firstId}"] .remove-btn`, node => node.textContent)).resolves.toBe('Confirm remove');
    await expect(page.$(`.item-card[data-id="${firstId}"]`)).resolves.not.toBeNull();
    await page.click(`.item-card[data-id="${firstId}"] .remove-btn`);
    await page.waitForFunction((id) => !document.querySelector(`.item-card[data-id="${id}"]`), {}, firstId);
  }, 30000);

  it('keeps dashboard controls recoverable when a background mutation fails', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{
          id: 'BRECOVER01',
          title: 'Recoverable Item',
          currentPrice: 12.50,
          currency: '€',
          inStock: true,
          addedAt: Date.now()
        }]
      });
      window.location.reload();
    });
    await page.waitForSelector('.item-card[data-id="BRECOVER01"]');

    const interceptionInstalled = await page.evaluate(() => {
      const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === 'UPDATE_TRACKED_ITEM' || message?.type === 'REMOVE_TRACKED_ITEM') {
          queueMicrotask(() => callback({ error: 'Synthetic background failure' }));
          return undefined;
        }
        return originalSendMessage(message, callback);
      };
      return true;
    });
    expect(interceptionInstalled).toBe(true);

    await page.click('.item-card[data-id="BRECOVER01"] .priority-btn');
    await page.waitForFunction(() => document.querySelector('#status-banner')?.textContent.includes('Could not update Priority Tracking'));
    await expect(page.$eval('.item-card[data-id="BRECOVER01"] .priority-btn', node => ({
      disabled: node.disabled,
      text: node.textContent
    }))).resolves.toEqual({ disabled: false, text: '☆' });

    await page.click('.item-card[data-id="BRECOVER01"] .edit-btn');
    await page.$eval('.item-card[data-id="BRECOVER01"] .target-editor-input', input => {
      input.value = '7.50';
    });
    await page.click('.item-card[data-id="BRECOVER01"] .target-save-btn');
    await page.waitForFunction(() => document.querySelector('#status-banner')?.textContent.includes('Could not update the target price'));
    await expect(page.$eval('.item-card[data-id="BRECOVER01"] .target-save-btn', node => node.disabled)).resolves.toBe(false);
    await expect(page.$eval('.item-card[data-id="BRECOVER01"] .target-editor', node => node.hidden)).resolves.toBe(false);

    await page.click('.item-card[data-id="BRECOVER01"] .remove-btn');
    await page.click('.item-card[data-id="BRECOVER01"] .remove-btn');
    await page.waitForFunction(() => document.querySelector('#status-banner')?.textContent.includes('Could not remove this item'));
    await expect(page.$('.item-card[data-id="BRECOVER01"]')).resolves.not.toBeNull();
    await expect(page.$eval('.item-card[data-id="BRECOVER01"] .remove-btn', node => ({
      disabled: node.disabled,
      text: node.textContent
    }))).resolves.toEqual({ disabled: false, text: 'Remove' });

    const storedItem = await page.evaluate(async () => {
      const { trackedItems } = await chrome.storage.local.get(['trackedItems']);
      return trackedItems.find(item => item.id === 'BRECOVER01');
    });
    expect(storedItem.isPriority).toBeUndefined();
    expect(storedItem.targetPrice).toBeUndefined();
  }, 30000);

  it('preserves a concurrent target edit during wishlist bulk sync', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    const result = await page.evaluate(async () => {
      const id = 'BCONCURRENT';
      await chrome.storage.local.set({
        trackedItems: [{
          id,
          title: 'Concurrent Item',
          url: 'https://www.amazon.nl/dp/BCONCURRENT',
          currentPrice: 10,
          currency: '€',
          inStock: true,
          addedAt: Date.now()
        }]
      });

      await Promise.all([
        chrome.runtime.sendMessage({
          type: 'BULK_ADD_TRACKED_ITEMS',
          items: [{ id, currentPrice: 9, currency: '€', inStock: true }]
        }),
        chrome.runtime.sendMessage({
          type: 'UPDATE_TRACKED_ITEM',
          item: { id, targetPrice: 7.5 }
        })
      ]);
      const { trackedItems } = await chrome.storage.local.get(['trackedItems']);
      return trackedItems.find(item => item.id === id);
    });

    expect(result.currentPrice).toBe(9);
    expect(result.targetPrice).toBe(7.5);
  }, 30000);

  it('serializes concurrent wishlist saves without losing either history sample', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    const result = await page.evaluate(async () => {
      await chrome.storage.local.set({ trackedItems: [], priceHistory: {} });
      const makeItem = (id, price) => ({
        id,
        title: `Concurrent ${id}`,
        url: `https://www.amazon.nl/dp/${id}`,
        currentPrice: price,
        currency: '€',
        inStock: true,
        wishlistIds: ['WLIST01']
      });

      const responses = await Promise.all([
        chrome.runtime.sendMessage({
          type: 'BULK_ADD_TRACKED_ITEMS',
          items: [makeItem('BBULK00001', 11.25)]
        }),
        chrome.runtime.sendMessage({
          type: 'BULK_ADD_TRACKED_ITEMS',
          items: [makeItem('BBULK00002', 22.50)]
        })
      ]);
      return {
        responses,
        storage: await chrome.storage.local.get(['trackedItems', 'priceHistory'])
      };
    });

    expect(result.responses).toEqual([{ success: true }, { success: true }]);
    expect(result.storage.trackedItems.map(item => item.id).sort()).toEqual(['BBULK00001', 'BBULK00002']);
    expect(result.storage.priceHistory.BBULK00001).toHaveLength(1);
    expect(result.storage.priceHistory.BBULK00001[0].price).toBe(11.25);
    expect(result.storage.priceHistory.BBULK00002).toHaveLength(1);
    expect(result.storage.priceHistory.BBULK00002[0].price).toBe(22.5);
  }, 30000);

  it('applies a queued history clear after an in-flight wishlist save', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: 'domcontentloaded'
    });

    const result = await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [],
        priceHistory: { OLD: [{ price: 99, timestamp: Date.now() - 1000 }] }
      });
      const bulkSave = chrome.runtime.sendMessage({
        type: 'BULK_ADD_TRACKED_ITEMS',
        items: [{
          id: 'BCLEAR0001',
          title: 'Clear Ordering Item',
          url: 'https://www.amazon.nl/dp/BCLEAR0001',
          currentPrice: 14.25,
          currency: '€',
          inStock: true
        }]
      });
      const clear = chrome.runtime.sendMessage({ type: 'CLEAR_PRICE_HISTORY' });
      const responses = await Promise.all([bulkSave, clear]);
      return {
        responses,
        storage: await chrome.storage.local.get(['trackedItems', 'priceHistory'])
      };
    });

    expect(result.responses).toEqual([{ success: true }, { success: true }]);
    expect(result.storage.trackedItems.some(item => item.id === 'BCLEAR0001')).toBe(true);
    expect(result.storage.priceHistory).toEqual({});
  }, 30000);

  it('keeps Clear Price History usable when the background rejects it', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate(() => {
      const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message, callback) => {
        if (message?.type === 'CLEAR_PRICE_HISTORY') {
          queueMicrotask(() => callback({ error: 'Synthetic clear failure' }));
          return undefined;
        }
        return originalSendMessage(message, callback);
      };
    });

    await page.click('#clear-history-btn');
    await page.click('#clear-history-btn');
    await page.waitForFunction(() => document.querySelector('#settings-status')?.textContent.includes('Could not clear price history'));
    await expect(page.$eval('#clear-history-btn', node => ({
      disabled: node.disabled,
      text: node.textContent
    }))).resolves.toEqual({ disabled: false, text: 'Clear Price History' });
  }, 30000);

  it('labels exports as non-restorable and uses the export filename', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: 'domcontentloaded'
    });

    await expect(page.$eval('.settings-card:last-child .settings-note', node => node.textContent)).resolves.toContain('cannot restore');
    expect(fs.readFileSync(path.join(EXTENSION_ROOT, 'src/options/options.js'), 'utf8')).toContain('amazon_tracker_export.json');
  }, 30000);

  it('keeps a paused legacy target visible on the dashboard until acknowledgement and recovers its warning after a settings read failure', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate(async () => {
      await chrome.storage.sync.set({ settings: { defaultTargetPrice: 12.5 } });
    });
    await page.waitForSelector('#legacy-target-warning:not([hidden])');
    await expect(page.$eval('#legacy-target-warning', node => node.textContent)).resolves.toContain('Old global target alerts are paused because their currency is unknown');
    await expect(page.$eval('#legacy-target-open-options-btn', node => node.textContent)).resolves.toBe('Open Extension Settings');

    const openOptionsCalls = await page.evaluate(() => {
      let calls = 0;
      chrome.runtime.openOptionsPage = () => {
        calls += 1;
        return Promise.resolve();
      };
      document.querySelector('#legacy-target-open-options-btn').click();
      return calls;
    });
    expect(openOptionsCalls).toBe(1);

    await page.evaluate(() => {
      window.__originalDashboardSyncGet = chrome.storage.sync.get.bind(chrome.storage.sync);
      Object.defineProperty(chrome.storage.sync, 'get', {
        configurable: true,
        value: () => Promise.reject(new Error('Synthetic dashboard settings failure'))
      });
      document.querySelector('#retry-dashboard-load').click();
    });
    await page.waitForSelector('#dashboard-recovery:not([hidden])');
    await expect(page.$eval('#legacy-target-warning', node => node.hidden)).resolves.toBe(true);

    await page.evaluate(() => {
      Object.defineProperty(chrome.storage.sync, 'get', {
        configurable: true,
        value: window.__originalDashboardSyncGet
      });
      delete window.__originalDashboardSyncGet;
    });
    await page.click('#retry-dashboard-load');
    await page.waitForSelector('#dashboard-recovery[hidden]');
    await page.waitForSelector('#legacy-target-warning:not([hidden])');

    // Options acknowledgement removes this key; the Dashboard listener must
    // hide the warning without making the user reload the page.
    await page.evaluate(async () => {
      await chrome.storage.sync.set({ settings: {} });
    });
    await page.waitForSelector('#legacy-target-warning[hidden]');
  }, 30000);

  it('preserves a legacy target until acknowledgement survives a failed sync write', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: 'domcontentloaded'
    });
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{ id: 'BLEGACY001', title: 'Legacy Euro item', currency: '€', currentPrice: 20 }]
      });
      await chrome.storage.sync.set({ settings: { defaultTargetPrice: 12.5 } });
      window.location.reload();
    });
    await page.waitForSelector('#legacy-target-migration:not([hidden])');
    await expect(page.$eval('#legacy-target-apply-btn', node => ({ hidden: node.hidden, text: node.textContent }))).resolves.toEqual({
      hidden: false,
      text: 'Apply €12.50 to 1 € product'
    });

    await page.evaluate(() => {
      const originalSet = chrome.storage.sync.set.bind(chrome.storage.sync);
      let failOnce = true;
      chrome.storage.sync.set = (values) => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('Synthetic sync write failure'));
        }
        return originalSet(values);
      };
    });
    await page.click('#legacy-target-dismiss-btn');
    await page.waitForFunction(() => document.querySelector('#settings-status')?.textContent.includes('Could not acknowledge'));
    await expect(page.$eval('#legacy-target-migration', node => node.hidden)).resolves.toBe(false);
    await expect(page.$eval('#legacy-target-dismiss-btn', node => node.disabled)).resolves.toBe(false);

    await page.click('#legacy-target-dismiss-btn');
    await page.waitForFunction(async () => {
      const { settings } = await chrome.storage.sync.get(['settings']);
      return settings && !Object.hasOwn(settings, 'defaultTargetPrice');
    });
    await expect(page.$eval('#legacy-target-migration', node => node.hidden)).resolves.toBe(true);
  }, 30000);

  it('copies a legacy target only after an explicit single-currency action', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: 'domcontentloaded'
    });
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{ id: 'BMIGRATE01', title: 'Euro item', currency: '€', currentPrice: 20 }]
      });
      await chrome.storage.sync.set({ settings: { defaultTargetPrice: 12.5 } });
      window.location.reload();
    });
    await page.waitForSelector('#legacy-target-apply-btn:not([hidden])');
    await page.click('#legacy-target-apply-btn');
    await page.waitForFunction(async () => {
      const [{ trackedItems }, { settings }] = await Promise.all([
        chrome.storage.local.get(['trackedItems']),
        chrome.storage.sync.get(['settings'])
      ]);
      return trackedItems?.[0]?.targetPrice === 12.5 &&
        Number.isFinite(trackedItems?.[0]?.nextPriceCheckAt) &&
        trackedItems?.[0]?.checkCadence === 'Legacy target migration · due now' &&
        !Object.hasOwn(settings || {}, 'defaultTargetPrice');
    });

    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [
          { id: 'BMIXED001', title: 'Euro item', currency: '€', currentPrice: 20 },
          { id: 'BMIXED002', title: 'Dollar item', currency: '$', currentPrice: 20 }
        ]
      });
      await chrome.storage.sync.set({ settings: { defaultTargetPrice: 10 } });
      window.location.reload();
    });
    await page.waitForSelector('#legacy-target-migration:not([hidden])');
    await expect(page.$eval('#legacy-target-apply-btn', node => node.hidden)).resolves.toBe(true);

    const directRejection = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        type: 'MIGRATE_LEGACY_TARGET_PRICE',
        targetPrice: 10,
        currency: '€',
        expectedCount: 1
      });
      const [{ trackedItems }, { settings }] = await Promise.all([
        chrome.storage.local.get(['trackedItems']),
        chrome.storage.sync.get(['settings'])
      ]);
      return { response, trackedItems, settings };
    });
    expect(directRejection.response.error).toBe('Legacy target can no longer be copied safely.');
    expect(directRejection.trackedItems.every(item => !Number.isFinite(item.targetPrice))).toBe(true);
    expect(directRejection.settings.defaultTargetPrice).toBe(10);

    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [
          { id: 'BUNKNOWN01', title: 'Known currency item', currency: '€', currentPrice: 20 },
          { id: 'BUNKNOWN02', title: 'Unknown currency item', currency: '', currentPrice: 20 }
        ]
      });
      await chrome.storage.sync.set({ settings: { defaultTargetPrice: 10 } });
      window.location.reload();
    });
    await page.waitForSelector('#legacy-target-migration:not([hidden])');
    await expect(page.$eval('#legacy-target-apply-btn', node => node.hidden)).resolves.toBe(true);
  }, 30000);

  it('shows a sanitized recovery state and retries after a dashboard storage read fails', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{ id: 'BRETRY0001', title: 'Retryable Item', currency: '€', currentPrice: 9.99, inStock: true, addedAt: Date.now() }]
      });
      window.location.reload();
    });
    await page.waitForSelector('.item-card[data-id="BRETRY0001"]');
    await page.evaluate(() => {
      window.__originalDashboardLocalGet = chrome.storage.local.get.bind(chrome.storage.local);
      Object.defineProperty(chrome.storage.local, 'get', {
        configurable: true,
        value: () => Promise.reject(new Error('Synthetic dashboard storage failure'))
      });
      document.querySelector('#retry-dashboard-load').click();
    });
    await page.waitForSelector('#dashboard-recovery:not([hidden])');
    await expect(page.$eval('#dashboard-recovery-message', node => node.textContent)).resolves.toContain('Dashboard data could not be loaded');
    await expect(page.$eval('#retry-dashboard-load', node => node.disabled)).resolves.toBe(false);
    await page.evaluate(() => {
      Object.defineProperty(chrome.storage.local, 'get', {
        configurable: true,
        value: window.__originalDashboardLocalGet
      });
      delete window.__originalDashboardLocalGet;
    });
    await page.click('#retry-dashboard-load');
    await page.waitForSelector('#dashboard-recovery[hidden]');
    await page.waitForSelector('.item-card[data-id="BRETRY0001"]');
  }, 30000);

  it('renders Amazon wishlist price-drop metadata on dashboard cards', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{
          id: 'B012345678',
          title: 'The Man Who Knew: The Life and Times of Alan Greenspan (English Edition)',
          url: 'https://www.amazon.nl/dp/B012345678',
          currentPrice: 10.99,
          originalPrice: 11.98,
          wishlistPriceDropPercent: 8,
          wishlistPriceWhenAdded: 11.98,
          wishlistPriceDropText: 'Price dropped 8% (was €11.98 when added to List)',
          currency: '€',
          inStock: true,
          lastChecked: Date.UTC(2026, 5, 10, 11, 30),
          addedAt: Date.now()
        }, {
          id: 'B000000002',
          title: 'Discounted Wishlist Item',
          url: 'https://www.amazon.nl/dp/B000000002',
          currentPrice: 12.25,
          wishlistPriceDropPercent: 2,
          wishlistPriceWhenAdded: 12.50,
          wishlistPriceDropAmount: 0.25,
          wishlistPriceDropText: 'Price dropped 2% (was €12.50 when added to List)',
          currency: '€',
          inStock: true,
          addedAt: Date.now() - 500
        }, {
          id: 'B000000001',
          title: 'Cobalt Red: How the Blood of the Congo Powers Our Lives',
          url: 'https://www.amazon.nl/dp/B000000001',
          currentPrice: 10.97,
          originalPrice: 10.97,
          currency: '€',
          inStock: true,
          addedAt: Date.now() - 1000
        }],
        priceHistory: {
          B012345678: [
            { price: 10.99, timestamp: Date.UTC(2026, 5, 9, 10, 0) },
            { price: 10.99, timestamp: Date.UTC(2026, 5, 10, 11, 30) }
          ]
        }
      });
      window.location.reload();
    });

    await page.waitForSelector('.discount-info', { visible: true });
    await expect(page.$eval('#next-checks-summary', (node) => node.textContent)).resolves.toContain('Next price batch');
    await expect(page.$eval('.item-card[data-id="B012345678"] .last-checked', (node) => node.textContent)).resolves.toContain('Last checked:');
    await expect(page.$eval('.discount-badge', (node) => node.textContent.trim())).resolves.toBe('Price dropped 8% / €0.99');
    await expect(page.$eval('.discount-info', (node) => node.textContent)).resolves.toContain('was €11.98 when added to List');
    await expect(page.$eval('.item-card[data-id="B000000002"] .discount-badge', (node) => node.textContent.trim())).resolves.toBe('Price dropped 2% / €0.25');
    await expect(page.$eval('.item-card[data-id="B000000002"] .discount-info', (node) => node.textContent)).resolves.toContain('was €12.50 when added to List');

    await page.click('.item-card[data-id="B012345678"] .chart-btn');
    await page.waitForSelector('.item-card[data-id="B012345678"] .chart-meta span');
    await expect(page.$eval('.item-card[data-id="B012345678"] .chart-meta', (node) => node.textContent)).resolves.toContain('Latest €10.99');
    await expect(page.$eval('.item-card[data-id="B012345678"] .chart-meta', (node) => node.textContent)).resolves.toContain('2 fetches');
    await expect(page.$$eval('.item-card[data-id="B012345678"] .chart-sample', (rows) => rows.map(row => row.textContent))).resolves.toHaveLength(2);
    await expect(page.$eval('.item-card[data-id="B012345678"] .chart-samples', (node) => node.textContent)).resolves.toContain('€10.99');

    await page.type('#item-search-input', 'cobalt');
    await page.waitForFunction(() => document.querySelector('#main-title')?.textContent?.trim() === 'Tracked Items (1 of 3)');
    await expect(page.$$eval('.item-card', (cards) => cards.map(card => card.textContent))).resolves.toHaveLength(1);
    await expect(page.$eval('.item-card .item-title', (node) => node.textContent)).resolves.toContain('Cobalt Red');
    await expect(page.$eval('#main-title', (node) => node.textContent.trim())).resolves.toBe('Tracked Items (1 of 3)');
  }, 30000);

  it('records lastChecked and appends price history during manual wishlist sync', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    const beforeSync = Date.now();
    const result = await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{
          id: 'B012345678',
          title: 'Existing Wishlist Item',
          url: 'https://www.amazon.nl/dp/B012345678',
          currentPrice: 12.49,
          originalPrice: 12.49,
          currency: '€',
          inStock: true,
          lastChecked: Date.UTC(2026, 5, 1, 8, 0),
          addedAt: Date.UTC(2026, 5, 1, 8, 0)
        }],
        priceHistory: {
          B012345678: [
            { price: 12.49, timestamp: Date.UTC(2026, 5, 1, 8, 0) }
          ]
        }
      });

      await chrome.runtime.sendMessage({
        type: 'BULK_ADD_TRACKED_ITEMS',
        items: [{
          id: 'B012345678',
          title: 'Existing Wishlist Item',
          url: 'https://www.amazon.nl/dp/B012345678',
          currentPrice: 10.99,
          originalPrice: 12.49,
          currency: '€',
          inStock: true
        }]
      });

      return chrome.storage.local.get(['trackedItems', 'priceHistory']);
    });

    const syncedItem = result.trackedItems.find((item) => item.id === 'B012345678');
    expect(syncedItem.currentPrice).toBe(10.99);
    expect(syncedItem.lastChecked).toBeGreaterThanOrEqual(beforeSync);
    expect(result.priceHistory.B012345678).toHaveLength(2);
    expect(result.priceHistory.B012345678[1].price).toBe(10.99);
    expect(result.priceHistory.B012345678[1].timestamp).toBe(syncedItem.lastChecked);
  }, 30000);
});
