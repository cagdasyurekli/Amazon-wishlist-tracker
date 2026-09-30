import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alertBaselinePrice,
  effectiveTargetDiscount,
  meetsAlertCondition,
  trackingDiscountPercent
} from '../utils/alerts.mjs';

test('inflated list price does not count as a discount (badge said 4, popup said 3)', () => {
  // Real report: 61.8% below the strike-through price, only 39.7% below the when-added price.
  const item = { currentPrice: 5.53, originalPrice: 14.49, wishlistPriceWhenAdded: 9.17, targetDiscountPercentage: 60 };
  assert.ok(Math.abs(trackingDiscountPercent(item) - 39.7) < 0.1);
  assert.equal(meetsAlertCondition(item), false);
});

test('baseline prefers when-added, then tracking start, then original price', () => {
  assert.equal(alertBaselinePrice({ wishlistPriceWhenAdded: 9, trackingStartPrice: 10, originalPrice: 20 }), 9);
  assert.equal(alertBaselinePrice({ trackingStartPrice: 10, originalPrice: 20 }), 10);
  assert.equal(alertBaselinePrice({ originalPrice: 20 }), 20);
  assert.equal(alertBaselinePrice({ originalPrice: 0 }), null);
});

test('native wishlist drop is used only when the computed drop is not positive', () => {
  assert.equal(trackingDiscountPercent({ currentPrice: 10, wishlistPriceDropPercent: 25 }), 25);
  assert.equal(trackingDiscountPercent({ currentPrice: 5, wishlistPriceWhenAdded: 10, wishlistPriceDropPercent: 25 }), 50);
});

test('default discount applies only when the item has no own threshold', () => {
  assert.equal(effectiveTargetDiscount({ targetDiscountPercentage: 30 }, 60), 30);
  assert.equal(effectiveTargetDiscount({}, 60), 60);
  assert.equal(effectiveTargetDiscount({}, undefined), null);
  const item = { currentPrice: 5, wishlistPriceWhenAdded: 10 };
  assert.equal(meetsAlertCondition(item, 50), true);
  assert.equal(meetsAlertCondition(item, 51), false);
  assert.equal(meetsAlertCondition(item), false);
});

test('target price, purchased and unpriced items', () => {
  assert.equal(meetsAlertCondition({ currentPrice: 8, targetPrice: 8 }), true);
  assert.equal(meetsAlertCondition({ currentPrice: 8.01, targetPrice: 8 }), false);
  assert.equal(meetsAlertCondition({ currentPrice: 8, targetPrice: 8, isPurchased: true }), false);
  assert.equal(meetsAlertCondition({ currentPrice: null, targetPrice: 8 }), false);
});
