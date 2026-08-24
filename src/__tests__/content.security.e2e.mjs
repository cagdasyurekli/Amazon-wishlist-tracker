import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let browser;

function within(promise, label, timeout = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout))
  ]);
}

afterEach(async () => {
  if (browser) {
    const process = browser.process();
    await Promise.race([
      browser.close(),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
    if (process && process.exitCode == null) process.kill('SIGKILL');
  }
  browser = null;
});

describe('real Chrome content-script user-intent boundary', () => {
  it('rejects page-script activation and accepts one genuine click on a valid product', { timeout: 45000 }, async () => {
    browser = await within(puppeteer.launch({
      headless: 'new',
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        '--no-sandbox'
      ]
    }), 'launch Chrome');
    const workerTarget = await within(browser.waitForTarget(
      (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
      { timeout: 10000 }
    ), 'find extension worker');
    const extensionId = new URL(workerTarget.url()).host;

    const productPage = await browser.newPage();
    await productPage.setRequestInterception(true);
    productPage.on('request', (request) => {
      if (request.isNavigationRequest()) {
        request.respond({
          status: 200,
          contentType: 'text/html',
          body: `<!doctype html><html><head><title>Test product</title></head><body>
            <h1 id="productTitle">Test product</h1>
            <div class="a-price"><span class="a-offscreen">$19.99</span></div>
            <div id="buybox"></div>
          </body></html>`
        });
      } else {
        request.abort();
      }
    });
    await within(productPage.goto('https://www.amazon.com/dp/B000000001', { waitUntil: 'domcontentloaded' }), 'load product page');
    await within(productPage.waitForSelector('#amz-tracker-control'), 'find closed-shadow control');

    const exposedState = await productPage.$eval('#amz-tracker-control', (host) => ({
      shadowRoot: host.shadowRoot,
      text: host.textContent
    }));
    assert.equal(exposedState.shadowRoot, null);
    assert.equal(exposedState.text, '');

    const inspector = await browser.newPage();
    await within(inspector.goto(`chrome-extension://${extensionId}/src/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded'
    }), 'load inspector');
    await within(inspector.evaluate(() => chrome.storage.local.set({ trackedItems: [] })), 'clear tracked items');

    await within(productPage.$eval('#amz-tracker-control', (host) => host.click()), 'dispatch synthetic click');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await inspector.evaluate(async () => {
      const { trackedItems } = await chrome.storage.local.get('trackedItems');
      return trackedItems.length;
    }), 0);

    // Puppeteer's mouse event is a real trusted browser input event. Hit
    // testing reaches the button inside the closed shadow root.
    const control = await productPage.$('#amz-tracker-control');
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0, 'closed-shadow control must be visible');
    await within(productPage.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    ), 'dispatch genuine click');
    await within(inspector.waitForFunction(async () => {
      const { trackedItems } = await chrome.storage.local.get('trackedItems');
      return trackedItems?.length === 1;
    }, { timeout: 10000 }), 'observe stored item');
    const stored = await inspector.evaluate(async () => {
      const { trackedItems } = await chrome.storage.local.get('trackedItems');
      return trackedItems[0];
    });
    assert.equal(stored.id, 'B000000001');
    assert.equal(stored.url, 'https://www.amazon.com/dp/B000000001');
  });
});
