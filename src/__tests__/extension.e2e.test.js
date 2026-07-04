const path = require('path');

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
