const path = require('path');
const fs = require('fs');
const os = require('os');

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
  let temporaryProfiles;

  async function launchExtension(options = {}) {
    const { default: puppeteer } = await import('puppeteer');

    browser = await puppeteer.launch({
      headless: 'new',
      ...options,
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
    for (const profile of temporaryProfiles || []) {
      fs.rmSync(profile, { recursive: true, force: true });
    }
    temporaryProfiles = [];
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
    await expect(page.$eval('#next-checks-summary', node => node.textContent)).resolves.toContain('75 products due now');
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

  it('preserves a concurrent target edit during wishlist bulk sync', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    const result = await page.evaluate(async () => {
      const id = 'BCONCURR01';
      await chrome.storage.local.set({
        trackedItems: [{
          id,
          title: 'Concurrent Item',
          url: `https://www.amazon.nl/dp/${id}`,
          currentPrice: 10,
          currency: '€',
          inStock: true,
          addedAt: Date.now()
        }]
      });

      const responses = await Promise.all([
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
      return { item: trackedItems.find(item => item.id === id), responses };
    });

    expect(result.responses).toEqual([{ success: true }, { success: true }]);
    expect(result.item.currentPrice).toBe(9);
    expect(result.item.targetPrice).toBe(7.5);
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
    await expect(page.$eval('#next-checks-summary', (node) => node.textContent)).resolves.toContain('3 products due now');
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

  it('restores the one-shot wishlist continuation alarm when persisted pagination state exists', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-wishlist-e2e-'));
    temporaryProfiles = [profile];
    await launchExtension({ userDataDir: profile });

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    const beforeRestart = Date.now();
    await page.evaluate(async () => {
      await chrome.alarms.clear('continueWishlistSyncAlarm');
      await chrome.storage.local.set({
        wishlistScrapeState: {
          LIST123: {
            nextPageUrl: 'https://www.amazon.com/hz/wishlist/ls/LIST123?page=9',
            items: [],
            startedAt: Date.now()
          }
        }
      });
    });

    await browser.close();
    browser = null;
    await launchExtension({ userDataDir: profile });
    const probe = await browser.newPage();
    await probe.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });
    await probe.waitForFunction(async () => Boolean(await chrome.alarms.get('continueWishlistSyncAlarm')));

    const continuation = await probe.evaluate(() => chrome.alarms.get('continueWishlistSyncAlarm'));
    expect(continuation.periodInMinutes).toBeUndefined();
    expect(continuation.scheduledTime).toBeGreaterThanOrEqual(beforeRestart + 50000);
  }, 30000);

  it('keeps a 784-item dashboard bounded, responsive, lazy, persistent, and keyboard-addressable', async () => {
    await launchExtension();

    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 1 });
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate(async () => {
      const now = Date.now();
      await chrome.storage.local.set({
        trackedItems: Array.from({ length: 784 }, (_, index) => ({
          id: `S${String(index).padStart(9, '0')}`,
          title: `Scale Product ${index + 1} with a deliberately long product title`,
          currentPrice: 10 + (index % 90),
          currency: index % 2 ? '€' : '$',
          inStock: index % 11 !== 0,
          isPriority: index % 9 === 0,
          addedAt: now - index
        })),
        priceHistory: {}
      });
      window.location.reload();
    });

    await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 50);
    await expect(page.$eval('.list-pagination', (node) => node.textContent)).resolves.toContain('Showing 50 of 784');
    await expect(page.$$eval('.chart-meta', (nodes) => nodes.every((node) => node.childElementCount === 0))).resolves.toBe(true);

    const layout = await page.evaluate(() => ({
      documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      listFits: document.getElementById('item-list').scrollWidth <= document.getElementById('item-list').clientWidth
    }));
    expect(layout).toEqual({ documentFits: true, listFits: true });

    await page.evaluate(() => {
      const list = document.getElementById('item-list');
      list.scrollTop = 400;
      document.querySelector('.list-pagination button').click();
    });
    await page.waitForFunction(() => document.querySelectorAll('.item-card').length === 100);
    await page.waitForFunction(() => Math.abs(document.getElementById('item-list').scrollTop - 400) <= 2);

    await page.select('#filter-select', 'priority');
    await page.waitForFunction(async () => {
      const { settings } = await chrome.storage.sync.get(['settings']);
      return settings?.dashboardFilter === 'priority';
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.item-card');
    await expect(page.$eval('#filter-select', (node) => node.value)).resolves.toBe('priority');
    await expect(page.$$eval('.priority-btn', (nodes) => nodes.every((node) => node.classList.contains('active')))).resolves.toBe(true);

    const firstCard = '.item-card:first-of-type';
    await expect(page.$eval(`${firstCard} .priority-btn`, (node) => node.getAttribute('aria-pressed'))).resolves.toBe('true');
    await expect(page.$eval(`${firstCard} .chart-btn`, (node) => node.getAttribute('aria-expanded'))).resolves.toBe('false');
    await page.click(`${firstCard} .chart-btn`);
    await expect(page.$eval(`${firstCard} .chart-btn`, (node) => node.getAttribute('aria-expanded'))).resolves.toBe('true');

    await page.click(`${firstCard} .edit-btn`);
    await expect(page.evaluate(() => document.activeElement?.classList.contains('target-editor-input'))).resolves.toBe(true);

    const unnamedControls = await page.evaluate(() => Array.from(document.querySelectorAll('button, a, input, select'))
      .filter((node) => node.getClientRects().length > 0 && !node.disabled)
      .filter((node) => {
        const label = node.labels?.[0]?.textContent || '';
        return !(node.getAttribute('aria-label') || node.textContent?.trim() || node.title || label.trim());
      })
      .map((node) => `${node.tagName.toLowerCase()}#${node.id}.${node.className}`));
    expect(unnamedControls).toEqual([]);
    expect(pageErrors).toEqual([]);
  }, 30000);

  it('keeps dashboard content reachable in a short viewport equivalent to 200% zoom', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 450, deviceScaleFactor: 2 });
    await page.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    });
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{
          id: 'B000000001',
          title: 'Zoom-safe product',
          currentPrice: 10,
          currency: '€',
          inStock: true,
          addedAt: Date.now()
        }]
      });
      window.location.reload();
    });
    await page.waitForSelector('.item-card');

    const initialLayout = await page.evaluate(() => ({
      documentFitsWidth: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      canScrollPage: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      listTop: document.getElementById('item-list').getBoundingClientRect().top,
      viewportHeight: window.innerHeight
    }));
    expect(initialLayout.documentFitsWidth).toBe(true);
    expect(initialLayout.canScrollPage).toBe(true);
    expect(initialLayout.listTop).toBeGreaterThan(initialLayout.viewportHeight);

    const reachable = await page.evaluate(() => {
      const card = document.querySelector('.item-card');
      card.scrollIntoView({ block: 'center' });
      const cardRect = card.getBoundingClientRect();
      const cardVisible = cardRect.bottom > 0 && cardRect.top < window.innerHeight;

      const footer = document.querySelector('.app-footer');
      footer.scrollIntoView({ block: 'end' });
      const footerRect = footer.getBoundingClientRect();
      const footerVisible = footerRect.bottom > 0 && footerRect.top < window.innerHeight;
      return { cardVisible, footerVisible };
    });
    expect(reachable).toEqual({ cardVisible: true, footerVisible: true });
  }, 30000);

  it('validates options, persists retention, and exports tracked data with history', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: 'domcontentloaded'
    });
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{ id: 'B000000001', title: 'Export me', currentPrice: 12.5, currency: '€' }],
        priceHistory: { B000000001: [{ price: 12.5, timestamp: 123 }] }
      });
      window.__savedSignalDownload = null;
      HTMLAnchorElement.prototype.click = function captureDownload() {
        window.__savedSignalDownload = { href: this.href, download: this.download };
      };
    });

    await page.$eval('#default-discount', (input) => {
      input.value = '0';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.$eval('#default-discount', (input) => input.getAttribute('aria-invalid'))).resolves.toBe('true');
    await expect(page.$eval('#settings-status', (node) => node.textContent)).resolves.toBe('Enter a discount from 1 to 99.');

    await page.$eval('#default-discount', (input) => {
      input.value = '20';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.select('#history-retention', '90');
    await page.waitForFunction(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      return settings?.defaultDiscount === 20 && settings?.historyRetentionDays === '90';
    });

    await page.click('#export-btn');
    await page.waitForFunction(() => Boolean(window.__savedSignalDownload));
    const exported = await page.evaluate(() => {
      const { href, download } = window.__savedSignalDownload;
      const payload = JSON.parse(decodeURIComponent(href.slice(href.indexOf(',') + 1)));
      return { download, payload };
    });
    expect(exported.download).toBe('saved_signal_backup.json');
    expect(exported.payload.items).toEqual([
      expect.objectContaining({ id: 'B000000001', title: 'Export me', currentPrice: 12.5 })
    ]);
    expect(exported.payload.history.B000000001).toEqual([{ price: 12.5, timestamp: 123 }]);
    expect(Number.isNaN(Date.parse(exported.payload.exportedAt))).toBe(false);
  }, 30000);

  it('requires an expiring keyboard confirmation before clearing history and preserves tracked items', async () => {
    await launchExtension();

    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{ id: 'B000000001', title: 'Keep me', currentPrice: 10 }],
        priceHistory: { B000000001: [{ price: 10, timestamp: Date.now() }] }
      });
    });

    await page.focus('#clear-history-btn');
    await page.keyboard.press('Enter');
    await expect(page.$eval('#clear-history-btn', (node) => node.textContent)).resolves.toBe('Confirm Clear History');
    await expect(page.evaluate(async () => (await chrome.storage.local.get('priceHistory')).priceHistory.B000000001.length)).resolves.toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 4100));
    await expect(page.$eval('#clear-history-btn', (node) => node.textContent)).resolves.toBe('Clear Price History');
    await expect(page.evaluate(async () => (await chrome.storage.local.get('priceHistory')).priceHistory.B000000001.length)).resolves.toBe(1);

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.waitForFunction(async () => {
      const { priceHistory } = await chrome.storage.local.get('priceHistory');
      return priceHistory && Object.keys(priceHistory).length === 0;
    });
    const remainingItems = await page.evaluate(async () => (await chrome.storage.local.get('trackedItems')).trackedItems);
    expect(remainingItems).toHaveLength(1);
    await expect(page.$eval('#settings-status', (node) => node.textContent)).resolves.toBe('Price history cleared. Price tracking continues.');
    expect(pageErrors).toEqual([]);
  }, 30000);

  it('keeps the popup bounded with three accessible highlights', async () => {
    await launchExtension();

    const page = await browser.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
      waitUntil: 'domcontentloaded'
    });
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: Array.from({ length: 6 }, (_, index) => ({
          id: `P${String(index).padStart(9, '0')}`,
          title: `Popup Product ${index + 1}`,
          currentPrice: 10 + index,
          currency: '$',
          inStock: true,
          addedAt: Date.now() - index
        }))
      });
      window.location.reload();
    });

    await page.waitForFunction(() => document.querySelectorAll('.recent-item').length === 3);
    const popup = await page.evaluate(() => ({
      width: document.body.scrollWidth,
      height: document.body.scrollHeight,
      overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      unnamedButtons: Array.from(document.querySelectorAll('button'))
        .filter((node) => node.getClientRects().length > 0)
        .filter((node) => !(node.getAttribute('aria-label') || node.textContent?.trim() || node.title))
        .length
    }));
    expect(popup.width).toBeLessThanOrEqual(400);
    expect(popup.height).toBeLessThanOrEqual(600);
    expect(popup.overflows).toBe(false);
    expect(popup.unnamedButtons).toBe(0);
  }, 30000);
});
