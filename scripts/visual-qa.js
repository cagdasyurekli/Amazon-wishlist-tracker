const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'artifacts', 'visual-qa');

async function getExtensionId(browser) {
  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
    { timeout: 10000 }
  );
  return new URL(workerTarget.url()).host;
}

async function main() {
  const { default: puppeteer } = await import('puppeteer');
  fs.mkdirSync(outputDir, { recursive: true });
  const consoleErrors = [];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--disable-extensions-except=${projectRoot}`,
      `--load-extension=${projectRoot}`,
      '--no-sandbox'
    ]
  });

  try {
    const extensionId = await getExtensionId(browser);
    const dashboard = await browser.newPage();
    const recordConsoleError = (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    };
    dashboard.on('console', recordConsoleError);
    dashboard.on('pageerror', (error) => consoleErrors.push(error.message));
    await dashboard.setViewport({ width: 1280, height: 800 });
    await dashboard.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, { waitUntil: 'domcontentloaded' });

    // Synthetic extension storage only: never open an Amazon URL or run a scrape.
    await dashboard.evaluate(async () => {
      await chrome.storage.local.set({
        trackedItems: [{
          id: 'BVISUAL001',
          title: 'Synthetic wishlist item',
          url: 'https://www.amazon.example.invalid/dp/BVISUAL001',
          currentPrice: 19.99,
          originalPrice: 24.99,
          currency: '€',
          inStock: true,
          wishlistPriceDropPercent: 20,
          wishlistPriceWhenAdded: 24.99,
          trackingStartPrice: 24.99,
          trackingStartedAt: Date.now() - 86400000,
          trackingBaselineExact: true,
          addedAt: Date.now(),
          lastChecked: Date.now()
        }],
        priceHistory: { BVISUAL001: [{ price: 24.99, timestamp: Date.now() - 86400000 }, { price: 19.99, timestamp: Date.now() }] }
      });
      await chrome.storage.sync.set({ settings: { defaultDiscount: 20, defaultTargetPrice: 15 } });
    });
    await dashboard.reload({ waitUntil: 'domcontentloaded' });
    await dashboard.waitForSelector('.item-card[data-id="BVISUAL001"]');
    await dashboard.screenshot({ path: path.join(outputDir, 'dashboard.png'), fullPage: true });

    const popup = await browser.newPage();
    popup.on('console', recordConsoleError);
    popup.on('pageerror', (error) => consoleErrors.push(error.message));
    await popup.setViewport({ width: 420, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.waitForSelector('.app-container');
    await popup.screenshot({ path: path.join(outputDir, 'popup.png'), fullPage: true });

    const options = await browser.newPage();
    options.on('console', recordConsoleError);
    options.on('pageerror', (error) => consoleErrors.push(error.message));
    await options.setViewport({ width: 900, height: 900 });
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
    await options.waitForSelector('.options-container');
    await options.screenshot({ path: path.join(outputDir, 'options.png'), fullPage: true });

    // Capture the resolved upgrade state too. This exercises the same storage
    // transition as acknowledgement without relying on a real legacy profile.
    await options.evaluate(async () => {
      await chrome.storage.sync.set({ settings: { defaultDiscount: 20 } });
    });
    await options.reload({ waitUntil: 'domcontentloaded' });
    await options.waitForSelector('#legacy-target-migration[hidden]');
    await options.screenshot({ path: path.join(outputDir, 'options-resolved.png'), fullPage: true });

    const dashboardResolved = await browser.newPage();
    dashboardResolved.on('console', recordConsoleError);
    dashboardResolved.on('pageerror', (error) => consoleErrors.push(error.message));
    await dashboardResolved.setViewport({ width: 1280, height: 800 });
    await dashboardResolved.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, { waitUntil: 'domcontentloaded' });
    await dashboardResolved.waitForSelector('#legacy-target-warning[hidden]');
    await dashboardResolved.waitForSelector('.item-card[data-id="BVISUAL001"]');
    await dashboardResolved.screenshot({ path: path.join(outputDir, 'dashboard-resolved.png'), fullPage: true });

    if (consoleErrors.length) {
      throw new Error(`Visual QA captured console errors: ${consoleErrors.join(' | ')}`);
    }
    console.log(`Visual QA passed: popup.png, dashboard.png, options.png, dashboard-resolved.png, options-resolved.png in ${path.relative(projectRoot, outputDir)}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
