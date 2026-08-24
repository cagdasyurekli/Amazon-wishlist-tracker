import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../background/scraper.js', import.meta.url);
const amazonSource = await readFile(new URL('../utils/amazon.js', import.meta.url), 'utf8');
const amazonModuleUrl = `data:text/javascript;base64,${Buffer.from(amazonSource).toString('base64')}`;
const source = (await readFile(sourceUrl, 'utf8')).replace('../utils/amazon.js', amazonModuleUrl);
const scraperModule = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { scrapeAmazonWishlist } = scraperModule;

const originals = {
  chrome: globalThis.chrome,
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  consoleError: console.error
};

let parsedPages;
let fetchedUrls;

function item(id) {
  return {
    id,
    title: `Product ${id}`,
    url: `https://www.amazon.com/dp/${id}`,
    currentPrice: 10,
    currency: '$',
    inStock: true
  };
}

beforeEach(() => {
  parsedPages = new Map();
  fetchedUrls = [];
  globalThis.chrome = {
    offscreen: {
      hasDocument: async () => false,
      createDocument: async () => {},
      closeDocument: async () => {}
    },
    runtime: {
      sendMessage: async (message) => ({ data: parsedPages.get(message.url) || { items: [], nextPageUrl: null } })
    }
  };
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return { ok: true, status: 200, text: async () => '<html></html>' };
  };
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== 15000) queueMicrotask(() => callback(...args));
    return 1;
  };
  globalThis.clearTimeout = () => {};
  console.error = () => {};
});

afterEach(() => {
  globalThis.chrome = originals.chrome;
  globalThis.fetch = originals.fetch;
  globalThis.setTimeout = originals.setTimeout;
  globalThis.clearTimeout = originals.clearTimeout;
  console.error = originals.consoleError;
});

describe('wishlist scraper continuation contract', () => {
  it('returns an explicit continuation URL when maxPages stops a traversal', async () => {
    const first = 'https://www.amazon.com/hz/wishlist/ls/LIST?page=1';
    const second = 'https://www.amazon.com/hz/wishlist/ls/LIST?page=2';
    parsedPages.set(first, { items: [item('B000000001')], nextPageUrl: second, completeness: 'partial' });

    const result = await scrapeAmazonWishlist(first, { maxPages: 1 });

    assert.equal(result.success, true);
    assert.equal(result.complete, false);
    assert.equal(result.nextPageUrl, second);
    assert.deepEqual(result.items.map((entry) => entry.id), ['B000000001']);
    assert.deepEqual(fetchedUrls, [first]);
  });

  it('preserves accumulated items and the failed page URL after a partial rate limit', async () => {
    const first = 'https://www.amazon.com/hz/wishlist/ls/LIST?page=1';
    const second = 'https://www.amazon.com/hz/wishlist/ls/LIST?page=2';
    parsedPages.set(first, { items: [item('B000000001')], nextPageUrl: second, completeness: 'partial' });
    globalThis.fetch = async (url) => {
      fetchedUrls.push(String(url));
      if (String(url) === second) return { ok: false, status: 503, text: async () => '' };
      return { ok: true, status: 200, text: async () => '<html></html>' };
    };

    const result = await scrapeAmazonWishlist(first, { maxPages: 8 });

    assert.equal(result.success, true);
    assert.equal(result.complete, false);
    assert.equal(result.error, 'RATE_LIMITED');
    assert.equal(result.nextPageUrl, second);
    assert.deepEqual(result.items.map((entry) => entry.id), ['B000000001']);
  });

  it('can resume from a supplied continuation URL and finish without replaying earlier pages', async () => {
    const second = 'https://www.amazon.com/hz/wishlist/ls/LIST?page=2';
    const third = 'https://www.amazon.com/hz/wishlist/ls/LIST?page=3';
    parsedPages.set(second, { items: [item('B000000002')], nextPageUrl: third, completeness: 'partial' });
    parsedPages.set(third, { items: [item('B000000003')], nextPageUrl: null, completeness: 'validated' });

    const result = await scrapeAmazonWishlist(second, { maxPages: 2 });

    assert.equal(result.success, true);
    assert.equal(result.complete, true);
    assert.equal(result.nextPageUrl, null);
    assert.deepEqual(result.items.map((entry) => entry.id), ['B000000002', 'B000000003']);
    assert.deepEqual(fetchedUrls, [second, third]);
  });

  it('fails closed before fetching an unsupported host', async () => {
    const result = await scrapeAmazonWishlist('https://example.com/wishlist/ls/LIST', { maxPages: 1 });

    assert.equal(result.success, false);
    assert.equal(result.error, 'INVALID_AMAZON_URL');
    assert.deepEqual(fetchedUrls, []);
  });
});
