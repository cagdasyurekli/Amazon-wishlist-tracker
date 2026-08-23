import { getTrackedItems, getStorageData, setStorageData, formatPrice, StorageKeys, StorageArea } from '../utils/storage.js';

document.addEventListener('DOMContentLoaded', async () => {
  const itemList = document.getElementById('item-list');
  const emptyState = document.getElementById('empty-state');
  const template = document.getElementById('item-template');
  const optionsBtn = document.getElementById('options-btn');
  const addBtn = document.getElementById('add-current-tab-btn');
  const trackWishlistTabBtn = document.getElementById('track-wishlist-tab-btn');
  const viewPriceHistoryBtn = document.getElementById('view-price-history-btn');
  const viewTrackedWishlistBtn = document.getElementById('view-tracked-wishlist-btn');
  const statusBanner = document.getElementById('status-banner');
  const itemSearchInput = document.getElementById('item-search-input');
  const nextChecksSummary = document.getElementById('next-checks-summary');
  const dashboardRecovery = document.getElementById('dashboard-recovery');
  const dashboardRecoveryMessage = document.getElementById('dashboard-recovery-message');
  const retryDashboardLoadBtn = document.getElementById('retry-dashboard-load');
  const legacyTargetWarning = document.getElementById('legacy-target-warning');
  const legacyTargetOpenOptionsBtn = document.getElementById('legacy-target-open-options-btn');

  let statusTimer = null;
  function sendBackgroundMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { error: 'No response from background worker' });
      });
    });
  }

  async function updateTrackedItem(item) {
    const response = await sendBackgroundMessage({ type: 'UPDATE_TRACKED_ITEM', item });
    if (!response.success) throw new Error(response.error || 'Failed to update item');
  }

  async function deleteTrackedItem(id) {
    const response = await sendBackgroundMessage({ type: 'REMOVE_TRACKED_ITEM', id });
    if (!response.success) throw new Error(response.error || 'Failed to remove item');
  }

  function showStatus(message, type = 'info') {
    if (!statusBanner) return;
    statusBanner.textContent = message;
    statusBanner.className = `status-banner status-${type} visible`;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusBanner.classList.remove('visible');
    }, 4000);
  }

  function showDashboardRecovery(message = 'Dashboard data could not be loaded. Your saved tracking data was not changed.') {
    if (dashboardRecoveryMessage) dashboardRecoveryMessage.textContent = message;
    if (dashboardRecovery) dashboardRecovery.hidden = false;
  }

  function hideDashboardRecovery() {
    if (dashboardRecovery) dashboardRecovery.hidden = true;
  }

  function renderLegacyTargetWarning() {
    if (!legacyTargetWarning) return;
    legacyTargetWarning.hidden = !Object.hasOwn(settings, 'defaultTargetPrice');
  }

  function hideLegacyTargetWarning() {
    if (legacyTargetWarning) legacyTargetWarning.hidden = true;
  }

  function getPriceDropDetails(item) {
    const whenAddedPrice = Number.isFinite(item.wishlistPriceWhenAdded)
      ? item.wishlistPriceWhenAdded
      : item.originalPrice;
    const currentPrice = item.currentPrice;
    const hasNativeWishlistDrop =
      item.wishlistPriceDropPercent != null ||
      Number.isFinite(item.wishlistPriceDropAmount) ||
      Boolean(item.wishlistPriceDropText);
    const hasComputedDrop =
      Number.isFinite(whenAddedPrice) &&
      Number.isFinite(currentPrice) &&
      whenAddedPrice > currentPrice;

    if (!Number.isFinite(whenAddedPrice) || (!hasNativeWishlistDrop && !hasComputedDrop)) {
      return null;
    }

    const amount = Number.isFinite(item.wishlistPriceDropAmount)
      ? item.wishlistPriceDropAmount
      : hasComputedDrop
        ? Math.round((whenAddedPrice - currentPrice) * 100) / 100
        : null;
    const percent = item.wishlistPriceDropPercent != null
      ? item.wishlistPriceDropPercent
      : Number.isFinite(amount) && whenAddedPrice > 0
        ? Math.round((amount / whenAddedPrice) * 100)
        : null;

    if (percent == null && !Number.isFinite(amount)) {
      return null;
    }

    return { amount, percent, whenAddedPrice };
  }

  function formatPriceDropBadge(drop, currency) {
    const detailParts = [];
    if (drop.percent != null) detailParts.push(`${drop.percent}%`);
    if (Number.isFinite(drop.amount)) detailParts.push(formatPrice(drop.amount, currency));
    return `Price dropped ${detailParts.join(' / ')}`;
  }

  function formatPriceDropSummary(item) {
    const drop = getPriceDropDetails(item);
    if (!drop) return '';
    return `${formatPriceDropBadge(drop, item.currency)} (was ${formatPrice(drop.whenAddedPrice, item.currency)} when added to List)`;
  }

  function setButtonProgress(buttonEl, message, statusType = 'info') {
    if (buttonEl) buttonEl.textContent = message;
    showStatus(message, statusType);
  }

  function debounce(fn, delay = 120) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function setEmptyState(title, detail) {
    const lines = emptyState.querySelectorAll('p');
    if (lines[0]) lines[0].textContent = title;
    if (lines[1]) lines[1].textContent = detail;
  }

  function itemMatchesQuery(item, query) {
    if (!query) return true;
    const searchable = [
      item.id,
      item.title,
      item.inStock ? 'in stock' : 'out of stock',
      item.targetPrice ? 'target set' : 'no target set',
      item.isPriority ? 'priority' : '',
      item.currentPrice,
      item.targetPrice
    ].filter(value => value != null).join(' ').toLowerCase();
    return searchable.includes(query);
  }

  function itemMatchesFilter(item, filter) {
    if (!filter || filter === 'all') return true;
    if (filter === 'drops') return Boolean(getPriceDropDetails(item));
    if (filter === 'priority') return Boolean(item.isPriority);
    if (filter === 'outOfStock') return item.inStock === false;
    if (filter === 'unchecked') return !item.lastChecked;
    if (filter === 'targetReached') {
      const priceReached = Number.isFinite(item.targetPrice) && Number.isFinite(item.currentPrice) && item.currentPrice <= item.targetPrice;
      const discount = getPriceDropDetails(item)?.percent || 0;
      const discountReached = Number.isFinite(item.targetDiscountPercentage) && discount >= item.targetDiscountPercentage;
      return priceReached || discountReached;
    }
    return true;
  }

  function getAlarm(name) {
    return new Promise((resolve) => {
      if (!chrome.alarms?.get) {
        resolve(null);
        return;
      }

      chrome.alarms.get(name, (alarm) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(alarm || null);
      });
    });
  }

  async function renderNextCheckSchedule() {
    if (!nextChecksSummary) return;

    const [priceAlarm, priorityAlarm, wishlistAlarm, trackedItems] = await Promise.all([
      getAlarm('checkPricesAlarm'),
      getAlarm('checkPriorityPricesAlarm'),
      getAlarm('checkWishlistsAlarm'),
      getTrackedItems()
    ]);

    nextChecksSummary.innerHTML = '';
    [
      ['Next price batch', priceAlarm?.scheduledTime],
      ['Priority check', priorityAlarm?.scheduledTime],
      ['Wishlist sync', wishlistAlarm?.scheduledTime]
    ].forEach(([label, scheduledTime]) => {
      const chip = document.createElement('span');
      chip.textContent = `${label}: ${formatTimeOnly(scheduledTime)}`;
      nextChecksSummary.appendChild(chip);
    });
    const standardItems = trackedItems.filter(item => !item.isPriority);
    const dueCount = standardItems.filter(item =>
      !Number.isFinite(item.nextPriceCheckAt) || item.nextPriceCheckAt <= Date.now()
    ).length;
    const standardCount = standardItems.length;
    if (standardCount > 0) {
      const queueChip = document.createElement('span');
      queueChip.textContent = `Standard price checks: ${dueCount} due · up to 8 per batch`;
      nextChecksSummary.appendChild(queueChip);
    }
  }

  optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  legacyTargetOpenOptionsBtn?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  const sortSelect = document.getElementById('sort-select');
  const filterSelect = document.getElementById('filter-select');
  const PAGE_SIZE = 50;
  let visibleItemLimit = PAGE_SIZE;
  
  let settings = {};
  let scheduleRefreshTimer = null;

  async function loadDashboardSettings() {
    settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
    renderLegacyTargetWarning();
    if (sortSelect && settings.dashboardSort) {
      const savedSortExists = Array.from(sortSelect.options).some(option => option.value === settings.dashboardSort);
      if (savedSortExists) sortSelect.value = settings.dashboardSort;
    }
    if (filterSelect && settings.dashboardFilter) {
      const savedFilterExists = Array.from(filterSelect.options).some(option => option.value === settings.dashboardFilter);
      if (savedFilterExists) filterSelect.value = settings.dashboardFilter;
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === StorageArea.SYNC && changes[StorageKeys.SETTINGS]) {
      settings = changes[StorageKeys.SETTINGS].newValue || {};
      renderLegacyTargetWarning();
    }
  });

  const toggleAllChartsBtn = document.getElementById('toggle-all-charts-btn');
  const appContainer = document.querySelector('.app-container');
  toggleAllChartsBtn.addEventListener('click', () => {
    const isActive = appContainer.classList.toggle('show-all-charts');
    toggleAllChartsBtn.textContent = isActive ? 'Hide All Charts' : 'Show All Charts';
    renderItems();
  });

  // Conditionally show tracking buttons based on the current page or an open wishlist tab.
  chrome.tabs.query({}, async (tabs) => {
    try {
      const activeTab = tabs.find(tab => tab.active && tab.currentWindow) || tabs[0];
      const isHttp = activeTab?.url?.startsWith('http');
      const isAmazonProduct = isHttp && activeTab?.url?.includes('amazon.') && (activeTab.url.includes('/dp/') || activeTab.url.includes('/gp/product/'));
      const isActiveAmazonWishlist = isHttp && activeTab?.url?.includes('amazon.') && activeTab.url.includes('wishlist');

      const items = await getTrackedItems();
      const trackedWishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];

      if (isAmazonProduct) {
      const asinMatch = activeTab.url.match(/\/(?:dp|gp\/product)\/([a-zA-Z0-9]{10})/);
      const asin = asinMatch ? asinMatch[1] : null;
      
      if (asin && items.some(item => item.id === asin)) {
        addBtn.style.display = 'none';
        if (viewPriceHistoryBtn) {
          viewPriceHistoryBtn.style.display = 'block';
          viewPriceHistoryBtn.dataset.asin = asin;
        }
      } else {
        // Not tracked yet
        addBtn.style.display = 'block';
      }
      } else {
      addBtn.style.display = 'none';
    }

      const dashboardImportUrl = new URLSearchParams(window.location.search).get('import') || '';
      const openWishlistTabs = tabs.filter(tab => {
      const tabUrl = tab?.url || '';
      return tabUrl.startsWith('http') && tabUrl.includes('amazon.') && tabUrl.includes('wishlist');
    });
      const trackedWishlistIds = trackedWishlists.map(w => typeof w === 'string' ? w : w.id).filter(Boolean);
      const trackedOpenWishlist = openWishlistTabs.find(tab => trackedWishlistIds.includes(getWishlistId(tab.url)));
      const wishlistUrl = isActiveAmazonWishlist
      ? activeTab.url
      : (dashboardImportUrl.includes('amazon.') && dashboardImportUrl.includes('wishlist') ? dashboardImportUrl : trackedOpenWishlist?.url);
      const wishlistId = getWishlistId(wishlistUrl);
      const wishlistInputGroup = document.querySelector('.wishlist-import-group');

      if (wishlistUrl && trackWishlistTabBtn) {
      const isWishlistTracked = trackedWishlistIds.includes(wishlistId);
      const wishlistInput = document.getElementById('wishlist-url-input');
      if (wishlistInput) wishlistInput.value = wishlistUrl;

      if (isWishlistTracked) {
        trackWishlistTabBtn.style.display = 'none';
        if (viewTrackedWishlistBtn) {
          viewTrackedWishlistBtn.textContent = 'Sync Wishlist Now';
          viewTrackedWishlistBtn.dataset.wishlistUrl = wishlistUrl;
          viewTrackedWishlistBtn.style.display = 'block';
        }
        if (wishlistInputGroup) wishlistInputGroup.style.display = 'none';
      } else {
        trackWishlistTabBtn.style.display = 'block';
        if (viewTrackedWishlistBtn) viewTrackedWishlistBtn.style.display = 'none';
        if (wishlistInputGroup) wishlistInputGroup.style.display = 'none';
      }
      } else {
      // If we aren't even on an Amazon page, show the manual import group
      if (trackWishlistTabBtn) trackWishlistTabBtn.style.display = 'none';
      if (viewTrackedWishlistBtn) viewTrackedWishlistBtn.style.display = 'none';
      if (wishlistInputGroup) wishlistInputGroup.style.display = 'flex';
      }
    } catch (_error) {
      showDashboardRecovery();
    }
  });

  addBtn.addEventListener('click', async () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (activeTab?.url?.includes('amazon.')) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'TRACK_CURRENT_PAGE' }, (response) => {
          if (chrome.runtime.lastError) {
            alert("Could not communicate with the page. Please reload the Amazon tab and try again.");
            return;
          }
          if (response && response.success) {
            renderItems();
          }
        });
      } else {
        alert("Please navigate to an Amazon product page.");
      }
    });
  });

  const importBtn = document.getElementById('import-wishlist-btn');
  const wishlistInput = document.getElementById('wishlist-url-input');
  const mainView = document.querySelector('.app-container:not(#wishlist-selection-view):not(#details-view)');
  const selectionView = document.getElementById('wishlist-selection-view');
  const detailsView = document.getElementById('details-view');
  const closeDetailsBtn = document.getElementById('close-details-btn');
  const selectionList = document.getElementById('selection-list');
  const selectAllCheckbox = document.getElementById('select-all-checkbox');
  const confirmBtn = document.getElementById('confirm-tracking-btn');
  const cancelBtn = document.getElementById('cancel-import-btn');
  const selectionTemplate = document.getElementById('selection-item-template');
  
  let extractedWishlistItems = [];
  let currentWishlistUrl = '';

  function getWishlistId(url) {
    return url?.match(/wishlist\/ls\/([a-zA-Z0-9]+)/)?.[1] || null;
  }

  function isSameWishlistUrl(a, b) {
    const aId = getWishlistId(a);
    const bId = getWishlistId(b);
    return Boolean(aId && bId && aId === bId);
  }

  function findVisibleWishlistTab(url, tabs) {
    return tabs.find(tab => {
      const tabUrl = tab?.url || '';
      return tabUrl.startsWith('http') && tabUrl.includes('amazon.') && isSameWishlistUrl(tabUrl, url);
    });
  }

  function extractVisibleWishlistFromOpenTab(url) {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const wishlistTab = findVisibleWishlistTab(url, tabs);
        if (!wishlistTab?.id) {
          resolve(null);
          return;
        }

        chrome.tabs.sendMessage(wishlistTab.id, { type: 'EXTRACT_VISIBLE_WISHLIST' }, (response) => {
          if (chrome.runtime.lastError || !response?.success || !response.items?.length) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      });
    });
  }

  async function extractWishlistItems(url) {
    const visibleResponse = await extractVisibleWishlistFromOpenTab(url);
    if (visibleResponse) return visibleResponse;

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'EXTRACT_WISHLIST', url }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }

  const importWishlistHandler = async (urlToImport, buttonEl) => {
    const url = urlToImport.trim();
    if (!url.includes('amazon.') || !url.includes('wishlist')) {
      alert("Please enter a valid Amazon Wishlist URL.");
      return;
    }
    
    currentWishlistUrl = url;
    const originalText = buttonEl.textContent;
    buttonEl.textContent = 'Loading (0 products found)...';
    buttonEl.disabled = true;

    // Temporary listener to show live progress
    const progressListener = (message) => {
      if (message.type === 'WISHLIST_IMPORT_PROGRESS') {
        buttonEl.textContent = `Loading (${message.count} products found)...`;
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    const response = await extractWishlistItems(url);
    chrome.runtime.onMessage.removeListener(progressListener);
    buttonEl.textContent = originalText;
    buttonEl.disabled = false;

    if (!response || !response.success) {
      alert("Failed to extract wishlist. Ensure it is a public/shared wishlist.");
      return;
    }

    extractedWishlistItems = response.items || [];
    if (extractedWishlistItems.length === 0) {
      alert("No items found on this wishlist.");
      return;
    }

    selectionList.innerHTML = '';
    extractedWishlistItems.forEach((item, index) => {
      const clone = selectionTemplate.content.cloneNode(true);
      const titleEl = clone.querySelector('.selection-title');
      const priceEl = clone.querySelector('.selection-price');
      const checkbox = clone.querySelector('.item-checkbox');

      titleEl.textContent = item.title;
      priceEl.textContent = item.currentPrice ? formatPrice(item.currentPrice, item.currency) : 'Price not found';
      const priceDropSummary = formatPriceDropSummary(item);
      if (priceDropSummary) {
        priceEl.textContent += ` · ${priceDropSummary}`;
      }
      checkbox.dataset.index = index;
      checkbox.addEventListener('change', updateSelectionCounter);

      selectionList.appendChild(clone);
    });

    updateSelectionCounter();
    mainView.style.display = 'none';
    selectionView.style.display = 'flex';
  };

  const syncWishlistHandler = async (urlToSync, buttonEl) => {
    const url = urlToSync.trim();
    if (!url.includes('amazon.') || !url.includes('wishlist')) {
      showStatus('Open the Amazon wishlist tab, then sync again.', 'error');
      return;
    }

    const originalText = buttonEl.textContent;
    setButtonProgress(buttonEl, 'Reading open wishlist...', 'info');
    buttonEl.disabled = true;

    const progressListener = (message) => {
      if (message.type === 'WISHLIST_IMPORT_PROGRESS') {
        setButtonProgress(buttonEl, `Syncing (${message.count} products found)...`, 'info');
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    const response = await extractWishlistItems(url);
    chrome.runtime.onMessage.removeListener(progressListener);
    if (!response || !response.success || !response.items?.length) {
      buttonEl.textContent = originalText;
      buttonEl.disabled = false;
      showStatus('Could not sync this wishlist. Reload the Amazon tab and try again.', 'error');
      return;
    }

    const wishlistId = getWishlistId(url);
    const syncedItems = response.items.map(item => ({
      ...item,
      wishlistIds: wishlistId ? [wishlistId] : []
    }));
    setButtonProgress(buttonEl, `Saving ${response.items.length} products...`, 'info');
    chrome.runtime.sendMessage({ type: 'BULK_ADD_TRACKED_ITEMS', items: syncedItems }, async (saveResponse) => {
      buttonEl.textContent = originalText;
      buttonEl.disabled = false;
      if (chrome.runtime.lastError || !saveResponse?.success) {
        showStatus('Wishlist sync failed while saving items.', 'error');
        return;
      }
      await renderItems();
      showStatus(`Wishlist synced (${response.items.length} products refreshed).`, 'success');
    });
  };

  const updateSelectionCounter = () => {
    const checkboxes = selectionList.querySelectorAll('.item-checkbox');
    const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const counter = document.getElementById('selection-counter');
    if (counter) counter.textContent = `${checkedCount} / ${checkboxes.length} Selected`;
  };

  importBtn.addEventListener('click', () => importWishlistHandler(wishlistInput.value, importBtn));
  
  if (trackWishlistTabBtn) {
    trackWishlistTabBtn.addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.url) {
          importWishlistHandler(tabs[0].url, trackWishlistTabBtn);
        }
      });
    });
  }

  selectAllCheckbox.addEventListener('change', (e) => {
    const checkboxes = selectionList.querySelectorAll('.item-checkbox');
    checkboxes.forEach(cb => cb.checked = e.target.checked);
    updateSelectionCounter();
  });

  cancelBtn.addEventListener('click', () => {
    selectionView.style.display = 'none';
    mainView.style.display = 'flex';
  });

  if (closeDetailsBtn) {
    closeDetailsBtn.addEventListener('click', () => {
      detailsView.style.display = 'none';
      mainView.style.display = 'flex';
    });
  }

  confirmBtn.addEventListener('click', () => {
    const checkboxes = selectionList.querySelectorAll('.item-checkbox');
    const selectedItems = [];
    checkboxes.forEach(cb => {
      if (cb.checked) {
        selectedItems.push(extractedWishlistItems[cb.dataset.index]);
      }
    });

    if (selectedItems.length === 0) {
      alert("Please select at least one item.");
      return;
    }

    confirmBtn.textContent = 'Adding...';
    confirmBtn.disabled = true;

    const wishlistId = getWishlistId(currentWishlistUrl);
    const sourcedItems = selectedItems.map(item => ({
      ...item,
      wishlistIds: wishlistId ? [wishlistId] : []
    }));
    chrome.runtime.sendMessage({ type: 'BULK_ADD_TRACKED_ITEMS', items: sourcedItems }, async (response) => {
      confirmBtn.textContent = 'Confirm Tracking';
      confirmBtn.disabled = false;
      
      if (chrome.runtime.lastError || !response || !response.success) {
        alert("Failed to add items.");
      } else {
        // Save the tracked wishlist and autoSync setting
        const autoSyncCheckbox = document.getElementById('auto-sync-checkbox');
        const isAutoSync = autoSyncCheckbox ? autoSyncCheckbox.checked : false;

        if (currentWishlistUrl) {
          const wishlistIdMatch = currentWishlistUrl.match(/wishlist\/ls\/([a-zA-Z0-9]+)/);
          const wishlistId = wishlistIdMatch ? wishlistIdMatch[1] : null;
          if (wishlistId) {
            let trackedWishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];
            trackedWishlists = trackedWishlists.map(w => typeof w === 'string' ? { id: w, url: `https://www.amazon.com/hz/wishlist/ls/${w}` } : w);
            
            const existingList = trackedWishlists.find(w => w.id === wishlistId);
            if (existingList) {
              existingList.autoSync = isAutoSync;
              if (!existingList.url) existingList.url = currentWishlistUrl;
            } else {
              trackedWishlists.push({ id: wishlistId, url: currentWishlistUrl, autoSync: isAutoSync });
            }
            await setStorageData(StorageKeys.TRACKED_WISHLISTS, trackedWishlists, StorageArea.LOCAL);
          }
        }

        wishlistInput.value = '';
        selectionView.style.display = 'none';
        mainView.style.display = 'flex';
        renderItems();
      }
    });
  });

  if (viewTrackedWishlistBtn) {
    viewTrackedWishlistBtn.addEventListener('click', () => {
      const url = viewTrackedWishlistBtn.dataset.wishlistUrl || wishlistInput.value;
      syncWishlistHandler(url, viewTrackedWishlistBtn);
    });
  }

  if (viewPriceHistoryBtn) {
    viewPriceHistoryBtn.addEventListener('click', () => {
      const asin = viewPriceHistoryBtn.dataset.asin;
      const cardBtn = document.querySelector(`.item-card[data-id="${asin}"] .details-btn`);
      if (cardBtn) {
        cardBtn.click();
      } else {
        alert("Product not found in current view.");
      }
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', async () => {
      settings.dashboardSort = sortSelect.value;
      visibleItemLimit = PAGE_SIZE;
      if (itemList) itemList.scrollTop = 0;
      renderItems();
      await setStorageData(StorageKeys.SETTINGS, settings, StorageArea.SYNC);
    });
  }
  if (itemSearchInput) {
    itemSearchInput.addEventListener('input', debounce(() => {
      visibleItemLimit = PAGE_SIZE;
      if (itemList) itemList.scrollTop = 0;
      renderItems();
    }));
  }
  if (filterSelect) {
    filterSelect.addEventListener('change', async () => {
      settings.dashboardFilter = filterSelect.value;
      visibleItemLimit = PAGE_SIZE;
      if (itemList) itemList.scrollTop = 0;
      renderItems();
      await setStorageData(StorageKeys.SETTINGS, settings, StorageArea.SYNC);
    });
  }

  async function renderItems() {
    const savedScrollTop = itemList ? itemList.scrollTop : 0;
    itemList.innerHTML = '';
    const allItems = await getTrackedItems();
    let items = [...allItems];
    const history = await getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL) || {};
    
    // Check CAPTCHA Backoff Status
    const captchaBanner = document.getElementById('captcha-warning-banner');
    const captchaResumeTime = document.getElementById('captcha-resume-time');
    const backoffUntil = await getStorageData(StorageKeys.CAPTCHA_BACKOFF_UNTIL, StorageArea.LOCAL);
    
    if (captchaBanner && captchaResumeTime) {
      if (backoffUntil && Date.now() < backoffUntil) {
        const resumeDate = new Date(backoffUntil);
        captchaResumeTime.textContent = resumeDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        captchaBanner.style.display = 'block';
      } else {
        captchaBanner.style.display = 'none';
      }
    }

    const mainTitle = document.getElementById('main-title');
    if (mainTitle) {
      mainTitle.textContent = `Tracked Items (${items.length})`;
    }

    // Infer regional domain from tracked wishlists for legacy items saved with .com
    let preferredDomain = 'www.amazon.com';
    const trackedWishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];
    if (trackedWishlists.length > 0) {
      const wlUrl = typeof trackedWishlists[0] === 'string' ? '' : trackedWishlists[0].url;
      if (wlUrl) {
        try { preferredDomain = new URL(wlUrl).hostname; } catch(e) {}
      }
    }

    if (items.length === 0) {
      setEmptyState(
        "You aren't tracking any items yet.",
        'Visit an Amazon product page and click the "Track Price" button!'
      );
      emptyState.style.display = 'block';
      itemList.appendChild(emptyState);
      return;
    }
    emptyState.style.display = 'none';

    const query = (itemSearchInput?.value || '').trim().toLowerCase();
    items = items.filter(item => itemMatchesQuery(item, query));
    const activeFilter = filterSelect?.value || 'all';
    items = items.filter(item => itemMatchesFilter(item, activeFilter));
    if (mainTitle && (query || activeFilter !== 'all')) {
      mainTitle.textContent = `Tracked Items (${items.length} of ${allItems.length})`;
    }

    if (items.length === 0) {
      setEmptyState('No matching products found.', 'Try a different title, ASIN, status, or target search.');
      emptyState.style.display = 'block';
      itemList.appendChild(emptyState);
      return;
    }
    emptyState.style.display = 'none';
    
    // Sorting Logic
    const sortVal = sortSelect?.value || 'recent';
    if (sortVal === 'priceAsc') {
      items.sort((a, b) => (a.currentPrice || 999999) - (b.currentPrice || 999999));
    } else if (sortVal === 'priceDesc') {
      items.sort((a, b) => (b.currentPrice || 0) - (a.currentPrice || 0));
    } else if (sortVal === 'discountDesc') {
      items.sort((a, b) => {
        const discA = getPriceDropDetails(a)?.percent || 0;
        const discB = getPriceDropDetails(b)?.percent || 0;
        return discB - discA;
      });
    } else {
      // Default: recent (newest first)
      items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }

    const filteredItemCount = items.length;
    const visibleItems = items.slice(0, visibleItemLimit);

    visibleItems.forEach((item) => {
      const clone = template.content.cloneNode(true);
      const card = clone.querySelector('.item-card');
      card.dataset.id = item.id;
      
      const chartBtn = clone.querySelector('.chart-btn');
      if (chartBtn) {
        chartBtn.addEventListener('click', () => {
          card.classList.toggle('show-graph');
          if (card.classList.contains('show-graph')) {
            requestAnimationFrame(prepareChart);
          }
        });
      }

      const priorityBtn = clone.querySelector('.priority-btn');
      if (item.isPriority) {
        priorityBtn.textContent = '⭐️';
        priorityBtn.classList.add('active');
        priorityBtn.title = 'Remove from Priority Tracking';
      } else {
        priorityBtn.textContent = '☆';
        priorityBtn.title = 'Add to Priority Tracking (Fast Check)';
      }

      priorityBtn.addEventListener('click', async () => {
        if (!item.isPriority) {
          const currentPriorityCount = allItems.filter(i => i.isPriority).length;
          if (currentPriorityCount >= 10) {
            showStatus('Maximum 10 priority items allowed.', 'error');
            return;
          }
        }

        const nextPriority = !item.isPriority;
        priorityBtn.disabled = true;
        try {
          await updateTrackedItem({ id: item.id, isPriority: nextPriority });
          item.isPriority = nextPriority;
          priorityBtn.textContent = item.isPriority ? '⭐️' : '☆';
          priorityBtn.classList.toggle('active', item.isPriority);
          priorityBtn.title = item.isPriority ? 'Remove from Priority Tracking' : 'Add to Priority Tracking (Fast Check)';
          showStatus(item.isPriority ? 'Added to Priority Tracking' : 'Removed from Priority Tracking', 'success');

          // Update in-memory array for limit checking only after persistence succeeds.
          const index = items.findIndex(i => i.id === item.id);
          if (index > -1) items[index].isPriority = item.isPriority;
        } catch (_error) {
          showStatus('Could not update Priority Tracking. Try again.', 'error');
        } finally {
          priorityBtn.disabled = false;
        }
      });

      const titleEl = clone.querySelector('.item-title');
      titleEl.textContent = item.title || 'Unknown Product';
      
      const imgEl = clone.querySelector('.item-image');
      if (item.imageUrl) {
        imgEl.src = item.imageUrl;
        imgEl.style.display = 'block';
      }
      
      // Fix legacy items that were hardcoded to amazon.com before the regional fix
      let productUrl = item.url || `https://${preferredDomain}/dp/${item.id}`;
      if (productUrl.includes('www.amazon.com') && preferredDomain !== 'www.amazon.com') {
        productUrl = productUrl.replace('www.amazon.com', preferredDomain);
      }
      titleEl.href = productUrl;
      
      clone.querySelector('.item-price').textContent = formatPrice(item.currentPrice, item.currency);

      const discountInfoEl = clone.querySelector('.discount-info');
      const originalPriceEl = clone.querySelector('.original-price');
      const discountBadgeEl = clone.querySelector('.discount-badge');

      const priceDrop = getPriceDropDetails(item);
      if (priceDrop) {
        discountInfoEl.style.display = 'block';
        originalPriceEl.textContent = formatPrice(priceDrop.whenAddedPrice, item.currency);
        discountBadgeEl.textContent = formatPriceDropBadge(priceDrop, item.currency);
      }

      const targetEl = clone.querySelector('.target-price');
      targetEl.textContent = item.targetPrice ? `Target: ${formatPrice(item.targetPrice, item.currency)}` : 'No target set';

      const lastCheckedEl = clone.querySelector('.last-checked');
      if (lastCheckedEl) {
        lastCheckedEl.textContent = `Last checked: ${formatTimestamp(item.lastChecked)}`;
      }

      const nextCheckEl = clone.querySelector('.next-check');
      if (nextCheckEl) {
        nextCheckEl.textContent = item.isPriority && !Number.isFinite(item.nextPriceCheckAt)
          ? 'Next check: Priority queue'
          : `Next check: ${formatNextCheck(item.nextPriceCheckAt)}`;
        nextCheckEl.title = item.checkCadence || (item.isPriority ? 'Priority · 2m queue' : 'Queued for adaptive checking');
      }

      const stockEl = clone.querySelector('.stock-status');
      if (item.inStock) {
        stockEl.textContent = 'In Stock';
        stockEl.className = 'stock-status in-stock';
      } else {
        stockEl.textContent = 'Out of Stock';
        stockEl.className = 'stock-status out-of-stock';
      }

      const canvas = clone.querySelector('.price-chart');
      const chartMeta = clone.querySelector('.chart-meta');
      const chartSamples = clone.querySelector('.chart-samples');
      const itemHistory = history[item.id] || [];
      let chartPrepared = false;
      const prepareChart = () => {
        if (chartPrepared) return;
        chartPrepared = true;
        if (itemHistory.length > 0) {
          renderChartMeta(chartMeta, itemHistory, item.currency);
          renderChartSamples(chartSamples, itemHistory, item.currency);
          renderSparkline(canvas, itemHistory, item.currency);
        }
      };
      if (itemHistory.length === 0) {
        const placeholder = document.createElement('p');
        placeholder.className = 'chart-empty';
        placeholder.textContent = item.lastChecked
          ? `No price history yet. Last checked ${formatTimestamp(item.lastChecked)}.`
          : 'No price history yet. The first successful price check will add a timestamp.';
        canvas.replaceWith(placeholder);
        if (chartMeta) chartMeta.style.display = 'none';
        if (chartSamples) chartSamples.style.display = 'none';
      }

      const removeBtn = clone.querySelector('.remove-btn');
      let removeConfirmTimer = null;
      removeBtn.addEventListener('click', async () => {
        if (!removeBtn.classList.contains('confirming')) {
          removeBtn.classList.add('confirming');
          removeBtn.textContent = 'Confirm remove';
          clearTimeout(removeConfirmTimer);
          removeConfirmTimer = setTimeout(() => {
            removeBtn.classList.remove('confirming');
            removeBtn.textContent = 'Remove';
          }, 3500);
          return;
        }

        clearTimeout(removeConfirmTimer);
        removeBtn.disabled = true;
        try {
          await deleteTrackedItem(item.id);
          await renderItems();
          showStatus('Item removed.', 'info');
        } catch (_error) {
          removeBtn.classList.remove('confirming');
          removeBtn.textContent = 'Remove';
          removeBtn.disabled = false;
          showStatus('Could not remove this item. Try again.', 'error');
        }
      });

      const detailsBtn = clone.querySelector('.details-btn');
      if (detailsBtn) {
        detailsBtn.addEventListener('click', () => {
          document.getElementById('details-product-name').textContent = item.title;
          document.getElementById('details-current-price').textContent = formatPrice(item.currentPrice, item.currency);
          document.getElementById('details-stock-status').textContent = item.inStock ? 'In Stock' : 'Out of Stock';
          document.getElementById('details-target-price').textContent = item.targetPrice ? formatPrice(item.targetPrice, item.currency) : 'No target set';
          const detailsDiscount = document.getElementById('details-discount-info');
          if (detailsDiscount) {
            const priceDropSummary = formatPriceDropSummary(item);
            if (priceDropSummary) {
              detailsDiscount.textContent = priceDropSummary;
              detailsDiscount.style.display = 'flex';
            } else {
              detailsDiscount.style.display = 'none';
            }
          }
          
          const historyList = document.getElementById('details-history-list');
          historyList.innerHTML = '';
          if (itemHistory.length === 0) {
            historyList.innerHTML = '<em>No price history recorded yet.</em>';
          } else {
            // Reverse so newest is at the top
            const reversedHistory = [...itemHistory].reverse();
            reversedHistory.forEach(entry => {
              const div = document.createElement('div');
              div.style.display = 'flex';
              div.style.justifyContent = 'space-between';
              div.style.padding = '4px 0';
              div.style.borderBottom = '1px solid rgba(255,255,255,0.1)';
              
              const dateObj = new Date(entry.timestamp);
              const dateStr = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
              
              const dateSpan = document.createElement('span');
              dateSpan.textContent = dateStr;
              
              const priceSpan = document.createElement('span');
              priceSpan.style.fontWeight = 'bold';
              priceSpan.textContent = formatPrice(entry.price, item.currency);
              
              div.appendChild(dateSpan);
              div.appendChild(priceSpan);
              historyList.appendChild(div);
            });
          }
          
          mainView.style.display = 'none';
          detailsView.style.display = 'flex';
        });
      }

      const editBtn = clone.querySelector('.edit-btn');
      const targetEditor = clone.querySelector('.target-editor');
      const targetInput = clone.querySelector('.target-editor-input');
      const targetSaveBtn = clone.querySelector('.target-save-btn');
      const targetCancelBtn = clone.querySelector('.target-cancel-btn');

      const closeTargetEditor = () => {
        targetEditor.hidden = true;
        editBtn.disabled = false;
      };

      editBtn.addEventListener('click', () => {
        targetInput.value = Number.isFinite(item.targetPrice) ? item.targetPrice : '';
        targetEditor.hidden = false;
        editBtn.disabled = true;
        targetInput.focus();
      });

      targetCancelBtn.addEventListener('click', closeTargetEditor);
      targetEditor.addEventListener('submit', async (event) => {
        event.preventDefault();
        const rawValue = targetInput.value.trim();
        const parsed = rawValue === '' ? null : Number(rawValue);
        if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
          showStatus('Please enter a valid price or leave it empty to clear.', 'error');
          return;
        }

        targetSaveBtn.disabled = true;
        try {
          await updateTrackedItem({ id: item.id, targetPrice: parsed });
          item.targetPrice = parsed;
          targetEl.textContent = parsed ? `Target: ${formatPrice(parsed, item.currency)}` : 'No target set';
          closeTargetEditor();
          showStatus(parsed ? 'Target price updated.' : 'Target price cleared.', 'success');
        } catch (_error) {
          showStatus('Could not update the target price. Try again.', 'error');
        } finally {
          targetSaveBtn.disabled = false;
        }
      });

      itemList.appendChild(clone);
      if (appContainer.classList.contains('show-all-charts')) {
        requestAnimationFrame(prepareChart);
      }
    });

    const pagination = document.createElement('div');
    pagination.className = 'list-pagination';
    const paginationText = document.createElement('span');
    paginationText.textContent = `Showing ${visibleItems.length} of ${filteredItemCount}`;
    pagination.appendChild(paginationText);
    if (visibleItems.length < filteredItemCount) {
      const loadMoreBtn = document.createElement('button');
      loadMoreBtn.type = 'button';
      loadMoreBtn.textContent = `Load ${Math.min(PAGE_SIZE, filteredItemCount - visibleItems.length)} more`;
      loadMoreBtn.addEventListener('click', () => {
        visibleItemLimit += PAGE_SIZE;
        renderItems();
      });
      pagination.appendChild(loadMoreBtn);
    }
    itemList.appendChild(pagination);

    if (savedScrollTop > 0) {
      requestAnimationFrame(() => {
        if (itemList) itemList.scrollTop = savedScrollTop;
      });
    }
  }

  async function initializeDashboard() {
    try {
      await loadDashboardSettings();
      await renderNextCheckSchedule();
      await renderItems();
      hideDashboardRecovery();
      if (!scheduleRefreshTimer) {
        scheduleRefreshTimer = setInterval(() => {
          renderNextCheckSchedule().catch(() => showDashboardRecovery());
        }, 60000);
      }
    } catch (_error) {
      hideLegacyTargetWarning();
      showDashboardRecovery();
      setEmptyState('Dashboard could not load.', 'Your saved tracking data was not changed. Select Retry to try again.');
      emptyState.style.display = 'block';
      itemList.replaceChildren(emptyState);
    }
  }

  retryDashboardLoadBtn?.addEventListener('click', async () => {
    retryDashboardLoadBtn.disabled = true;
    try {
      await initializeDashboard();
    } finally {
      retryDashboardLoadBtn.disabled = false;
    }
  });

  await initializeDashboard();

  // Auto-trigger import if launched with ?import=URL
  const urlParams = new URLSearchParams(window.location.search);
  const importUrl = urlParams.get('import');
  if (importUrl) {
    wishlistInput.value = importUrl;
    importWishlistHandler(importUrl, importBtn);
  }
});

