import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const amazonSource = await readFile(new URL('../utils/amazon.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
const amazonModuleUrl = `data:text/javascript;base64,${Buffer.from(amazonSource).toString('base64')}`;
const amazon = await import(amazonModuleUrl);
const scraperSource = (await readFile(new URL('../background/scraper.js', import.meta.url), 'utf8'))
  .replace('../utils/amazon.js', amazonModuleUrl);
const scraper = await import(`data:text/javascript;base64,${Buffer.from(scraperSource).toString('base64')}`);

const require = createRequire(import.meta.url);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'chrome-extension://test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.chrome = {
  runtime: { onMessage: { addListener() {} } }
};
require('../utils/availability.js');
const offscreen = require('../background/offscreen.js');

const originals = {
  chrome: globalThis.chrome,
  fetch: globalThis.fetch,
  consoleError: console.error
};

function htmlResponse(html, url = 'https://www.amazon.com/dp/B000000001', headers = {}) {
  const encoded = new TextEncoder().encode(html);
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(encoded.byteLength),
      ...headers
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      }
    })
  };
}

beforeEach(() => {
  globalThis.chrome = {
    offscreen: {
      hasDocument: async () => false,
      createDocument: async () => {},
      closeDocument: async () => {}
    },
    runtime: {
      sendMessage: async (message) => message.type === 'PARSE_AMAZON_WISHLIST'
        ? { data: { items: [], nextPageUrl: null, completeness: 'validated' } }
        : { data: { success: true, title: 'Legitimate product' } }
    }
  };
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = originals.fetch;
  globalThis.chrome = originals.chrome;
  console.error = originals.consoleError;
});

describe('canonical Amazon URL and image policy', () => {
  it('migrates legacy wishlist regions only from one trustworthy origin or an observed URL', () => {
    const source = ['LIST_1-ABC', 'AMBIG_LIST'];
    const items = [
      { id: 'B000000001', url: 'http://www.amazon.de/dp/B000000001', wishlistIds: ['LIST_1-ABC', 'AMBIG_LIST'] },
      { id: 'B000000002', url: 'https://www.amazon.fr/dp/B000000002', wishlistIds: ['AMBIG_LIST'] }
    ];
    const migrated = amazon.migrateLegacyWishlistRecords(source, items);

    assert.deepEqual(migrated, [
      { id: 'LIST_1-ABC', url: 'https://www.amazon.de/hz/wishlist/ls/LIST_1-ABC', autoSync: false },
      { id: 'AMBIG_LIST', url: null, autoSync: false, needsRegionReview: true }
    ]);
    assert.deepEqual(source, ['LIST_1-ABC', 'AMBIG_LIST']);

    assert.deepEqual(
      amazon.migrateLegacyWishlistRecords(migrated, items, 'https://www.amazon.fr/hz/wishlist/ls/AMBIG_LIST')[1],
      { id: 'AMBIG_LIST', url: 'https://www.amazon.fr/hz/wishlist/ls/AMBIG_LIST', autoSync: false }
    );
  });

  it('accepts supported HTTPS URLs and rejects scheme, authority, port and lookalike variants', () => {
    for (const domain of ['amazon.com', 'amazon.nl', 'amazon.de', 'amazon.fr', 'amazon.es', 'amazon.it', 'amazon.co.uk']) {
      assert.ok(amazon.parseCanonicalAmazonUrl(`https://www.${domain}/dp/B000000001`));
      assert.ok(amazon.parseCanonicalAmazonProductUrl(`https://www.${domain}/gp/product/B000000001?ref_=test`));
      assert.ok(amazon.parseCanonicalAmazonWishlistUrl(`https://www.${domain}/hz/wishlist/ls/LIST_1-ABC?viewType=list`));
    }
    for (const value of [
      'http://www.amazon.com/dp/B000000001',
      'https://amazon.com.evil.test/dp/B000000001',
      'https://user:pass@amazon.com/dp/B000000001',
      'https://amazon.com:444/dp/B000000001',
      'javascript://amazon.com/dp/B000000001',
      'https://amazon.com./dp/B000000001'
    ]) {
      assert.equal(amazon.parseCanonicalAmazonUrl(value), null, value);
    }
  });

  it('declares HTTPS-only Amazon host and content-script match patterns', () => {
    const patterns = [
      ...(manifest.host_permissions || []),
      ...(manifest.content_scripts || []).flatMap((entry) => entry.matches || [])
    ];
    assert.ok(patterns.length > 0);
    assert.ok(patterns.every((pattern) => pattern.startsWith('https://*.amazon.')));
    assert.equal(patterns.some((pattern) => pattern.startsWith('*://') || pattern.startsWith('http://')), false);
  });

  it('upgrades only identity-matched legacy HTTP product links before navigation', () => {
    assert.equal(
      amazon.normalizeStoredAmazonProductUrl('http://www.amazon.de/gp/product/B000000001?legacy=1', 'B000000001'),
      'https://www.amazon.de/dp/B000000001'
    );
    assert.equal(amazon.normalizeStoredAmazonProductUrl('http://evil.test/dp/B000000001', 'B000000001'), null);
    assert.equal(amazon.normalizeStoredAmazonProductUrl('https://www.amazon.com/dp/B000000002', 'B000000001'), null);
    assert.equal(amazon.normalizeStoredAmazonProductUrl('https://user:pass@amazon.com/dp/B000000001', 'B000000001'), null);
  });

  it('allows only approved HTTPS Amazon image CDN paths', () => {
    for (const host of [
      'm.media-amazon.com',
      'images.amazon.com',
      'ecx.images-amazon.com',
      'images-na.ssl-images-amazon.com',
      'images-eu.ssl-images-amazon.com',
      'images-fe.ssl-images-amazon.com',
      'images-cn.ssl-images-amazon.com',
      'images-jp.amazon.com'
    ]) {
      assert.equal(
        amazon.sanitizeAmazonImageUrl(`https://${host}/images/I/book.jpg`),
        `https://${host}/images/I/book.jpg`
      );
    }
    for (const value of [
      'http://m.media-amazon.com/images/I/book.jpg',
      'https://127.0.0.1/images/I/book.jpg',
      'https://m.media-amazon.com.evil.test/images/I/book.jpg',
      'data:image/png;base64,AAAA',
      'https://m.media-amazon.com/other/book.jpg'
    ]) {
      assert.equal(amazon.sanitizeAmazonImageUrl(value), '', value);
    }
  });
});

