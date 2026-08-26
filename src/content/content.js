/**
 * Content script injected into Amazon pages.
 * Handles visible-page product and wishlist discovery plus the "Track Price" action.
 */

const TRACK_CONTROL_ID = 'amz-tracker-control';
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const PRODUCT_PATH_PATTERN = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i;
const MAX_VISIBLE_WISHLIST_ROWS = 2000;
const MAX_WISHLIST_TITLE_LENGTH = 300;
const MAX_PRODUCT_AUTHORS = 20;
const MAX_AUTHOR_LENGTH = 160;
let trackButton = null;

const TRACK_BUTTON_STYLES = `
  :host { display: block; width: 100%; }
  button {
    box-sizing: border-box;
    width: 100%;
    margin: 10px 0;
    padding: 10px 14px;
    border: 2px solid #13c6a3;
    border-radius: 8px;
    background: #152238;
    color: #f7fafc;
    box-shadow: 0 2px 6px rgba(21, 34, 56, 0.2);
    cursor: pointer;
    font-family: Arial, sans-serif;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.25;
    transition: background-color 0.2s, border-color 0.2s, transform 0.1s;
  }
  button:hover { background-color: #203653; border-color: #42d8ba; }
  button:active { transform: scale(0.98); }
  button:focus-visible { outline: 3px solid #13c6a3; outline-offset: 2px; }
  button:disabled {
    border-color: #8aa39e;
    background: #334155;
    color: #f7fafc;
    cursor: default;
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
  }
`;

function extractAsinFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(PRODUCT_PATH_PATTERN);
    const asin = match ? match[1].toUpperCase() : null;
    return asin && ASIN_PATTERN.test(asin) ? asin : null;
  } catch {
    return null;
  }
}

function extractAuthorNames(root, selector) {
  return [...new Set(Array.from(root.querySelectorAll(selector))
    .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((name) => name && name.length <= MAX_AUTHOR_LENGTH))]
    .slice(0, MAX_PRODUCT_AUTHORS);
}

// Inject a "Track Price" button near the Amazon Buy Box. The closed shadow
// root keeps private tracked/not-tracked state out of Amazon's shared DOM.
function injectTrackButton() {
  const buyBox = document.querySelector('#buybox') || document.querySelector('#desktop_buybox');
  if (!buyBox || document.getElementById(TRACK_CONTROL_ID)) return;

  const host = document.createElement('span');
  host.id = TRACK_CONTROL_ID;
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = TRACK_BUTTON_STYLES;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Track price';
  btn.setAttribute('aria-live', 'polite');
  trackButton = btn;

  btn.addEventListener('click', async (e) => {
    // Shared-DOM events are attacker-controlled. Only a real, currently active
    // browser user gesture can authorize persistent tracking from this surface.
    if (!e.isTrusted || navigator.userActivation?.isActive !== true) return;
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Adding…';
    const result = await extractAndTrackProduct();
    applyButtonState(btn, result);
  });

  shadow.append(style, btn);
  buyBox.prepend(host);

  // Check if already tracked
  const asin = extractAsinFromUrl(window.location.href);
  if (asin) {
    chrome.runtime.sendMessage({ type: 'CHECK_IF_TRACKED', asin }, (response) => {
      if (response && response.isTracked) {
        btn.textContent = 'Tracking price';
        btn.disabled = true;
      }
    });
  }
}

// Reflects the add result on the in-page button so the user always gets feedback.
function applyButtonState(btn, result) {
  if (!btn) return;
  if (result && result.success) {
    btn.textContent = 'Tracking price';
    btn.disabled = true;
  } else if (result && result.exists) {
    btn.textContent = 'Tracking price';
    btn.disabled = true;
  } else {
    // Surface failures instead of leaving the button stuck on "Adding…".
    btn.disabled = false;
    btn.textContent = 'Try again';
  }
}

