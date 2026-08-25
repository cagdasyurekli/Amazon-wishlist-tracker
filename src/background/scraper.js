/**
 * Amazon Scraper Module
 * Runs in the background service worker. DOM parsing is delegated to a tightly
 * constrained offscreen document because MV3 service workers have no DOMParser.
 */

import {
  getAmazonAsin,
  getAmazonWishlistId,
  parseCanonicalAmazonProductUrl,
  parseCanonicalAmazonWishlistUrl
} from '../utils/amazon.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/background/offscreen.html';
const FETCH_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_WISHLIST_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_WISHLIST_MAX_ITEMS = 2000;
const DEFAULT_WISHLIST_MAX_ELAPSED_MS = 10 * 60 * 1000;
let creatingOffscreenDocument;

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function errorCode(error) {
  if (error?.name === 'AbortError') return 'FETCH_TIMEOUT';
  return error?.message || 'SCRAPE_FAILED';
}

function ensureTimeRemaining(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('FETCH_TIMEOUT');
  return remaining;
}

async function readBoundedHtml(response, maxBytes) {
  const contentType = response.headers?.get?.('content-type');
  if (response.headers?.get && (!contentType || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType))) {
    throw new Error('UNEXPECTED_CONTENT_TYPE');
  }

  const contentLength = response.headers?.get?.('content-length');
  if (contentLength != null && contentLength !== '') {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
      throw new Error('RESPONSE_TOO_LARGE');
    }
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let bytes = 0;
    let html = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
      return { html, bytes };
    } catch (error) {
      try { await reader.cancel(errorCode(error)); } catch (_cancelError) {}
      throw error;
    } finally {
      reader.releaseLock?.();
    }
  }

  // Fetch responses in supported Chrome versions expose a stream. These
  // fallbacks keep deterministic test doubles and older engines bounded after
  // decoding, without weakening the streamed production path.
  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return { html: new TextDecoder().decode(buffer), bytes: buffer.byteLength };
  }

  const html = await response.text();
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
  return { html, bytes };
}

async function fetchAndParse(url, messageType, { deadlineAt, maxBytes, validateUrl }) {
  const requestedUrl = validateUrl(url);
  if (!requestedUrl) throw new Error('INVALID_AMAZON_URL');

  const controller = new AbortController();
  const operationRemainingMs = ensureTimeRemaining(deadlineAt);
  const remainingMs = Math.min(FETCH_TIMEOUT_MS, operationRemainingMs);
  const operationDeadlineLimited = operationRemainingMs <= FETCH_TIMEOUT_MS;
  let timeoutId;

  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        callback(value);
      };

      timeoutId = setTimeout(() => {
        controller.abort();
        const timeoutError = new Error('FETCH_TIMEOUT');
        timeoutError.operationDeadlineExceeded = operationDeadlineLimited;
        finish(reject, timeoutError);
      }, remainingMs);

      (async () => {
        const response = await fetch(requestedUrl.href, {
          signal: controller.signal,
          headers: {
            'Accept': 'text/html,application/xhtml+xml;q=0.9',
            'Accept-Language': 'en-US,en;q=0.5'
          }
        });

        if (response.status === 429 || response.status === 503) throw new Error('RATE_LIMITED');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        // Native Fetch Response objects always expose the final redirect URL.
        // Test doubles may omit it, in which case the already-validated request
        // URL is used only as a compatibility fallback.
        const finalUrl = response.url || requestedUrl.href;
        const validatedFinalUrl = validateUrl(finalUrl);
        if (!validatedFinalUrl) throw new Error('INVALID_AMAZON_REDIRECT');

        const { html, bytes } = await readBoundedHtml(response, maxBytes);
        ensureTimeRemaining(deadlineAt);
        await setupOffscreenDocument();

        const result = await chrome.runtime.sendMessage({
          type: messageType,
          target: 'offscreen',
          html,
          url: validatedFinalUrl.href
        });
        ensureTimeRemaining(deadlineAt);
        if (result?.error) throw new Error(result.error);
        return { data: result?.data, bytes, finalUrl: validatedFinalUrl.href };
      })().then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function setupOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['DOM_PARSER'],
    justification: 'Parsing bounded Amazon HTML to extract price and stock info.'
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

