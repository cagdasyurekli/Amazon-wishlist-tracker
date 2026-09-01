/**
 * Offscreen Document Script
 * This has access to the full DOM API, allowing us to parse Amazon HTML safely
 * without running it in the context of a visible tab.
 */

chrome.runtime.onMessage.addListener(handleMessages);

const MAX_HTML_CHARS = 8 * 1024 * 1024;
const MAX_WISHLIST_ROWS = 2500;
const MAX_PRODUCT_AUTHORS = 20;
const MAX_AUTHOR_LENGTH = 160;
const SAFE_IMAGE_HOSTS = new Set([
  'm.media-amazon.com',
  'images.amazon.com',
  'ecx.images-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images-fe.ssl-images-amazon.com',
  'images-cn.ssl-images-amazon.com',
  'images-jp.amazon.com'
]);
const AMAZON_HOST_PATTERN = /(^|\.)amazon\.(com(?:\.tr)?|nl|de|fr|es|it|co\.uk)$/i;
const WISHLIST_ID_PATTERN = /^[a-z0-9_=-]{1,64}$/i;
const WISHLIST_CONTINUATION_PATH_PATTERN = /^\/(?:-\/[a-z]{2}(?:-[a-z]{2})?\/)?hz\/wishlist\/slv\/items\/?$/i;