describe('inert parser controls and typed wishlist completeness', () => {
  it('does not classify freeform listing phrases as a verified CAPTCHA', () => {
    const data = offscreen.parseAmazonHtml(`
      <html><body><span id="productTitle">Type the characters you see — puzzle book</span></body></html>
    `, 'https://www.amazon.com/dp/B000000001');
    assert.equal(data.success, true);
    const repeatedSellerContent = offscreen.parseAmazonHtml(`
      <html><body>
        <span id="productTitle">Captcha puzzle: type the characters you see</span>
        <img alt="Captcha puzzle: type the characters you see"
             src="https://m.media-amazon.com/images/I/book.jpg">
      </body></html>
    `, 'https://www.amazon.com/dp/B000000001');
    assert.equal(repeatedSellerContent.success, true);
  });

  it('requires structural and semantic CAPTCHA signals', () => {
    assert.throws(() => offscreen.parseAmazonHtml(`
      <html><head><title>Robot Check</title></head><body>
        <form action="/errors/validateCaptcha">
          <label for="captchacharacters">Type the characters you see</label>
          <input id="captchacharacters">
        </form>
      </body></html>
    `, 'https://www.amazon.com/dp/B000000001'), /CAPTCHA_BLOCKED/);
  });

  it('neutralizes fetching markup and retains only allowlisted image data', () => {
    const parsed = offscreen.parseInertHtml(`
      <base href="https://evil.test/">
      <iframe src="http://127.0.0.1/admin"></iframe>
      <img id="bad" src="http://127.0.0.1/images/I/bad.jpg">
      <img id="good" src="https://m.media-amazon.com/images/I/good.jpg">
    `, 'https://www.amazon.com/hz/wishlist/ls/LIST1');
    assert.equal(parsed.root.querySelector('base, iframe'), null);
    assert.equal(parsed.root.querySelector('#bad').hasAttribute('src'), false);
    assert.equal(parsed.root.querySelector('#bad').dataset.safeImageUrl, undefined);
    assert.equal(parsed.root.querySelector('#good').dataset.safeImageUrl, 'https://m.media-amazon.com/images/I/good.jpg');
  });

  it('marks generic successful HTML indeterminate and validates an identified empty list', () => {
    const generic = offscreen.parseAmazonWishlist(
      '<html><body><h1>Sign in to continue</h1></body></html>',
      'https://www.amazon.com/hz/wishlist/ls/LIST1'
    );
    assert.equal(generic.completeness, 'indeterminate');

    const empty = offscreen.parseAmazonWishlist(`
      <html><body><input id="listId" value="LIST1"><div id="g-items"></div></body></html>
    `, 'https://www.amazon.com/hz/wishlist/ls/LIST1');
    assert.equal(empty.completeness, 'validated');
    assert.deepEqual(empty.items, []);
  });

  it('does not treat identity-less non-empty rows as complete', () => {
    const unbound = offscreen.parseAmazonWishlist(`
      <html><body><div id="g-items">
        <li data-itemid="ITEM1"><a href="/dp/B000000001">Unbound product</a></li>
      </div></body></html>
    `, 'https://www.amazon.com/hz/wishlist/ls/LIST1');
    assert.equal(unbound.items.length, 1);
    assert.equal(unbound.completeness, 'indeterminate');

    const canonical = offscreen.parseAmazonWishlist(`
      <html><head><link rel="canonical" href="https://www.amazon.com/hz/wishlist/ls/LIST1"></head>
      <body><div id="g-items">
        <li data-itemid="ITEM1"><a href="/dp/B000000001">Bound product</a></li>
      </div></body></html>
    `, 'https://www.amazon.com/hz/wishlist/ls/LIST1');
    assert.equal(canonical.completeness, 'validated');
  });

  it('parses realistic regional Amazon wishlist rows with lazy CDN images', () => {
    for (const domain of ['amazon.com', 'amazon.nl', 'amazon.de', 'amazon.fr', 'amazon.es', 'amazon.it', 'amazon.co.uk']) {
      const data = offscreen.parseAmazonWishlist(`
        <html><body>
          <input name="listId" value="LIST1">
          <div id="g-items">
            <li data-itemid="ITEM1">
              <a id="itemName_B000000001" href="/dp/B000000001">Regional Product</a>
              <span class="a-price"><span class="a-offscreen">€19,95</span></span>
              <img data-src="https://images-eu.ssl-images-amazon.com/images/I/book.jpg">
            </li>
          </div>
        </body></html>
      `, `https://www.${domain}/hz/wishlist/ls/LIST1`);
      assert.equal(data.completeness, 'validated');
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].url, `https://www.${domain}/dp/B000000001`);
      assert.equal(data.items[0].imageUrl, 'https://images-eu.ssl-images-amazon.com/images/I/book.jpg');
    }
  });

  it('rejects a mismatched list identity and unsafe pagination hop', () => {
    assert.throws(() => offscreen.parseAmazonWishlist(`
      <input id="listId" value="OTHER"><div id="g-items"></div>
    `, 'https://www.amazon.com/hz/wishlist/ls/LIST1'), /WISHLIST_ID_MISMATCH/);
    assert.throws(() => offscreen.parseAmazonWishlist(`
      <input id="listId" value="LIST1"><div id="g-items"></div>
      <a class="wl-see-more" href="http://www.amazon.com/hz/wishlist/ls/LIST1?page=2">More</a>
    `, 'https://www.amazon.com/hz/wishlist/ls/LIST1'), /INVALID_AMAZON_URL/);
  });
});