export async function closeOffscreenDocument() {
  if (creatingOffscreenDocument) await creatingOffscreenDocument;
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

export async function scrapeAmazonProduct(url) {
  try {
    const parsedUrl = parseCanonicalAmazonProductUrl(url);
    if (!parsedUrl) throw new Error('INVALID_AMAZON_URL');
    const requestedAsin = getAmazonAsin(parsedUrl.href);
    parsedUrl.searchParams.set('_t', Date.now());

    const result = await fetchAndParse(parsedUrl.href, 'PARSE_AMAZON_HTML', {
      deadlineAt: Date.now() + FETCH_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      validateUrl: (candidate) => {
        const parsed = parseCanonicalAmazonProductUrl(candidate);
        return parsed && getAmazonAsin(parsed.href) === requestedAsin ? parsed : null;
      }
    });
    return result.data;
  } catch (error) {
    console.error('Error scraping Amazon product:', error);
    return { success: false, error: errorCode(error) };
  }
}

/**
 * Fetches and extracts a wishlist with explicit cumulative operation budgets.
 * A result is complete only after a structurally validated terminal page.
 */
export async function scrapeAmazonWishlist(url, options = {}) {
  const allItems = [];
  const itemIds = new Set();
  let currentUrl = url;
  let pageCount = 0;
  let bytesProcessed = 0;
  let consecutiveEmptyPages = 0;
  let stopReason = 'complete';
  let completeness = 'partial';

  const maxPages = positiveInteger(options.maxPages, 150);
  const maxItems = positiveInteger(options.maxItems, DEFAULT_WISHLIST_MAX_ITEMS);
  const maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_WISHLIST_MAX_TOTAL_BYTES);
  const maxElapsedMs = positiveInteger(options.maxElapsedMs, DEFAULT_WISHLIST_MAX_ELAPSED_MS);
  const deadlineAt = Date.now() + maxElapsedMs;
  const initialWishlistId = getAmazonWishlistId(url);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  if (!initialWishlistId || !parseCanonicalAmazonWishlistUrl(url)) {
    return {
      success: false,
      error: 'INVALID_AMAZON_URL',
      items: [],
      complete: false,
      completeness: 'indeterminate',
      nextPageUrl: null,
      pagesProcessed: 0,
      bytesProcessed: 0,
      stopReason: 'invalid_url'
    };
  }

  try {
    while (currentUrl && pageCount < maxPages) {
      if (Date.now() >= deadlineAt) {
        stopReason = 'max_elapsed';
        break;
      }
      if (bytesProcessed >= maxTotalBytes) {
        stopReason = 'max_total_bytes';
        break;
      }

      const page = await fetchAndParse(currentUrl, 'PARSE_AMAZON_WISHLIST', {
        deadlineAt,
        maxBytes: Math.min(MAX_RESPONSE_BYTES, maxTotalBytes - bytesProcessed),
        validateUrl: (candidate) => {
          const parsed = parseCanonicalAmazonWishlistUrl(candidate);
          return parsed && getAmazonWishlistId(parsed.href) === initialWishlistId ? parsed : null;
        }
      });

      bytesProcessed += page.bytes;
      pageCount += 1;
      const extractedData = page.data || {};
      const pageCompleteness = extractedData.completeness || 'indeterminate';
      if (pageCompleteness === 'indeterminate') {
        completeness = 'indeterminate';
        stopReason = 'indeterminate_page';
        currentUrl = page.finalUrl;
        break;
      }

      let addedCount = 0;
      for (const newItem of extractedData.items || []) {
        if (!newItem?.id || itemIds.has(newItem.id)) continue;
        if (allItems.length >= maxItems) {
          stopReason = 'max_items';
          break;
        }
        itemIds.add(newItem.id);
        allItems.push(newItem);
        addedCount += 1;
      }
      if (stopReason === 'max_items') break;

      if (addedCount === 0) {
        consecutiveEmptyPages += 1;
        if (consecutiveEmptyPages >= 3 && extractedData.nextPageUrl) {
          stopReason = 'duplicate_pages';
          currentUrl = extractedData.nextPageUrl;
          break;
        }
      } else {
        consecutiveEmptyPages = 0;
      }

      try {
        chrome.runtime.sendMessage({ type: 'WISHLIST_IMPORT_PROGRESS', count: allItems.length }).catch(() => {});
      } catch (_error) {}

      currentUrl = extractedData.nextPageUrl || null;
      if (currentUrl) {
        const next = parseCanonicalAmazonWishlistUrl(currentUrl);
        if (!next || getAmazonWishlistId(next.href) !== initialWishlistId) {
          throw new Error('INVALID_AMAZON_URL');
        }
        completeness = 'partial';
      } else if (pageCompleteness === 'validated') {
        completeness = 'validated';
        stopReason = 'complete';
      } else {
        completeness = 'indeterminate';
        stopReason = 'indeterminate_page';
      }

      if (currentUrl && pageCount < maxPages) {
        const jitter = Math.floor(Math.random() * 2000) + 1500;
        if (Date.now() + jitter >= deadlineAt) {
          stopReason = 'max_elapsed';
          break;
        }
        await delay(jitter);
      }
    }

    if (currentUrl && stopReason === 'complete') stopReason = 'max_pages';
    return {
      success: true,
      items: allItems,
      complete: !currentUrl && completeness === 'validated' && stopReason === 'complete',
      completeness,
      nextPageUrl: currentUrl,
      pagesProcessed: pageCount,
      bytesProcessed,
      stopReason
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'FETCH_TIMEOUT' && (error.operationDeadlineExceeded || Date.now() >= deadlineAt)) {
      stopReason = 'max_elapsed';
    }
    else if (code === 'RESPONSE_TOO_LARGE') stopReason = 'max_total_bytes';
    else stopReason = 'error';

    console.error('Error scraping Amazon wishlist:', error);
    return {
      success: allItems.length > 0,
      items: allItems,
      complete: false,
      completeness: 'partial',
      nextPageUrl: currentUrl,
      pagesProcessed: pageCount,
      bytesProcessed,
      stopReason,
      error: code
    };
  }
}

export {
  DEFAULT_WISHLIST_MAX_ELAPSED_MS,
  DEFAULT_WISHLIST_MAX_ITEMS,
  DEFAULT_WISHLIST_MAX_TOTAL_BYTES,
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  readBoundedHtml
};
