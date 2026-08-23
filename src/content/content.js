/**
 * Content script injected into Amazon pages.
 * Handles visible-page product and wishlist discovery plus the "Track Price" action.
 */

// Inject a "Track Price" button near the Amazon Buy Box
function injectTrackButton() {
  const buyBox = document.querySelector('#buybox') || document.querySelector('#desktop_buybox');
  if (!buyBox || document.getElementById('amz-tracker-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'amz-tracker-btn';
  btn.textContent = '👀 Track Price';
  btn.style.cssText = `
    width: 100%;
    margin-top: 10px;
    margin-bottom: 10px;
    padding: 10px;
    background-color: #ff9900;
    color: white;
    border: 1px solid #e38800;
    border-radius: 8px;
    cursor: pointer;
    font-weight: bold;
    font-size: 14px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  `;

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Adding…';
    const result = await extractAndTrackProduct();
    applyButtonState(btn, result);
  });

  buyBox.prepend(btn);

  // Check if already tracked
  const asinMatch = window.location.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  const asin = asinMatch ? asinMatch[1] : null;
  if (asin) {
    chrome.runtime.sendMessage({ type: 'CHECK_IF_TRACKED', asin }, (response) => {
      if (response && response.isTracked) {
        btn.textContent = '✅ Tracking Price';
        btn.disabled = true;
      }
    });
  }
}

// Reflects the add result on the in-page button so the user always gets feedback.
function applyButtonState(btn, result) {
  if (!btn) return;
  if (result && result.success) {
    btn.textContent = '✅ Tracking Price';
  } else if (result && result.exists) {
    btn.textContent = '✅ Tracking Price';
  } else {
    // Surface failures instead of leaving the button stuck on "Adding…".
    btn.disabled = false;
    btn.textContent = '⚠️ Try Again';
  }
}

// Extracts basic data from the page and asks the background worker to track it.
// Resolves to the background's response ({success}|{exists}|{error}) so callers
// (in-page button and popup) can give the user real feedback.
function extractAndTrackProduct() {
  // Try to find product title
  const titleEl = document.querySelector('#productTitle');
  const title = titleEl ? titleEl.textContent.trim() : document.title;

  // Extract ASIN from URL (simple regex)
  const asinMatch = window.location.href.match(/\/dp\/([A-Z0-9]{10})/i) || window.location.href.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  const asin = asinMatch ? asinMatch[1] : `ID-${Date.now()}`;

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
  const match = rawText.match(/[$€£¥]/);
  return match ? match[0] : null;
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
  const rows = Array.from(document.querySelectorAll('li[data-itemid], div[data-itemid]'));
  const items = [];
  const pageOrigin = window.location.origin;

  rows.forEach((row) => {
    const text = row.innerText || row.textContent || '';
    const productLink = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
    const asinMatch = productLink?.href?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    const asin = asinMatch ? asinMatch[1] : null;
    if (!asin || items.some(item => item.id === asin)) return;

    const titleEl = row.querySelector('[id^="itemName_"], h2 a, a[href*="/dp/"]');
    const title = (titleEl?.textContent || '').trim();
    if (!title) return;

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
      const priceMatch = text.match(/[€$£¥]\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/);
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

    const itemText = text.toLowerCase();
    const unavailable = itemText.includes('currently unavailable') ||
      itemText.includes('no longer available') ||
      itemText.includes('niet beschikbaar');

    items.push({
      id: asin,
      wishlistItemId: row.getAttribute('data-itemid') || null,
      title,
      url: `${pageOrigin}/dp/${asin}`,
      imageUrl: row.querySelector('img[src*="images/I/"]')?.src || '',
      currentPrice,
      originalPrice,
      wishlistPriceDropPercent,
      wishlistPriceWhenAdded,
      wishlistPriceDropAmount,
      wishlistPriceDropText,
      currency,
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
      applyButtonState(document.getElementById('amz-tracker-btn'), result);
      sendResponse(result);
    })();
    return true; // async response
  }

  if (message.type === 'EXTRACT_VISIBLE_WISHLIST') {
    sendResponse({ success: true, items: extractWishlistItemsFromPage() });
    return true;
  }
});

// Run injections on load
injectTrackButton();

// Amazon renders the buy box asynchronously, so a one-shot injection on load
// frequently misses it. Watch the DOM until the button is placed, then stop.
if (!document.getElementById('amz-tracker-btn')) {
  const observer = new MutationObserver(() => {
    injectTrackButton();
    if (document.getElementById('amz-tracker-btn')) {
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // Safety valve: stop watching after 15s so we don't observe forever.
  setTimeout(() => observer.disconnect(), 15000);
}
