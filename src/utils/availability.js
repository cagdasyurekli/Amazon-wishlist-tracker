(function exposeAmazonAvailability(root, factory) {
  const api = factory();
  root.AmazonAvailability = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(globalThis, () => {
  const NEGATIVE_PHRASES = Object.freeze([
    // English
    'unavailable',
    'not available',
    'not currently available',
    'not in stock',
    'out of stock',
    'available from',
    'cannot be shipped',
    'see all buying options',
    'no longer available',
    // Dutch
    'niet beschikbaar',
    'momenteel niet beschikbaar',
    'niet op voorraad',
    // German
    'derzeit nicht verfügbar',
    'nicht verfügbar',
    'nicht auf lager',
    // French
    'actuellement indisponible',
    'indisponible',
    'rupture de stock',
    // Spanish
    'actualmente no disponible',
    'no disponible',
    'agotado',
    // Italian
    'attualmente non disponibile',
    'non disponibile',
    'esaurito',
    // Turkish
    'şu anda mevcut değil',
    'mevcut değil',
    'geçici olarak stokta yok',
    'stokta yok',
    'stokta değil'
  ]);

  const POSITIVE_PHRASES = Object.freeze([
    // English
    'in stock',
    'available',
    'usually ships',
    'ships within',
    // Dutch
    'op voorraad',
    // German
    'auf lager',
    // French
    'en stock',
    // Spanish
    'en stock',
    'disponible',
    // Italian
    'disponibile',
    'disponibilità immediata',
    // Turkish
    'stokta var',
    'stokta sadece',
    'kargoya verilir'
  ]);

  const PURCHASED_PHRASES = Object.freeze([
    // English
    'purchased',
    'you own this item',
    // Dutch
    'gekocht',
    'je hebt dit item gekocht',
    // German
    'gekauft',
    'sie besitzen diesen artikel',
    // French
    'acheté',
    'achete',
    'vous possédez cet article',
    // Spanish
    'comprado',
    'ya tienes este artículo',
    // Italian
    'acquistato',
    'possiedi questo articolo',
    // Turkish
    'satın alındı',
    'bu ürüne sahipsiniz'
  ]);

  const MAX_PRODUCT_AUTHORS = 20;
  const MAX_AUTHOR_LENGTH = 160;
  const PRICE_TOKEN_SOURCE =
    '(?:[€$£¥₺]\\s*\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?|\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?\\s*(?:TL|[€$£¥₺])|[€$£¥₺]?\\s*\\d{1,3}(?:[.,]\\d{3})*(?:[.,]\\d{1,2})?)';

  const DROP_PERCENT_PATTERNS = Object.freeze([
    /price\s+dropped\s+(\d{1,3})\s*%/i,
    /prijs\s+(?:is\s+)?(?:met\s+)?(\d{1,3})\s*%\s+gedaald/i,
    /preis(?:reduzierung)?(?:\s+um)?\s+(\d{1,3})\s*%\s*(?:gesunken|reduziert)?/i,
    /prix\s+en\s+baisse\s+de\s+(\d{1,3})\s*%/i,
    /el\s+precio\s+(?:ha\s+)?baj[oó]\s+(?:un\s+)?(\d{1,3})\s*%/i,
    /prezzo\s+sceso\s+del\s+(\d{1,3})\s*%/i,
    /fiyat[ıi]?\s*%\s*(\d{1,3})\s*d[üu][şs]t[üu]/i,
    /%\s*(\d{1,3})\s*fiyat\s+d[üu][şs][üu][şs][üu]/i
  ]);

  const WAS_WHEN_ADDED_PATTERNS = Object.freeze([
    new RegExp(`\\(\\s*(?:was|van|war|était|etait|era)\\s*(${PRICE_TOKEN_SOURCE})\\s*(?:when\\s+added(?:\\s+to\\s+list)?|bij\\s+toevoegen|beim\\s+hinzufügen|lors\\s+de\\s+l['’]ajout|al\\s+a[ñn]adirlo|al\\s+momento\\s+dell['’]aggiunta)[^)]*\\)`, 'i'),
    new RegExp(`\\(\\s*listeye\\s+eklendi[ğg]inde\\s*(${PRICE_TOKEN_SOURCE})(?:\\s*idi)?\\s*\\)`, 'i')
  ]);

  const WAS_FALLBACK_PATTERN = new RegExp(
    `(?:\\b(?:was|van|war|était|etait|era|eski\\s+fiyat[ıi]?)\\s*)(${PRICE_TOKEN_SOURCE})`,
    'i'
  );

  function normalizeAvailabilityText(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function classifyAvailabilityText(value) {
    const text = normalizeAvailabilityText(value);
    if (!text) return null;
    if (NEGATIVE_PHRASES.some((phrase) => text.includes(phrase))) return false;
    if (POSITIVE_PHRASES.some((phrase) => text.includes(phrase))) return true;
    return null;
  }

  function classifyPurchasedText(value) {
    const text = normalizeAvailabilityText(value);
    if (!text) return false;
    return PURCHASED_PHRASES.some((phrase) => text.includes(phrase));
  }

  function parsePrice(rawText) {
    if (!rawText) return null;
    const cleaned = String(rawText).replace(/[^\d.,]/g, '');
    if (!cleaned) return null;

    const decimalMatch = cleaned.match(/([.,])(\d{1,2})$/);
    let normalized;
    if (decimalMatch) {
      const decimalSep = decimalMatch[1];
      const thousandsSep = decimalSep === '.' ? ',' : '.';
      normalized = cleaned.split(thousandsSep).join('').replace(decimalSep, '.');
    } else {
      normalized = cleaned.replace(/[.,]/g, '');
    }

    const value = parseFloat(normalized);
    return Number.isNaN(value) ? null : value;
  }

  function extractCurrency(rawText) {
    if (!rawText) return null;
    const text = String(rawText);
    const symbol = text.match(/[$€£¥₺]/)?.[0];
    if (symbol) return symbol;
    return /(?:^|[\d.,\s])TL(?:[\d.,\s)]|$)/i.test(text) ? '₺' : null;
  }

  function extractAuthorNames(root, selector, maxAuthors = MAX_PRODUCT_AUTHORS, maxLength = MAX_AUTHOR_LENGTH) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return [...new Set(Array.from(root.querySelectorAll(selector))
      .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((name) => name && name.length <= maxLength))]
      .slice(0, maxAuthors);
  }

  function parseWishlistPriceDrop(text, currentPrice) {
    if (!text) return null;
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    let dropMatch = null;
    for (const pattern of DROP_PERCENT_PATTERNS) {
      dropMatch = normalized.match(pattern);
      if (dropMatch) break;
    }
    let wasMatch = null;
    for (const pattern of WAS_WHEN_ADDED_PATTERNS) {
      wasMatch = normalized.match(pattern);
      if (wasMatch) break;
    }
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

  function extractWishlistWasPrice(text) {
    if (!text) return null;
    const match = String(text).match(WAS_FALLBACK_PATTERN);
    return match ? parsePrice(match[1]) : null;
  }

  return Object.freeze({
    classifyAvailabilityText,
    classifyPurchasedText,
    extractAuthorNames,
    extractCurrency,
    extractWishlistWasPrice,
    normalizeAvailabilityText,
    parsePrice,
    parseWishlistPriceDrop
  });
});
