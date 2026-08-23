// Kept dependency-free so the scheduler and unit tests share the exact policy.
// This file is loaded as an ES module by the service worker and as CommonJS by
// Jest; it intentionally uses a small global bridge rather than runtime APIs.
const WISHLIST_BACKOFF_ERRORS = new Set(['CAPTCHA_BLOCKED', 'RATE_LIMITED']);

function getPartialWishlistDisposition(result) {
  const preservesResumeState = Boolean(
    result?.success &&
    result.complete === false &&
    result.nextPageUrl
  );
  return {
    preservesResumeState,
    activatesBackoff: preservesResumeState && WISHLIST_BACKOFF_ERRORS.has(result?.error)
  };
}

const wishlistPartialPolicy = { getPartialWishlistDisposition };

if (typeof globalThis !== 'undefined') globalThis.wishlistPartialPolicy = wishlistPartialPolicy;
if (typeof module !== 'undefined') module.exports = wishlistPartialPolicy;
