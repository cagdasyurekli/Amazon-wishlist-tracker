// Single definition of "this item meets its alert condition", shared by the toolbar
// badge, discount notifications, the popup target-reached link, and the dashboard filter.
// Pure helpers, no chrome.* access, so they stay unit-testable.

// Discounts are measured against the price when tracking started, never against
// Amazon's strike-through list price: list prices are often inflated, which made an
// item count as "60% off" when it had only dropped 40% since it was added.
export function alertBaselinePrice(item) {
  for (const price of [item?.wishlistPriceWhenAdded, item?.trackingStartPrice, item?.originalPrice]) {
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

export function trackingDiscountPercent(item) {
  const baseline = alertBaselinePrice(item);
  let discount = baseline && Number.isFinite(item?.currentPrice)
    ? ((baseline - item.currentPrice) / baseline) * 100
    : 0;
  // Amazon's native wishlist drop is relative to the same when-added price.
  if (discount <= 0 && item?.wishlistPriceDropPercent > 0) discount = item.wishlistPriceDropPercent;
  return discount;
}

export function effectiveTargetDiscount(item, defaultDiscount) {
  if (Number.isFinite(item?.targetDiscountPercentage) && item.targetDiscountPercentage > 0) {
    return item.targetDiscountPercentage;
  }
  const fallback = Number(defaultDiscount);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

export function meetsAlertCondition(item, defaultDiscount) {
  if (!item || item.isPurchased || !Number.isFinite(item.currentPrice) || item.currentPrice <= 0) return false;
  if (Number.isFinite(item.targetPrice) && item.targetPrice > 0 && item.currentPrice <= item.targetPrice) return true;
  const target = effectiveTargetDiscount(item, defaultDiscount);
  return target != null && trackingDiscountPercent(item) >= target;
}
