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
    'esaurito'
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
    'disponibilità immediata'
  ]);

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

  return Object.freeze({
    classifyAvailabilityText,
    normalizeAvailabilityText
  });
});