function getAmazonWishlistId(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !AMAZON_HOST_PATTERN.test(parsed.hostname)) {
      return null;
    }
    const pathId = parsed.pathname.match(/\/(?:hz\/)?wishlist\/ls\/([a-z0-9_=-]{1,64})(?:[/?#]|$)/i)?.[1];
    if (pathId) return pathId;
    if (!WISHLIST_CONTINUATION_PATH_PATTERN.test(parsed.pathname)) return null;

    const listIds = parsed.searchParams.getAll('lid');
    const paginationTokens = parsed.searchParams.getAll('paginationToken');
    return listIds.length === 1 &&
      WISHLIST_ID_PATTERN.test(listIds[0]) &&
      paginationTokens.length === 1 &&
      paginationTokens[0]
      ? listIds[0]
      : null;
  } catch (_error) {
    return null;
  }
}

function resolveAmazonWishlistPageUrl(value, baseUrl) {
  try {
    const parsed = new URL(value, baseUrl);
    const expectedId = getAmazonWishlistId(baseUrl);
    if (!expectedId || getAmazonWishlistId(parsed.href) !== expectedId) return null;
    const base = new URL(baseUrl);
    if (
      WISHLIST_CONTINUATION_PATH_PATTERN.test(parsed.pathname) &&
      parsed.origin !== base.origin
    ) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

function isAmazonWishlistTerminalContinuationUrl(value, baseUrl) {
  try {
    const parsed = new URL(value, baseUrl);
    const base = new URL(baseUrl);
    const expectedId = getAmazonWishlistId(base.href);
    const listIds = parsed.searchParams.getAll('lid');
    const paginationTokens = parsed.searchParams.getAll('paginationToken');
    return Boolean(
      expectedId &&
      parsed.origin === base.origin &&
      WISHLIST_CONTINUATION_PATH_PATTERN.test(parsed.pathname) &&
      listIds.length === 1 &&
      listIds[0] === expectedId &&
      paginationTokens.length === 1 &&
      paginationTokens[0] === ''
    );
  } catch (_error) {
    return false;
  }
}

function isIdentityBoundWishlistContinuationUrl(value) {
  try {
    const parsed = new URL(value);
    return Boolean(
      getAmazonWishlistId(parsed.href) &&
      WISHLIST_CONTINUATION_PATH_PATTERN.test(parsed.pathname)
    );
  } catch (_error) {
    return false;
  }
}

function sanitizeAmazonImageUrl(value, baseUrl) {
  try {
    const parsed = new URL(value, baseUrl);
    if (
      parsed.href.length > 2048 ||
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !SAFE_IMAGE_HOSTS.has(parsed.hostname.toLowerCase()) ||
      !parsed.pathname.includes('/images/I/')
    ) return '';
    parsed.hash = '';
    return parsed.href;
  } catch (_error) {
    return '';
  }
}

function extractAuthorNames(root, selector) {
  return [...new Set(Array.from(root.querySelectorAll(selector))
    .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((name) => name && name.length <= MAX_AUTHOR_LENGTH))]
    .slice(0, MAX_PRODUCT_AUTHORS);
}

function parseInertHtml(htmlString, baseUrl) {
  if (typeof htmlString !== 'string' || htmlString.length > MAX_HTML_CHARS) {
    throw new Error('HTML_TOO_LARGE');
  }

  // Template contents are parsed into an inert DocumentFragment. They are never
  // attached to the offscreen page, so scripts, media, frames and images cannot
  // become active. A restrictive page CSP in offscreen.html provides a second
  // independent fail-closed control.
  const template = document.createElement('template');
  template.innerHTML = htmlString;
  const root = template.content;

  // Preserve only strong, document-level wishlist identity signals before
  // removing metadata and resource-bearing elements. Ordinary anchors are not
  // identity proof because seller or recommendation content can contain them.
  const documentWishlistIds = [
    ...root.querySelectorAll('link[rel~="canonical"][href], meta[property="og:url"][content]')
  ].map((node) => getAmazonWishlistId(
    node.getAttribute('href') || node.getAttribute('content') || ''
  )).filter(Boolean);

  root.querySelectorAll('img').forEach((image) => {
    const rawSource = image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-old-hires') || '';
    const safeSource = sanitizeAmazonImageUrl(rawSource, baseUrl);
    if (safeSource) image.dataset.safeImageUrl = safeSource;
    if (/captcha|validatecaptcha/i.test(`${rawSource} ${image.getAttribute('alt') || ''}`)) {
      image.dataset.captchaMarker = 'true';
    }
  });
  root.querySelectorAll('form').forEach((form) => {
    if (/validatecaptcha|captcha/i.test(form.getAttribute('action') || '')) {
      form.dataset.captchaForm = 'true';
    }
  });

  root.querySelectorAll('base, script, iframe, frame, object, embed, link, style, meta[http-equiv="refresh" i]').forEach((node) => node.remove());
  const resourceAttributes = [
    'src', 'srcset', 'poster', 'data', 'ping', 'background', 'action',
    'formaction', 'xlink:href', 'style'
  ];
  root.querySelectorAll('*').forEach((node) => {
    resourceAttributes.forEach((attribute) => node.removeAttribute(attribute));
  });

  return {
    root,
    title: (root.querySelector('title')?.textContent || '').trim(),
    text: root.textContent || '',
    documentWishlistIds
  };
}

function isVerifiedCaptcha(parsed) {
  const normalizedTitle = parsed.title.toLowerCase();
  const normalizedText = parsed.text.toLowerCase();
  const titleSignal = normalizedTitle === 'robot check' || normalizedTitle === 'captcha';
  const phraseSignal =
    normalizedText.includes('type the characters you see') ||
    normalizedText.includes('enter the characters you see') ||
    normalizedText.includes("we just need to make sure you're not a robot");
  // A seller-controlled title and image alt can repeat the same words. Treat
  // only a real challenge form/input (optionally with its marker image) as
  // structural evidence; a standalone image is never authoritative.
  const challengeInput = parsed.root.querySelector('input#captchacharacters, input[name="captchacharacters"]');
  const challengeForm = parsed.root.querySelector('form[data-captcha-form="true"]');
  const structuralSignal = Boolean(
    challengeInput ||
    (challengeForm && challengeForm.querySelector('img[data-captcha-marker="true"]'))
  );

  return structuralSignal && (titleSignal || phraseSignal);
}

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

function parseAmazonHtml(htmlString, url) {
  const parsed = parseInertHtml(htmlString, url);
  const doc = parsed.root;
  if (isVerifiedCaptcha(parsed)) {
    throw new Error('CAPTCHA_BLOCKED');
  }
  const bodyText = parsed.text.toLowerCase();

  const data = {
    success: true,
    price: null,
    title: null,
    authors: [],
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
  data.authors = extractAuthorNames(
    doc,
    '#bylineInfo .contributorNameID, #bylineInfo .author a'
  );

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
    data.inStock = globalThis.AmazonAvailability.classifyAvailabilityText(text) === true;
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
  const parsed = parseInertHtml(htmlString, url);
  const doc = parsed.root;
  if (isVerifiedCaptcha(parsed)) {
    throw new Error('CAPTCHA_BLOCKED');
  }

  const items = [];
  // Amazon wishlists typically use li with data-itemid
  const itemElements = doc.querySelectorAll('li[data-itemid]');
  if (itemElements.length > MAX_WISHLIST_ROWS) throw new Error('WISHLIST_PAGE_TOO_LARGE');
  
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
    const authors = extractAuthorNames(
      el,
      '[id^="item-byline"] a, [class*="item-byline"] a'
    );

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
    const isUnavailable = globalThis.AmazonAvailability.classifyAvailabilityText(itemText) === false;
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
    const imgEl = el.querySelector('img[data-safe-image-url]');
    if (imgEl) {
      imageUrl = imgEl.dataset.safeImageUrl;
    }

    const purchaseStatusRoot = el.cloneNode(true);
    purchaseStatusRoot.querySelectorAll(
      'a[href*="/dp/"], [id^="item-byline"], [class*="item-byline"]'
    ).forEach((node) => node.remove());
    const purchaseStatusText = purchaseStatusRoot.textContent.toLowerCase();
    const isPurchased = purchaseStatusText.includes('purchased') ||
      purchaseStatusText.includes('gekocht') ||
      purchaseStatusText.includes('you own this item');

    // Only add if not already in our extracted list (duplicates sometimes exist)
    if (!items.find(i => i.id === asin)) {
      items.push({
        id: asin,
        title: title || 'Unknown Product',
        authors,
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
    if (!isAmazonWishlistTerminalContinuationUrl(nextHref, url)) {
      const resolved = resolveAmazonWishlistPageUrl(nextHref, url);
      if (!resolved) throw new Error('INVALID_AMAZON_URL');
      nextPageUrl = resolved.href;
    }
  }

  const requestedWishlistId = getAmazonWishlistId(url);
  const declaredWishlistIds = Array.from(doc.querySelectorAll(
    '[data-list-id], [data-listid], input[name="listId"], input#listId'
  )).map((node) => (
    node.getAttribute('data-list-id') ||
    node.getAttribute('data-listid') ||
    node.getAttribute('value') ||
    ''
  )).filter(Boolean).concat(parsed.documentWishlistIds || []);
  if (declaredWishlistIds.some((id) => id !== requestedWishlistId)) {
    throw new Error('WISHLIST_ID_MISMATCH');
  }

  const hasMatchingIdentity = declaredWishlistIds.includes(requestedWishlistId) ||
    isIdentityBoundWishlistContinuationUrl(url);
  const hasWishlistContainer = Boolean(doc.querySelector(
    '#g-items, #wishlist-page, #wl-item-view, [data-testid="wishlist-container"]'
  ));
  const hasExplicitEmptyState = Boolean(doc.querySelector(
    '#empty-list, .a-box .wl-empty-list, [data-testid="wishlist-empty"]'
  ));
  const hasValidatedRows = itemElements.length > 0 && items.length > 0 && hasMatchingIdentity;
  const hasValidatedEmptyPage = itemElements.length === 0 && hasMatchingIdentity && (hasWishlistContainer || hasExplicitEmptyState);
  const structurallyValidated = Boolean(requestedWishlistId && (hasValidatedRows || hasValidatedEmptyPage));

  return {
    items,
    nextPageUrl,
    completeness: structurallyValidated ? (nextPageUrl ? 'partial' : 'validated') : 'indeterminate'
  };
}

// Export for Jest testing in Node environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isVerifiedCaptcha,
    parseAmazonHtml,
    parseInertHtml,
    parsePrice,
    parseAmazonWishlist,
    parseWishlistPriceDrop
  };
}
