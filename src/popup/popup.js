import { getTrackedItems, getStorageData, formatPrice, StorageKeys, StorageArea } from '../utils/storage.js';
import {
  getAmazonAsin,
  getAmazonWishlistId,
  normalizeStoredAmazonProductUrl,
  parseCanonicalAmazonUrl
} from '../utils/amazon.js';

// The popup is a quick-glance surface: current-tab action + a few recent
// items. The full list lives in the dashboard — rendering hundreds of cards
// here made the popup unusable.
const RECENT_ITEMS_COUNT = 3;

function getTrackingBaseline(item, historyPoints) {
  if (Number.isFinite(item.trackingStartPrice)) {
    return {
      price: item.trackingStartPrice,
      timestamp: Number.isFinite(item.trackingStartedAt) ? item.trackingStartedAt : item.addedAt,
      exact: item.trackingBaselineExact === true
    };
  }
  const firstRetained = (Array.isArray(historyPoints) ? historyPoints : [])
    .filter((point) => Number.isFinite(point?.price) && Number.isFinite(point?.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  return firstRetained
    ? { price: firstRetained.price, timestamp: firstRetained.timestamp, exact: false }
    : null;
}

document.addEventListener('DOMContentLoaded', async () => {
  const countBadge = document.getElementById('item-count');
  const statusBanner = document.getElementById('status-banner');
  const tabAction = document.getElementById('tab-action');
  const addBtn = document.getElementById('add-current-tab-btn');
  const importBtn = document.getElementById('import-wishlist-btn');
  const tabStatus = document.getElementById('tab-status');
  const recentSection = document.getElementById('recent-section');
  const baselineNote = document.getElementById('baseline-note');
  const recentList = document.getElementById('recent-list');
  const template = document.getElementById('recent-item-template');
  const emptyState = document.getElementById('empty-state');
  const openDashboardBtn = document.getElementById('open-dashboard-btn');
  const targetReachedBtn = document.getElementById('target-reached-btn');

  let statusTimer = null;
  function showStatus(message, type = 'info') {
    statusBanner.textContent = message;
    statusBanner.className = `status-banner status-${type} visible`;
    clearTimeout(statusTimer);
    if (type !== 'error') {
      statusTimer = setTimeout(() => {
        statusBanner.classList.remove('visible');
      }, 4000);
    }
  }

  function openDashboard(query = '') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') + query });
  }

  document.getElementById('options-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('dashboard-btn').addEventListener('click', () => openDashboard());
  openDashboardBtn.addEventListener('click', () => openDashboard());
  targetReachedBtn.addEventListener('click', () => openDashboard('?filter=targetReached'));

  function showTabStatus(message, isPositive) {
    addBtn.hidden = true;
    importBtn.hidden = true;
    tabStatus.textContent = message;
    tabStatus.classList.toggle('positive', Boolean(isPositive));
    tabStatus.hidden = false;
    tabAction.hidden = false;
  }

  async function renderSummary() {
    const [items, history] = await Promise.all([
      getTrackedItems(),
      getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL)
    ]);
    const historyObj = history || {};

    countBadge.hidden = items.length === 0;
    countBadge.textContent = items.length;
    countBadge.setAttribute('aria-label', `${items.length} tracked item${items.length === 1 ? '' : 's'}`);
    emptyState.hidden = items.length !== 0;
    openDashboardBtn.textContent = items.length > 0
      ? `View All ${items.length} Items`
      : 'Open Dashboard';

    recentList.textContent = '';
    recentSection.hidden = items.length === 0;
    const targetReachedCount = items.filter((item) => {
      const baseline = Number.isFinite(item.wishlistPriceWhenAdded)
        ? item.wishlistPriceWhenAdded
        : Number.isFinite(item.originalPrice)
          ? item.originalPrice
          : null;
      const targetPriceReached = Number.isFinite(item.targetPrice) && Number.isFinite(item.currentPrice) && item.currentPrice <= item.targetPrice;
      let discount = Number.isFinite(baseline) && baseline > 0 && Number.isFinite(item.currentPrice)
        ? ((baseline - item.currentPrice) / baseline) * 100
        : 0;
      if (discount <= 0 && item.wishlistPriceDropPercent > 0) discount = item.wishlistPriceDropPercent;
      const discountReached = Number.isFinite(item.targetDiscountPercentage) && discount >= item.targetDiscountPercentage;
      return targetPriceReached || discountReached;
    }).length;
    targetReachedBtn.hidden = targetReachedCount === 0;
    targetReachedBtn.textContent = `View ${targetReachedCount} Target-Reached Item${targetReachedCount === 1 ? '' : 's'}`;
    if (items.length === 0) {
      baselineNote.hidden = true;
      return items;
    }

    const recent = [...items]
      .map(item => {
        const trackingBaseline = getTrackingBaseline(item, historyObj[item.id]);
        const baseline = trackingBaseline?.price;
        let discount = 0;
        if (Number.isFinite(baseline) && Number.isFinite(item.currentPrice) && baseline > 0) {
          discount = ((baseline - item.currentPrice) / baseline) * 100;
        }
        // Fallback to wishlist drop percent if available
        if (discount <= 0 && item.wishlistPriceDropPercent > 0) {
          discount = item.wishlistPriceDropPercent;
        }
        return { ...item, _discount: discount, _trackingBaseline: trackingBaseline };
      })
      .sort((a, b) => {
        if (Math.abs(b._discount - a._discount) > 0.1) {
          return b._discount - a._discount;
        }
        return (b.updatedAt || b.lastChecked || b.addedAt || 0) - (a.updatedAt || a.lastChecked || a.addedAt || 0);
      })
      .slice(0, RECENT_ITEMS_COUNT);

    const comparedItems = recent.filter((item) => item._trackingBaseline);
    baselineNote.hidden = comparedItems.length === 0;
    baselineNote.textContent = comparedItems.some((item) => !item._trackingBaseline.exact)
      ? 'Changes use the earliest retained sample when the tracking-start baseline is unavailable.'
      : 'Changes are measured since tracking started.';

    recent.forEach((item) => {
      const clone = template.content.cloneNode(true);

      const titleEl = clone.querySelector('.recent-title');
      titleEl.textContent = item.title || 'Unknown Product';
      const productUrl = normalizeStoredAmazonProductUrl(item.url, item.id);
      if (productUrl) {
        titleEl.href = productUrl;
        titleEl.title = 'Open on Amazon';
      } else {
        titleEl.removeAttribute('href');
      }

      clone.querySelector('.recent-price').textContent = formatPrice(item.currentPrice, item.currency);

      // Change since tracking started; a drop is good news, so down = green.
      const changeEl = clone.querySelector('.price-change');
      const baseline = item._trackingBaseline?.price;
      if (Number.isFinite(baseline) && Number.isFinite(item.currentPrice) && baseline > 0) {
        const pct = ((item.currentPrice - baseline) / baseline) * 100;
        if (Math.abs(pct) >= 0.5) {
          changeEl.hidden = false;
          changeEl.textContent = `${pct < 0 ? '▼' : '▲'} ${Math.abs(pct).toFixed(0)}%`;
          changeEl.className = `price-change ${pct < 0 ? 'change-down' : 'change-up'}`;
          const baselineTimestamp = item._trackingBaseline?.timestamp;
          if (item._trackingBaseline?.exact) {
            changeEl.title = Number.isFinite(baselineTimestamp)
              ? `Since tracking started on ${new Date(baselineTimestamp).toLocaleDateString()}`
              : 'Since tracking started';
          } else {
            changeEl.title = Number.isFinite(baselineTimestamp)
              ? `Since earliest retained sample on ${new Date(baselineTimestamp).toLocaleDateString()}`
              : 'Since earliest retained sample';
          }
        }
      }

      recentList.appendChild(clone);
    });

    return items;
  }

  const items = await renderSummary();
  const wishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];
  const trackedWishlistIds = wishlists
    .map((w) => (typeof w === 'string' ? w : w.id))
    .filter(Boolean);

  // Decide what (if anything) to offer for the current tab. Never offer to
  // track a non-Amazon page, an already-tracked product, or a tracked list.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || '';
    if (!parseCanonicalAmazonUrl(url)) {
      return; // Not an Amazon page: offer nothing.
    }

    const asin = getAmazonAsin(url);
    if (asin) {
      if (items.some((item) => item.id === asin)) {
        showTabStatus('✓ Already tracking this product', true);
      } else {
        addBtn.hidden = false;
        tabAction.hidden = false;
      }
      return;
    }

    const wishlistId = getAmazonWishlistId(url);
    if (wishlistId) {
      if (trackedWishlistIds.includes(wishlistId)) {
        showTabStatus('✓ This wishlist is already tracked', true);
      } else {
        importBtn.hidden = false;
        tabAction.hidden = false;
        importBtn.addEventListener('click', () => {
          // The dashboard auto-starts the import when given ?import=<url>.
          openDashboard(`?import=${encodeURIComponent(url)}`);
          window.close();
        });
      }
      return;
    }

    showTabStatus('Open a product or wishlist page to track it', false);
  });

  addBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab?.id) return;

      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      chrome.tabs.sendMessage(activeTab.id, { type: 'TRACK_CURRENT_PAGE' }, async (response) => {
        addBtn.disabled = false;
        addBtn.textContent = 'Track This Product';

        if (chrome.runtime.lastError) {
          // Content script not present (e.g. page opened before install).
          showStatus('Couldn’t reach the page. Reload the Amazon tab and try again.', 'error');
          return;
        }

        if (response?.success) {
          showStatus('Added to your tracker.', 'success');
          await renderSummary();
          showTabStatus('✓ Already tracking this product', true);
        } else if (response?.exists) {
          showStatus('You’re already tracking this item.', 'info');
          showTabStatus('✓ Already tracking this product', true);
        } else {
          showStatus('Couldn’t track this item. Try the button on the page.', 'error');
        }
      });
    });
  });
});