describe('bounded scraper response pipeline', () => {
  it('rejects HTTP, cross-origin redirects, and same-host redirects to another ASIN', async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return htmlResponse('<html></html>', 'https://evil.test/dp/B000000001');
    };
    assert.equal((await scraper.scrapeAmazonProduct('http://www.amazon.com/dp/B000000001')).error, 'INVALID_AMAZON_URL');
    assert.equal(fetchCount, 0);
    assert.equal((await scraper.scrapeAmazonProduct('https://www.amazon.com/dp/B000000001')).error, 'INVALID_AMAZON_REDIRECT');
    globalThis.fetch = async () => htmlResponse('<html></html>', 'https://www.amazon.com/dp/B000000002');
    assert.equal((await scraper.scrapeAmazonProduct('https://www.amazon.com/dp/B000000001')).error, 'INVALID_AMAZON_REDIRECT');
  });

  it('rejects non-HTML and oversized declared responses before parsing', async () => {
    let parseCount = 0;
    globalThis.chrome.runtime.sendMessage = async () => {
      parseCount += 1;
      return { data: {} };
    };
    globalThis.fetch = async () => htmlResponse('alert(1)', undefined, { 'content-type': 'application/javascript' });
    assert.equal((await scraper.scrapeAmazonProduct('https://www.amazon.com/dp/B000000001')).error, 'UNEXPECTED_CONTENT_TYPE');
    globalThis.fetch = async () => htmlResponse('<html></html>', undefined, { 'content-length': String(9 * 1024 * 1024) });
    assert.equal((await scraper.scrapeAmazonProduct('https://www.amazon.com/dp/B000000001')).error, 'RESPONSE_TOO_LARGE');
    assert.equal(parseCount, 0);
  });

  it('enforces the streaming byte counter when Content-Length is absent', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'text/html' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('123456'));
          controller.close();
        }
      })
    };
    await assert.rejects(() => scraper.readBoundedHtml(response, 5), /RESPONSE_TOO_LARGE/);
  });

  it('never reports an indeterminate terminal page as complete', async () => {
    globalThis.fetch = async (url) => htmlResponse('<html><body>Sign in</body></html>', String(url));
    globalThis.chrome.runtime.sendMessage = async () => ({
      data: { items: [], nextPageUrl: null, completeness: 'indeterminate' }
    });
    const result = await scraper.scrapeAmazonWishlist('https://www.amazon.nl/hz/wishlist/ls/LIST1');
    assert.equal(result.success, true);
    assert.equal(result.complete, false);
    assert.equal(result.completeness, 'indeterminate');
    assert.equal(result.stopReason, 'indeterminate_page');
  });

  it('times out a body that never finishes and preserves queue progress semantics', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://www.amazon.com/hz/wishlist/ls/LIST1',
      headers: new Headers({ 'content-type': 'text/html' }),
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} }) }
    });
    // Leave enough scheduling headroom for loaded CI hosts while still proving
    // that a never-ending body is aborted by the end-to-end deadline.
    const result = await scraper.scrapeAmazonWishlist('https://www.amazon.com/hz/wishlist/ls/LIST1', { maxElapsedMs: 50 });
    assert.equal(result.complete, false);
    assert.equal(result.stopReason, 'max_elapsed');
    assert.equal(result.error, 'FETCH_TIMEOUT');
  });

  it('keeps a legitimate bounded product and validated terminal wishlist working', async () => {
    globalThis.fetch = async (url) => htmlResponse('<html><body>ok</body></html>', String(url));
    const product = await scraper.scrapeAmazonProduct('https://www.amazon.com/dp/B000000001');
    assert.equal(product.success, true);

    const wishlist = await scraper.scrapeAmazonWishlist('https://www.amazon.com/hz/wishlist/ls/LIST1', {
      maxPages: 1,
      maxItems: 10,
      maxTotalBytes: 1024,
      maxElapsedMs: 1000
    });
    assert.equal(wishlist.success, true);
    assert.equal(wishlist.complete, true);
    assert.equal(wishlist.completeness, 'validated');
    assert.equal(wishlist.pagesProcessed, 1);
    assert.ok(wishlist.bytesProcessed > 0);
    assert.equal(wishlist.stopReason, 'complete');
  });
});
