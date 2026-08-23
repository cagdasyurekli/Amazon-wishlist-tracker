/**
 * Amazon Scraper Module
 * Runs in the background service worker.
 * 
 * Since MV3 Service Workers don't have access to the DOM (no DOMParser),
 * we will use the chrome.offscreen API to parse the HTML document.
 */

const OFFSCREEN_DOCUMENT_PATH = 'src/background/offscreen.html';
const FETCH_TIMEOUT_MS = 15000;
const AMAZON_HOST_PATTERN = /(^|\.)amazon\.(com|nl|de|fr|es|it|co\.uk)$/i;
let creatingOffscreenDocument;

/**
 * Ensures the offscreen document is created.
 */
async function setupOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['DOM_PARSER'],
    justification: 'Parsing Amazon HTML to extract price and stock info.'
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

/**
 * Releases the offscreen document after a scrape batch. The next scrape can
 * recreate it, while idle service workers do not keep a DOM-capable page alive.
 */
export async function closeOffscreenDocument() {
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
  }

  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

/**
 * Fetches an Amazon product page and extracts its data.
 * @param {string} url 
 * @returns {Promise<Object>} Extracted product data
 */
export async function scrapeAmazonProduct(url) {
  let abortTimeout;
  try {
    const fetchUrl = new URL(url);
    if (!AMAZON_HOST_PATTERN.test(fetchUrl.hostname)) {
      throw new Error('INVALID_AMAZON_URL');
    }

    // 1. Fetch the raw HTML
    // We append a random query parameter to bypass basic caching
    fetchUrl.searchParams.set('_t', Date.now());
    const controller = new AbortController();
    abortTimeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    const response = await fetch(fetchUrl.toString(), {
      signal: controller.signal,
      headers: {
        // Mimic a standard browser to reduce blocks
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    clearTimeout(abortTimeout);
    abortTimeout = null;

    if (response.status === 429 || response.status === 503) {
      throw new Error('RATE_LIMITED');
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const htmlContent = await response.text();

    // 2. Setup Offscreen Document for DOM Parsing
    await setupOffscreenDocument();

    // 3. Send HTML to offscreen document for parsing
    const result = await chrome.runtime.sendMessage({
      type: 'PARSE_AMAZON_HTML',
      target: 'offscreen',
      html: htmlContent,
      url: url
    });

    if (result && result.error) {
      throw new Error(result.error);
    }

    return result.data;
  } catch (error) {
    if (abortTimeout) {
      clearTimeout(abortTimeout);
    }
    console.error('Error scraping Amazon product:', error);
    return {
      success: false,
      error: error.name === 'AbortError' ? 'FETCH_TIMEOUT' : error.message
    };
  }
}

/**
 * Fetches an Amazon wishlist page and extracts its items. Supports pagination.
 * @param {string} url
 * @param {{maxPages?: number}} options
 * @returns {Promise<Object>} Extracted wishlist items
 */
export async function scrapeAmazonWishlist(url, options = {}) {
  let allItems = [];
  let currentUrl = url;
  let pageCount = 0;
  let consecutiveEmptyPages = 0;
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : 150;
  
  // Helper for random delay (Jitter)
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    while (currentUrl && pageCount < maxPages) {
      let abortTimeout;
      const fetchUrl = new URL(currentUrl);
      if (!AMAZON_HOST_PATTERN.test(fetchUrl.hostname)) {
        throw new Error('INVALID_AMAZON_URL');
      }

      const controller = new AbortController();
      abortTimeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      
      const response = await fetch(fetchUrl.toString(), {
        signal: controller.signal,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });

      clearTimeout(abortTimeout);
      abortTimeout = null;

      if (response.status === 429 || response.status === 503) {
        throw new Error('RATE_LIMITED');
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const htmlContent = await response.text();

      await setupOffscreenDocument();

      const result = await chrome.runtime.sendMessage({
        type: 'PARSE_AMAZON_WISHLIST',
        target: 'offscreen',
        html: htmlContent,
        url: currentUrl
      });

      if (result && result.error) {
        throw new Error(result.error);
      }

      const extractedData = result.data || {};
      const newItems = extractedData.items || [];
      
      // Merge unique items and track if we actually added anything new
      let addedCount = 0;
      newItems.forEach(newItem => {
        if (!allItems.find(i => i.id === newItem.id)) {
          allItems.push(newItem);
          addedCount++;
        }
      });

      // Detect end of list or stuck loop: Amazon sometimes glitches and returns 
      // a duplicate page or empty page in the middle of a large wishlist. 
      // We allow up to 3 consecutive empty/duplicate pages before giving up.
      if (addedCount === 0) {
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 3) {
          break;
        }
      } else {
        consecutiveEmptyPages = 0;
      }

      // Broadcast progress to UI
      try {
        chrome.runtime.sendMessage({ 
          type: 'WISHLIST_IMPORT_PROGRESS', 
          count: allItems.length 
        }).catch(() => {}); // Ignore if no listeners
      } catch (err) {
        // Ignore synchronous send errors
      }

      currentUrl = extractedData.nextPageUrl;
      pageCount++;

      // If there's a next page, add a delay to prevent bot bans
      if (currentUrl && pageCount < maxPages) {
        const jitter = Math.floor(Math.random() * 2000) + 1500; // 1.5 to 3.5 seconds
        await delay(jitter);
      }
    }

    return {
      success: true,
      items: allItems,
      complete: !currentUrl,
      nextPageUrl: currentUrl
    };
  } catch (error) {
    console.error('Error scraping Amazon wishlist:', error);
    // If we managed to get some items before failing, return them
    if (allItems.length > 0) {
      return { success: true, items: allItems, complete: false, nextPageUrl: currentUrl, error: error.message };
    }
    return {
      success: false,
      error: error.name === 'AbortError' ? 'FETCH_TIMEOUT' : error.message
    };
  }
}
