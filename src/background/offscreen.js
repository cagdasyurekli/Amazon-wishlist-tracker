/**
 * Offscreen Document Script
 * This has access to the full DOM API, allowing us to parse Amazon HTML safely
 * without running it in the context of a visible tab.
 */

chrome.runtime.onMessage.addListener(handleMessages);

function handleMessages(message, sender, sendResponse) {
  if (message.target !== 'offscreen') {
    return false;
  }

  if (message.type === 'PARSE_AMAZON_HTML') {
    try {
      const data = parseAmazonHtml(message.html, message.url);
      sendResponse({ data });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true; // Keep message channel open for async response if needed
  }

  if (message.type === 'PARSE_AMAZON_WISHLIST') {
    try {
      const result = parseAmazonWishlist(message.html, message.url);
      sendResponse({ data: result });
    } catch (error) {
      sendResponse({ error: error.message });
    }
    return true;
  }
}

/**
 * Parses a raw Amazon price string into a float, correctly handling both
 * US ("$1,299.99") and EU ("1.299,95 €") grouping/decimal conventions.
 *
 * The decimal separator is whichever of '.' or ',' appears last AND is
 * followed by 1-2 digits at the end of the string. Everything else of that
 * kind is treated as a thousands separator and stripped. If no separator is
 * followed by 1-2 trailing digits, the value is treated as an integer and all
 * separators are stripped (e.g. "1,234,567" -> 1234567).
 *
 * Returns null when no numeric value can be extracted.
 * @param {string} rawText
 * @returns {number|null}
 */
function parsePrice(rawText) {
  if (!rawText) return null;
  const cleaned = rawText.replace(/[^\d.,]/g, '');
  if (!cleaned) return null;

  // A trailing ".dd" or ",d" (1-2 digits) marks the decimal portion.
  const decimalMatch = cleaned.match(/([.,])(\d{1,2})$/);
  let normalized;
  if (decimalMatch) {
    const decimalSep = decimalMatch[1];
    const thousandsSep = decimalSep === '.' ? ',' : '.';
    normalized = cleaned.split(thousandsSep).join('').replace(decimalSep, '.');
  } else {
    // No decimal part: every separator is a thousands grouping.
    normalized = cleaned.replace(/[.,]/g, '');
  }

  const value = parseFloat(normalized);
  return isNaN(value) ? null : value;
}

function parseSplitPrice(container) {
  if (!container) return null;
  const whole = (container.querySelector('.a-price-whole')?.textContent || '').replace(/\D/g, '');
  const fraction = (container.querySelector('.a-price-fraction')?.textContent || '').replace(/\D/g, '').slice(0, 2);
  if (!whole) return null;
  const value = parseFloat(`${whole}.${fraction.padEnd(2, '0')}`);
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

function parseAmazonHtml(htmlString, url) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  // Check for CAPTCHA / bot interstitials. Amazon does not always change the
  // <title> (it can stay as the product name on some interstitials), so we also
  // scan the body for the tell-tale challenge phrases.
  const bodyText = (doc.body ? doc.body.textContent : '').toLowerCase();
  const captchaInBody =
    bodyText.includes('type the characters you see') ||
    bodyText.includes('enter the characters you see') ||
    bodyText.includes("we just need to make sure you're not a robot");
  if (doc.title.includes('Robot Check') || doc.title.includes('Captcha') || captchaInBody) {
    throw new Error('CAPTCHA_BLOCKED');
  }

  const data = {
    success: true,
    price: null,
    title: null,
    inStock: false,
    soldByAmazon: false,
    currency: null,
    buyBoxPrice: null,
    salesRank: null,
    isPurchased: false
  };

  const purchasedTexts = [
    'purchased on ',
    'you own this item',
    'gekocht op ',
    'je hebt dit item gekocht'
  ];
  if (purchasedTexts.some(text => bodyText.includes(text))) {
    data.isPurchased = true;
  }

  // Extract Title
  const titleEl = doc.querySelector('#productTitle');
  if (titleEl) {
    data.title = titleEl.textContent.trim();
  }

  // Extract Buy Box / Current Price
  // Amazon uses various IDs: #priceblock_ourprice, #priceblock_dealprice, or standard core price elements
  const priceSelectors = [
    '#corePrice_feature_div .priceToPay .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#apex_desktop .priceToPay .a-offscreen',
    '[data-feature-name="corePrice"] .priceToPay .a-offscreen',
    '.a-price.aok-align-center.reinventPricePriceToPayMargin .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#corePrice_feature_div .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-offscreen',
    '#apex_desktop .a-price .a-offscreen',
    '#kindle-price',
    '#buyNew_noncbb',
    '#tmm-grid-swatch-KINDLE .a-color-price',
    '.a-color-price'
  ];

  for (const selector of priceSelectors) {
    const el = doc.querySelector(selector);
    if (el && el.textContent) {
      const priceFloat = parsePrice(el.textContent);
      if (priceFloat !== null) {
        data.price = priceFloat;
        data.buyBoxPrice = priceFloat; // Default assumption
        data.currency = extractCurrency(el.textContent);
        break;
      }
    }
  }

  if (data.price === null) {
    const splitPriceSelectors = [
      '#corePrice_feature_div .priceToPay',
      '#corePriceDisplay_desktop_feature_div .priceToPay',
      '#apex_desktop .priceToPay',
      '[data-feature-name="corePrice"] .priceToPay',
      '#corePrice_feature_div .a-price',
      '#corePriceDisplay_desktop_feature_div .a-price'
    ];

    for (const selector of splitPriceSelectors) {
      const el = doc.querySelector(selector);
      const priceFloat = parseSplitPrice(el);
      if (priceFloat !== null) {
        data.price = priceFloat;
        data.buyBoxPrice = priceFloat;
        data.currency = extractCurrency(el?.textContent);
        break;
      }
    }
  }

  // Extract Stock Status
  const availabilityEl = doc.querySelector('#availability');
  if (availabilityEl) {
    const text = availabilityEl.textContent.toLowerCase();
    // Negative phrases that contain a positive substring ("available" lives
    // inside "unavailable"; "available from these sellers" appears when the
    // buy box itself is empty). These must veto an in-stock match.
    const negativePhrases = [
      'unavailable',
      'not available',
      'not currently available',
      'out of stock',
      'available from',
      'cannot be shipped',
      'see all buying options'
    ];
    const positivePhrases = [
      'in stock',
      'op voorraad',
      'available',
      'usually ships',
      'ships within'
    ];
    data.inStock =
      positivePhrases.some((p) => text.includes(p)) &&
      !negativePhrases.some((p) => text.includes(p));
  } else if (data.price !== null) {
    // If no availability div but has price, usually in stock
    data.inStock = true; 
  }

  // Extract Seller Type
  const merchantInfoEl = doc.querySelector('#merchant-info');
  if (merchantInfoEl) {
    const text = merchantInfoEl.textContent.toLowerCase();
    data.soldByAmazon = text.includes('amazon');
  }

  return data;
}

function parseAmazonWishlist(htmlString, url) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  // Check for CAPTCHA
  const bodyText = (doc.body ? doc.body.textContent : '').toLowerCase();
  const captchaInBody =
    bodyText.includes('type the characters you see') ||
    bodyText.includes('enter the characters you see') ||
    bodyText.includes("we just need to make sure you're not a robot");
  if (doc.title.includes('Robot Check') || doc.title.includes('Captcha') || captchaInBody) {
    throw new Error('CAPTCHA_BLOCKED');
  }

  const items = [];
  // Amazon wishlists typically use li with data-itemid
  const itemElements = doc.querySelectorAll('li[data-itemid]');
  
  for (const el of itemElements) {
    // Look for link containing ASIN
    const linkEl = el.querySelector('a[href*="/dp/"]');
    if (!linkEl) continue;

    const match = linkEl.href.match(/\/dp\/([A-Z0-9]{10})/i);
    if (!match) continue;
    const asin = match[1];

    // Find title
    const titleEl = el.querySelector(`a[id^="itemName_"]`) || linkEl;
    const title = titleEl.title || titleEl.textContent.trim();

    // Find price
    let currentPrice = null;
    let currency = null;
    
    const itemPriceSelectors = [
      '.a-price .a-offscreen',
      '[id^="itemPrice_"]',
      '.a-color-price'
    ];
    
    for (const selector of itemPriceSelectors) {
      const priceEl = el.querySelector(selector);
      if (priceEl && priceEl.textContent) {
        currentPrice = parsePrice(priceEl.textContent);
        currency = extractCurrency(priceEl.textContent);
        if (currentPrice !== null) break;
      }
    }

    // Check for "Unavailable" text
    const itemText = el.textContent.toLowerCase();
    const isUnavailable = itemText.includes('currently unavailable') || 
                          itemText.includes('no longer available') || 
                          itemText.includes('niet beschikbaar');
    const inStock = !isUnavailable;

    // Determine regional domain from wishlist URL
    let productUrl = `https://www.amazon.com/dp/${asin}`;
    if (url) {
      try {
        const urlObj = new URL(url);
        productUrl = `${urlObj.origin}/dp/${asin}`;
      } catch (e) {}
    }

    // Attempt to extract original price from Amazon's native "Price dropped" text or strikethrough
    let originalPrice = currentPrice;
    let wishlistPriceDropPercent = null;
    let wishlistPriceWhenAdded = null;
    let wishlistPriceDropAmount = null;
    let wishlistPriceDropText = null;
    const nativeDrop = parseWishlistPriceDrop(el.textContent, currentPrice);
    if (nativeDrop) {
      if (nativeDrop.wasPrice && (!originalPrice || nativeDrop.wasPrice > originalPrice)) {
        originalPrice = nativeDrop.wasPrice;
      }
      wishlistPriceWhenAdded = nativeDrop.wasPrice;
      wishlistPriceDropPercent = nativeDrop.percent;
      wishlistPriceDropAmount = nativeDrop.amount;
      wishlistPriceDropText = nativeDrop.text;
      currency = nativeDrop.currency || currency;
    }

    const strikePriceEl = el.querySelector('.a-text-strike');
    if (strikePriceEl && strikePriceEl.textContent) {
      const parsedStrike = parsePrice(strikePriceEl.textContent);
      if (parsedStrike && parsedStrike > currentPrice) {
        originalPrice = parsedStrike;
      }
    }
    if (originalPrice === currentPrice) {
      // Look for "was X" or "van X" (Dutch)
      const wasMatch = el.textContent.match(/(?:was|van)\s*([€$£¥]?\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/i);
      if (wasMatch) {
        const parsedWas = parsePrice(wasMatch[1]);
        if (parsedWas && parsedWas > currentPrice) {
          originalPrice = parsedWas;
        }
      }
    }

    // Extract product image
    let imageUrl = '';
    const imgEl = el.querySelector('img[src*="images/I/"]');
    if (imgEl) {
      imageUrl = imgEl.src;
    }

    const isPurchased = itemText.includes('purchased') || itemText.includes('gekocht') || itemText.includes('you own this item');

    // Only add if not already in our extracted list (duplicates sometimes exist)
    if (!items.find(i => i.id === asin)) {
      items.push({
        id: asin,
        title: title || 'Unknown Product',
        url: productUrl,
        imageUrl: imageUrl,
        currentPrice: currentPrice,
        originalPrice: originalPrice,
        wishlistPriceDropPercent,
        wishlistPriceWhenAdded,
        wishlistPriceDropAmount,
        wishlistPriceDropText,
        currency: currency,
        inStock: inStock,
        isPurchased: isPurchased,
        addedAt: Date.now()
      });
    }
  }

  // Find next page URL for pagination
  let nextPageUrl = null;
  // Amazon uses different elements depending on JS state (wl-see-more, g-more-items, or hidden input)
  let nextHref = null;

  const moreLink = doc.querySelector('a.wl-see-more, a.g-more-items');
  const hiddenInput = doc.querySelector('input.showMoreUrl');

  if (moreLink && moreLink.getAttribute('href') && moreLink.getAttribute('href') !== '#') {
    nextHref = moreLink.getAttribute('href');
  } else if (hiddenInput && hiddenInput.value) {
    nextHref = hiddenInput.value;
  }

  if (nextHref) {
    if (nextHref.startsWith('/')) {
      const urlObj = new URL(url);
      nextPageUrl = `${urlObj.origin}${nextHref}`;
    } else {
      nextPageUrl = nextHref;
    }
  }

  return { items, nextPageUrl };
}

// Export for Jest testing in Node environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseAmazonHtml, parsePrice, parseAmazonWishlist, parseWishlistPriceDrop };
}