// Extracts basic data from the page and asks the background worker to track it.
// Resolves to the background's response ({success}|{exists}|{error}) so callers
// (in-page button and popup) can give the user real feedback.
function extractAndTrackProduct() {
  // Try to find product title
  const titleEl = document.querySelector('#productTitle');
  const title = titleEl ? titleEl.textContent.trim() : document.title;
  const authors = extractAuthorNames(
    document,
    '#bylineInfo .contributorNameID, #bylineInfo .author a'
  );

  // Product identity is security-sensitive: never invent an ID when the page
  // URL does not contain a canonical ten-character ASIN.
  const asin = extractAsinFromUrl(window.location.href);
  if (!asin) {
    return Promise.resolve({ error: 'A valid Amazon product identifier is required.' });
  }

  // Find current price visually (fallback, scraper.js does the real job)
  let currentPrice = null;
  let currency = null;
  
  const priceSelectors = [
    '.a-price .a-offscreen',
    '#kindle-price',
    '#buyNew_noncbb',
    '#tmm-grid-swatch-KINDLE .a-color-price',
    '.a-color-price'
  ];
  
  for (const selector of priceSelectors) {
    const priceEl = document.querySelector(selector);
    if (priceEl && priceEl.textContent) {
      currentPrice = parsePrice(priceEl.textContent);
      currency = extractCurrency(priceEl.textContent);
      if (currentPrice !== null) break;
    }
  }

  const item = {
    id: asin,
    title: title,
    authors,
    url: window.location.href.split('?')[0], // canonical URL
    currentPrice: currentPrice,
    currency,
    originalPrice: currentPrice, // for discount tracking
    addedAt: Date.now()
  };

  // Send message to background script to safely add the item (uses Mutex)
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ADD_TRACKED_ITEM', item }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { error: 'No response from background worker' });
    });
  });
}

function parsePrice(rawText) {
  if (!rawText) return null;
  const cleaned = rawText.replace(/[^\d.,]/g, '');
  if (!cleaned) return null;

  const decimalMatch = cleaned.match(/([.,])(\d{1,2})$/);
  const normalized = decimalMatch
    ? cleaned
        .split(decimalMatch[1] === '.' ? ',' : '.')
        .join('')
        .replace(decimalMatch[1], '.')
    : cleaned.replace(/[.,]/g, '');

  const value = parseFloat(normalized);
  return Number.isNaN(value) ? null : value;
}

function extractCurrency(rawText) {
  if (!rawText) return null;
  const symbol = rawText.match(/[$€£¥₺]/)?.[0];
  if (symbol) return symbol;
  return /(?:^|[\d.,\s])TL(?:[\d.,\s]|$)/i.test(rawText) ? '₺' : null;
}

function parseWishlistPriceDrop(text, currentPrice) {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  const dropMatch = normalized.match(/price\s+dropped\s+(\d{1,3})\s*%/i);
  const wasMatch = normalized.match(/\(\s*was\s*([€$£¥]?\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)\s*when\s+added\s+to\s+list\s*\)/i);
  if (!dropMatch && !wasMatch) return null;

  const wasPrice = wasMatch ? parsePrice(wasMatch[1]) : null;
  const percent = dropMatch
    ? parseInt(dropMatch[1], 10)
    : (wasPrice && currentPrice ? Math.round(((wasPrice - currentPrice) / wasPrice) * 100) : null);

  return {
    percent: Number.isFinite(percent) ? percent : null,
    wasPrice,
    amount: wasPrice && currentPrice ? Math.max(0, Math.round((wasPrice - currentPrice) * 100) / 100) : null,
    currency: extractCurrency(wasMatch ? wasMatch[1] : normalized),
    text: normalized
  };
}