function formatTimestamp(timestamp) {
  if (!timestamp) return 'Not checked yet';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function formatTimeOnly(timestamp) {
  if (!timestamp) return 'not scheduled';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'not scheduled';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatNextCheck(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return 'Due now';
  const minutes = Math.max(1, Math.ceil((timestamp - Date.now()) / 60000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `in ${hours}h ${remainingMinutes}m` : `in ${hours}h`;
}

function getValidHistory(dataPoints) {
  return dataPoints
    .filter((dp) => Number.isFinite(dp.price) && Number.isFinite(dp.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function renderChartMeta(container, dataPoints, currency) {
  if (!container) return;
  const validPoints = getValidHistory(dataPoints);
  if (validPoints.length === 0) {
    container.style.display = 'none';
    return;
  }

  const prices = validPoints.map((dp) => dp.price);
  const latest = validPoints[validPoints.length - 1];
  container.style.display = 'flex';
  container.innerHTML = '';

  [
    `Latest ${formatPrice(latest.price, currency)} · ${formatTimestamp(latest.timestamp)}`,
    `Low ${formatPrice(Math.min(...prices), currency)}`,
    `High ${formatPrice(Math.max(...prices), currency)}`,
    `${validPoints.length} fetch${validPoints.length === 1 ? '' : 'es'}`
  ].forEach((text) => {
    const chip = document.createElement('span');
    chip.textContent = text;
    container.appendChild(chip);
  });
}

function renderChartSamples(container, dataPoints, currency) {
  if (!container) return;
  const validPoints = getValidHistory(dataPoints);
  container.innerHTML = '';
  if (validPoints.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'grid';
  validPoints.slice(-4).reverse().forEach((point) => {
    const row = document.createElement('div');
    row.className = 'chart-sample';

    const time = document.createElement('span');
    time.textContent = formatTimestamp(point.timestamp);

    const price = document.createElement('strong');
    price.textContent = formatPrice(point.price, currency);

    row.appendChild(time);
    row.appendChild(price);
    container.appendChild(row);
  });
}

function renderSparkline(canvas, dataPoints, currency) {
  if (dataPoints.length === 0) return;

  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const validPoints = getValidHistory(dataPoints);
  const prices = validPoints.map((dp) => dp.price);
  if (prices.length === 0) return;

  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const flat = rawMax === rawMin;
  const scalePadding = flat ? Math.max(rawMax * 0.05, 1) : (rawMax - rawMin) * 0.12;
  const min = rawMin - scalePadding;
  const max = rawMax + scalePadding;
  const range = max - min || 1;
  const paddingX = 54;
  const rightPadding = 18;
  const topPadding = 24;
  const bottomPadding = 34;
  const usableWidth = width - paddingX - rightPadding;
  const usableHeight = height - topPadding - bottomPadding;

  const points = prices.map((price, index) => ({
    x: paddingX + (prices.length === 1 ? usableWidth / 2 : (index / (prices.length - 1)) * usableWidth),
    y: topPadding + ((max - price) / range) * usableHeight
  }));

  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(160, 160, 170, 0.18)';
  ctx.fillStyle = 'rgba(190, 190, 200, 0.9)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const yTicks = flat ? [rawMax] : [rawMax, (rawMax + rawMin) / 2, rawMin];
  yTicks.forEach((value) => {
    const y = topPadding + ((max - value) / range) * usableHeight;
    ctx.beginPath();
    ctx.moveTo(paddingX, y);
    ctx.lineTo(width - rightPadding, y);
    ctx.stroke();
    ctx.fillText(formatPrice(value, currency), paddingX - 8, y);
  });

  ctx.strokeStyle = 'rgba(160, 160, 170, 0.3)';
  ctx.beginPath();
  ctx.moveTo(paddingX, topPadding);
  ctx.lineTo(paddingX, height - bottomPadding);
  ctx.lineTo(width - rightPadding, height - bottomPadding);
  ctx.stroke();

  const gradient = ctx.createLinearGradient(0, topPadding, 0, height - bottomPadding);
  gradient.addColorStop(0, 'rgba(255, 153, 0, 0.22)');
  gradient.addColorStop(1, 'rgba(255, 153, 0, 0)');

  ctx.beginPath();
  ctx.moveTo(points[0].x, height - bottomPadding);
  points.forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.lineTo(points[points.length - 1].x, height - bottomPadding);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ff9900';
  ctx.stroke();

  points.forEach((point, index) => {
    if (points.length > 4 && index !== 0 && index !== points.length - 1) return;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ff9900';
    ctx.fill();
    ctx.strokeStyle = 'rgba(18, 18, 18, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (points.length <= 4 || index === points.length - 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.textAlign = index === points.length - 1 ? 'right' : 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(formatPrice(validPoints[index].price, currency), point.x + (index === points.length - 1 ? -6 : 6), point.y - 6);
    }
  });

  const first = validPoints[0];
  const last = validPoints[validPoints.length - 1];
  ctx.fillStyle = 'rgba(160, 160, 170, 0.92)';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(formatTimestamp(first.timestamp), paddingX, height - 4);
  if (validPoints.length > 1) {
    ctx.textAlign = 'right';
    ctx.fillText(formatTimestamp(last.timestamp), width - rightPadding, height - 4);
  }
}
