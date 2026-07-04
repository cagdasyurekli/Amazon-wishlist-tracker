import { getTrackedItems, getStorageData, formatPrice, StorageKeys, StorageArea } from '../utils/storage.js';

// The popup is a quick-glance surface: current-tab action + a few recent
// items. The full list lives in the dashboard — rendering hundreds of cards
// here made the popup unusable.
const RECENT_ITEMS_COUNT = 3;

function getAsin(url) {
  return url?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

function getWishlistId(url) {
  return url?.match(/wishlist\/ls\/([a-zA-Z0-9]+)/)?.[1] || null;
}

document.addEventListener('DOMContentLoaded', async () => {
  const countBadge = document.getElementById('item-count');
  const statusBanner = document.getElementById('status-banner');
  const tabAction = document.getElementById('tab-action');
  const addBtn = document.getElementById('add-current-tab-btn');
  const importBtn = document.getElementById('import-wishlist-btn');
  const tabStatus = document.getElementById('tab-status');
  const recentSection = document.getElementById('recent-section');
  const recentList = document.getElementById('recent-list');
  const template = document.getElementById('recent-item-template');
  const emptyState = document.getElementById('empty-state');
  const openDashboardBtn = document.getElementById('open-dashboard-btn');

  let statusTimer = null;
  function showStatus(message, type = 'info') {
    statusBanner.textContent = message;
    statusBanner.className = `status-banner status-${type} visible`;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusBanner.classList.remove('visible');
    }, 4000);
  }

  function openDashboard(query = '') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') + query });
  }

  document.getElementById('options-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('dashboard-btn').addEventListener('click', () => openDashboard());
  openDashboardBtn.addEventListener('click', () => openDashboard());

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
    emptyState.hidden = items.length !== 0;
    openDashboardBtn.textContent = items.length > 0
      ? `View All ${items.length} Items`
      : 'Open Dashboard';

    recentList.textContent = '';
    recentSection.hidden = items.length === 0;
    if (items.length === 0) return items;

    const recent = [...items]
      .sort((a, b) => (b.updatedAt || b.lastChecked || b.addedAt || 0) - (a.updatedAt || a.lastChecked || a.addedAt || 0))
      .slice(0, RECENT_ITEMS_COUNT);

    recent.forEach((item) => {
      const clone = template.content.cloneNode(true);

      const titleEl = clone.querySelector('.recent-title');
      titleEl.textContent = item.title || 'Unknown Product';
      if (item.url) {
        titleEl.href = item.url;
        titleEl.title = 'Open on Amazon';
      } else {
        titleEl.removeAttribute('href');
      }

      clone.querySelector('.recent-price').textContent = formatPrice(item.currentPrice, item.currency);

      // Change since tracking started; a drop is good news, so down = green.
      const changeEl = clone.querySelector('.price-change');
      const baseline = (historyObj[item.id] || []).find((dp) => Number.isFinite(dp.price))?.price;
      if (Number.isFinite(baseline) && Number.isFinite(item.currentPrice) && baseline > 0) {
        const pct = ((item.currentPrice - baseline) / baseline) * 100;
        if (Math.abs(pct) >= 0.5) {
          changeEl.hidden = false;
          changeEl.textContent = `${pct < 0 ? '▼' : '▲'} ${Math.abs(pct).toFixed(0)}%`;
          changeEl.className = `price-change ${pct < 0 ? 'change-down' : 'change-up'}`;
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
    if (!url.includes('amazon.')) {
      return; // Not an Amazon page: offer nothing.
    }

    const asin = getAsin(url);
    if (asin) {
      if (items.some((item) => item.id === asin)) {
        showTabStatus('✓ Already tracking this product', true);
      } else {
        addBtn.hidden = false;
        tabAction.hidden = false;
      }
      return;
    }

    const wishlistId = getWishlistId(url);
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