function extractWishlistItemsFromPage() {
  const rows = Array.from(document.querySelectorAll('li[data-itemid], div[data-itemid]'))
    .slice(0, MAX_VISIBLE_WISHLIST_ROWS);
  const items = [];
  const pageOrigin = window.location.origin;

  rows.forEach((row) => {
    const text = row.innerText || row.textContent || '';
    const productLink = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
    const asinMatch = productLink?.href?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    const asin = asinMatch ? asinMatch[1] : null;
    if (!asin || items.some(item => item.id === asin)) return;

    const titleEl = row.querySelector('[id^="itemName_"], h2 a, a[href*="/dp/"]');
    const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_WISHLIST_TITLE_LENGTH);
    if (!title) return;
    const authors = extractAuthorNames(
      row,
      '[id^="item-byline"] a, [class*="item-byline"] a'
    );

    let currentPrice = null;
    let currency = null;
    const priceSelectors = [
      '.a-price .a-offscreen',
      '.a-price',
      '.a-color-price',
      '[id*="itemPrice"]',
      '[class*="price"]'
    ];
    for (const selector of priceSelectors) {
      const priceEl = row.querySelector(selector);
      if (priceEl?.textContent) {
        currentPrice = parsePrice(priceEl.textContent);
        currency = extractCurrency(priceEl.textContent);
        if (currentPrice !== null) break;
      }
    }
    if (currentPrice === null) {
      const priceMatch = text.match(/(?:[€$£¥₺]\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?|\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*(?:TL|₺))/i);
      if (priceMatch) {
        currentPrice = parsePrice(priceMatch[0]);
        currency = extractCurrency(priceMatch[0]);
      }
    }

    let originalPrice = currentPrice;
    let wishlistPriceDropPercent = null;
    let wishlistPriceWhenAdded = null;
    let wishlistPriceDropAmount = null;
    let wishlistPriceDropText = null;
    const nativeDrop = parseWishlistPriceDrop(text, currentPrice);
    if (nativeDrop) {
      wishlistPriceDropPercent = nativeDrop.percent;
      wishlistPriceWhenAdded = nativeDrop.wasPrice;
      wishlistPriceDropAmount = nativeDrop.amount;
      wishlistPriceDropText = nativeDrop.text;
      currency = nativeDrop.currency || currency;
      if (nativeDrop.wasPrice && (!originalPrice || nativeDrop.wasPrice > originalPrice)) {
        originalPrice = nativeDrop.wasPrice;
      }
    }

    const strikePrice = parsePrice(row.querySelector('.a-text-strike')?.textContent || '');
    if (strikePrice && currentPrice && strikePrice > currentPrice) {
      originalPrice = strikePrice;
    }

    const unavailable = globalThis.AmazonAvailability.classifyAvailabilityText(text) === false;

    items.push({
      id: asin,
      wishlistItemId: (row.getAttribute('data-itemid') || '').slice(0, 128) || null,
      title,
      authors,
      url: `${pageOrigin}/dp/${asin}`,
      imageUrl: row.querySelector('img[src*="images/I/"]')?.src || '',
      currentPrice,
      originalPrice,
      wishlistPriceDropPercent,
      wishlistPriceWhenAdded,
      wishlistPriceDropAmount,
      wishlistPriceDropText: wishlistPriceDropText?.slice(0, 500) || null,
      currency: currency?.slice(0, 8) || null,
      inStock: !unavailable,
      addedAt: Date.now()
    });
  });

  return items;
}

// Message listener for popup requesting to track current page. Responds with the
// add result so the popup can show feedback instead of guessing.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRACK_CURRENT_PAGE') {
    (async () => {
      const result = await extractAndTrackProduct();
      applyButtonState(trackButton, result);
      sendResponse(result);
    })();
    return true; // async response
  }

  if (message.type === 'EXTRACT_VISIBLE_WISHLIST') {
    const items = extractWishlistItemsFromPage();
    sendResponse({ success: true, items, limited: items.length >= MAX_VISIBLE_WISHLIST_ROWS });
    return true;
  }
});

// Run injections on load
injectTrackButton();

// Amazon renders the buy box asynchronously, so a one-shot injection on load
// frequently misses it. Watch the DOM until the button is placed, then stop.
if (!document.getElementById(TRACK_CONTROL_ID)) {
  const observer = new MutationObserver(() => {
    injectTrackButton();
    if (document.getElementById(TRACK_CONTROL_ID)) {
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // Safety valve: stop watching after 15s so we don't observe forever.
  setTimeout(() => observer.disconnect(), 15000);
}
