export async function extractWishlistWithVisibleFallback({
  readBackground,
  readVisible,
  historyGeneration = 0
}) {
  const backgroundResponse = await readBackground();
  if (backgroundResponse?.success && backgroundResponse.items?.length) {
    return backgroundResponse;
  }

  const visibleResponse = await readVisible();
  if (visibleResponse?.success && visibleResponse.items?.length) {
    return {
      ...visibleResponse,
      complete: false,
      limited: true,
      stopReason: 'visible_partial',
      error: backgroundResponse?.error || null,
      paused: backgroundResponse?.paused === true,
      backoffUntil: backgroundResponse?.backoffUntil || null,
      historyGeneration: backgroundResponse?.historyGeneration || historyGeneration
    };
  }

  return backgroundResponse || { error: 'Wishlist extraction failed.' };
}
