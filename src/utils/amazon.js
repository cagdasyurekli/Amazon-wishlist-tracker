const AMAZON_REGISTRABLE_DOMAINS = Object.freeze([
  'amazon.com',
  'amazon.nl',
  'amazon.de',
  'amazon.fr',
  'amazon.es',
  'amazon.it',
  'amazon.co.uk'
]);

const AMAZON_IMAGE_HOSTS = new Set([
  'm.media-amazon.com',
  'images.amazon.com',
  'ecx.images-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images-fe.ssl-images-amazon.com',
  'images-cn.ssl-images-amazon.com',
  'images-jp.amazon.com'
]);

const WISHLIST_PATH_PATTERN = /\/(?:hz\/)?wishlist\/ls\/([a-z0-9_-]{1,64})(?:[/?#]|$)/i;
const PRODUCT_PATH_PATTERN = /\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:[/?#]|$)/i;
const MAX_URL_LENGTH = 2048;

function hasSupportedAmazonHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return AMAZON_REGISTRABLE_DOMAINS.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`)
  );
}

export function parseCanonicalAmazonUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !hasSupportedAmazonHostname(parsed.hostname)
    ) {
      return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

export function isCanonicalAmazonUrl(value) {
  return Boolean(parseCanonicalAmazonUrl(value));
}

export function getAmazonWishlistId(value) {
  const parsed = parseCanonicalAmazonUrl(value);
  return parsed?.pathname.match(WISHLIST_PATH_PATTERN)?.[1] || null;
}

export function parseCanonicalAmazonWishlistUrl(value) {
  const parsed = parseCanonicalAmazonUrl(value);
  return parsed && getAmazonWishlistId(parsed.href) ? parsed : null;
}

export function getAmazonAsin(value) {
  const parsed = parseCanonicalAmazonUrl(value);
  return parsed?.pathname.match(PRODUCT_PATH_PATTERN)?.[1]?.toUpperCase() || null;
}

export function parseCanonicalAmazonProductUrl(value) {
  const parsed = parseCanonicalAmazonUrl(value);
  return parsed && getAmazonAsin(parsed.href) ? parsed : null;
}

// Stored records from pre-1.1 releases may contain an otherwise valid Amazon
// product URL with the plaintext scheme. Upgrade that narrow legacy shape to a
// canonical HTTPS URL before any user-navigation sink; reject every other
// malformed, credentialed, nonstandard-port, lookalike, or ASIN-mismatched URL.
export function normalizeStoredAmazonProductUrl(value, expectedAsin) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !hasSupportedAmazonHostname(parsed.hostname)
    ) return null;
    const asin = parsed.pathname.match(PRODUCT_PATH_PATTERN)?.[1]?.toUpperCase() || null;
    if (!asin || (expectedAsin && asin !== String(expectedAsin).toUpperCase())) return null;
    return `https://${parsed.hostname.toLowerCase()}/dp/${asin}`;
  } catch (_error) {
    return null;
  }
}

export function resolveAmazonWishlistPageUrl(value, baseUrl) {
  try {
    const resolved = new URL(value, baseUrl);
    const parsed = parseCanonicalAmazonWishlistUrl(resolved.href);
    if (!parsed) return null;

    const expectedId = getAmazonWishlistId(baseUrl);
    return expectedId && getAmazonWishlistId(parsed.href) === expectedId ? parsed : null;
  } catch (_error) {
    return null;
  }
}

export function sanitizeAmazonImageUrl(value, baseUrl) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return '';

  try {
    const parsed = new URL(value, baseUrl);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !AMAZON_IMAGE_HOSTS.has(parsed.hostname.toLowerCase()) ||
      !parsed.pathname.includes('/images/I/')
    ) {
      return '';
    }
    parsed.hash = '';
    return parsed.href;
  } catch (_error) {
    return '';
  }
}

export { AMAZON_REGISTRABLE_DOMAINS, AMAZON_IMAGE_HOSTS, MAX_URL_LENGTH };
