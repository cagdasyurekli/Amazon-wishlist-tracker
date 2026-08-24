const { getPartialWishlistDisposition } = require('../background/wishlist_partial_policy.js');

describe('partial wishlist scrape disposition', () => {
  it.each(['CAPTCHA_BLOCKED', 'RATE_LIMITED'])(
    'preserves the resume cursor and activates global backoff after a later %s page',
    (error) => {
      expect(getPartialWishlistDisposition({
        success: true,
        complete: false,
        nextPageUrl: 'https://www.amazon.com/hz/wishlist/next',
        error
      })).toEqual({ preservesResumeState: true, activatesBackoff: true });
    }
  );

  it('does not clear or activate backoff for an ordinary resumable page limit', () => {
    expect(getPartialWishlistDisposition({
      success: true,
      complete: false,
      nextPageUrl: 'https://www.amazon.com/hz/wishlist/next'
    })).toEqual({ preservesResumeState: true, activatesBackoff: false });
  });

  it('does not treat a failed first page as resumable partial success', () => {
    expect(getPartialWishlistDisposition({
      success: false,
      error: 'CAPTCHA_BLOCKED'
    })).toEqual({ preservesResumeState: false, activatesBackoff: false });
  });
});
