import { getTrackedItems, getStorageData, formatPrice, StorageKeys, StorageArea } from '../utils/storage.js';
import { extractWishlistWithVisibleFallback } from './wishlist_extraction.js';
import {
  getAmazonAsin,
  getAmazonWishlistId,
  isAmazonWishlistPageUrl,
  normalizeStoredAmazonProductUrl,
  parseCanonicalAmazonProductUrl,
  parseCanonicalAmazonWishlistUrl,
  sanitizeAmazonImageUrl
} from '../utils/amazon.js';
import {
  activePointIndex,
  formatDuration,
  niceTicks,
  priceSegments,
  summarizeHistory,
  timeLabelStyle,
  timeTicks,
  validHistory
} from '../utils/price_chart.mjs';
import { getTrackingChange } from '../utils/history.mjs';

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

  function showStatus(message, type = 'info', persistent = false) {
    if (!statusBanner) return;
    statusBanner.textContent = message;
    statusBanner.className = `status-banner status-${type} visible`;
    statusBanner.setAttribute('role', type === 'error' ? 'alert' : 'status');
    clearTimeout(statusTimer);
    if (type !== 'error' && !persistent) {
      statusTimer = setTimeout(() => {
        statusBanner.classList.remove('visible');
      }, 4000);
    }
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
      ...(Array.isArray(item.authors) ? item.authors : []),
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

    const [priceAlarm, priorityAlarm, wishlistAlarm, wishlistContinuationAlarm, trackedItems] = await Promise.all([
      getAlarm('checkPricesAlarm'),
      getAlarm('checkPriorityPricesAlarm'),
      getAlarm('checkWishlistsAlarm'),
      getAlarm('continueWishlistSyncAlarm'),
      getTrackedItems()
    ]);

    nextChecksSummary.replaceChildren();
    [
      ['Price checks', priceAlarm?.scheduledTime],
      ['Fast checks', priorityAlarm?.scheduledTime],
      ['Wishlist sync', wishlistContinuationAlarm?.scheduledTime || wishlistAlarm?.scheduledTime]
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
      queueChip.textContent = `${dueCount} product${dueCount === 1 ? '' : 's'} due now`;
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
  
  // Load settings
  let settings = await getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC) || {};
  if (legacyTargetWarning) {
    legacyTargetWarning.hidden = !Object.hasOwn(settings, 'defaultTargetPrice');
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== StorageArea.SYNC || !changes[StorageKeys.SETTINGS]) return;
    settings = changes[StorageKeys.SETTINGS].newValue || {};
    if (legacyTargetWarning) {
      legacyTargetWarning.hidden = !Object.hasOwn(settings, 'defaultTargetPrice');
    }
  });
  async function saveDashboardPreference(key, value) {
    const response = await sendBackgroundMessage({ type: 'PATCH_SETTINGS', set: { [key]: value } });
    if (!response.success || !response.settings) {
      throw new Error(response.error || 'Failed to save dashboard preference');
    }
    settings = response.settings;
  }
  if (sortSelect && settings.dashboardSort) {
    const savedSortExists = Array.from(sortSelect.options).some(option => option.value === settings.dashboardSort);
    if (savedSortExists) {
      sortSelect.value = settings.dashboardSort;
    }
  }
  if (filterSelect && settings.dashboardFilter) {
    const savedFilterExists = Array.from(filterSelect.options).some(option => option.value === settings.dashboardFilter);
    if (savedFilterExists) filterSelect.value = settings.dashboardFilter;
  }
  const startupParams = new URLSearchParams(window.location.search);
  const requestedFilter = startupParams.get('filter');
  if (filterSelect && requestedFilter) {
    const allowedFilter = Array.from(filterSelect.options).some(option => option.value === requestedFilter);
    if (allowedFilter) filterSelect.value = requestedFilter;
  }

  const initialWishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];
  let regionWishlists = initialWishlists;
  if (initialWishlists.some((entry) => typeof entry === 'string')) {
    const migrationResponse = await sendBackgroundMessage({ type: 'MIGRATE_LEGACY_WISHLISTS' });
    if (!migrationResponse.success) {
      showStatus('Legacy wishlist regions could not be checked. Automatic sync remains paused for them.', 'error');
    } else {
      regionWishlists = migrationResponse.wishlists || [];
    }
  }
  const unresolvedCount = regionWishlists.filter((entry) => entry?.needsRegionReview).length;
  if (unresolvedCount > 0) {
    showStatus(
      `${unresolvedCount} legacy wishlist${unresolvedCount === 1 ? ' needs' : 's need'} the original Amazon URL before automatic sync can resume.`,
      'info',
      true
    );
  }

  const toggleAllChartsBtn = document.getElementById('toggle-all-charts-btn');
  const appContainer = document.querySelector('.app-container');
  toggleAllChartsBtn.addEventListener('click', () => {
    const visibleCards = appContainer.querySelectorAll('.item-card').length;
    if (!appContainer.classList.contains('show-all-charts') && visibleCards > 10) {
      showStatus('Filter to 10 or fewer visible products before expanding every history.', 'info');
      return;
    }
    const isActive = appContainer.classList.toggle('show-all-charts');
    toggleAllChartsBtn.textContent = isActive ? 'Collapse Visible Histories' : 'Expand Visible Histories';
    toggleAllChartsBtn.setAttribute('aria-expanded', String(isActive));
    renderItems();
  });

  await renderNextCheckSchedule();
  setInterval(renderNextCheckSchedule, 60000);

  // Conditionally show tracking buttons based on the current page or an open wishlist tab.
  chrome.tabs.query({}, async (tabs) => {
    const activeTab = tabs.find(tab => tab.active && tab.currentWindow) || tabs[0];
    const activeProductUrl = parseCanonicalAmazonProductUrl(activeTab?.url || '');
    const activeWishlistUrl = parseCanonicalAmazonWishlistUrl(activeTab?.url || '');
    const isAmazonProduct = Boolean(activeProductUrl);
    const isActiveAmazonWishlist = Boolean(activeWishlistUrl);
    
    const items = await getTrackedItems();
    const trackedWishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];

    if (isAmazonProduct) {
      const asin = getAmazonAsin(activeProductUrl.href);
      
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
      return Boolean(parseCanonicalAmazonWishlistUrl(tab?.url || ''));
    });
    const trackedWishlistIds = trackedWishlists.map(w => typeof w === 'string' ? w : w.id).filter(Boolean);
    const trackedOpenWishlist = openWishlistTabs.find(tab => trackedWishlistIds.includes(getWishlistId(tab.url)));
    const wishlistUrl = isActiveAmazonWishlist
      ? activeTab.url
      : (parseCanonicalAmazonWishlistUrl(dashboardImportUrl)?.href || trackedOpenWishlist?.url);
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
  });

  addBtn.addEventListener('click', async () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs[0];
      if (parseCanonicalAmazonProductUrl(activeTab?.url || '')) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'TRACK_CURRENT_PAGE' }, (response) => {
          if (chrome.runtime.lastError) {
            showStatus('Could not reach the Amazon page. Reload the tab and try again.', 'error');
            return;
          }
          if (response && response.success) {
            renderItems();
            showStatus('Product added to tracking.', 'success');
          } else {
            showStatus('Could not track this product. Try the button on the Amazon page.', 'error');
          }
        });
      } else {
        showStatus('Open an Amazon product page, then try again.', 'error');
      }
    });
  });

  const importBtn = document.getElementById('import-wishlist-btn');
  const wishlistInput = document.getElementById('wishlist-url-input');
  const mainView = document.getElementById('main-view');
  const selectionView = document.getElementById('wishlist-selection-view');
  const detailsView = document.getElementById('details-view');
  const closeDetailsBtn = document.getElementById('close-details-btn');
  const selectionList = document.getElementById('selection-list');
  const selectAllCheckbox = document.getElementById('select-all-checkbox');
  const confirmBtn = document.getElementById('confirm-tracking-btn');
  const cancelBtn = document.getElementById('cancel-import-btn');
  const selectionTemplate = document.getElementById('selection-item-template');
  const selectionStatus = document.getElementById('selection-status');
  const selectionTitle = document.getElementById('selection-title');
  const detailsTitle = document.getElementById('details-title');
  const SELECTION_PAGE_SIZE = 50;
  let selectionPage = 0;
  let selectedWishlistIndices = new Set();
  let viewReturnFocus = null;
  
  let extractedWishlistItems = [];
  let currentWishlistUrl = '';
  let extractedWishlistHistoryGeneration = 0;

  function showSelectionStatus(message, type = 'error') {
    if (!selectionStatus) return;
    selectionStatus.textContent = message;
    selectionStatus.className = `view-status status-${type} visible`;
    selectionStatus.setAttribute('role', type === 'error' ? 'alert' : 'status');
  }

  function clearSelectionStatus() {
    if (!selectionStatus) return;
    selectionStatus.textContent = '';
    selectionStatus.className = 'view-status';
    selectionStatus.setAttribute('role', 'status');
  }

  function openSecondaryView(view, focusTarget, returnTarget) {
    viewReturnFocus = returnTarget || document.activeElement;
    mainView.hidden = true;
    view.hidden = false;
    requestAnimationFrame(() => focusTarget?.focus());
  }

  function closeSecondaryView(view) {
    view.hidden = true;
    mainView.hidden = false;
    requestAnimationFrame(() => viewReturnFocus?.focus());
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!detailsView.hidden) {
      event.preventDefault();
      closeSecondaryView(detailsView);
    } else if (!selectionView.hidden) {
      event.preventDefault();
      clearSelectionStatus();
      closeSecondaryView(selectionView);
    }
  });

  function getWishlistId(url) {
    return getAmazonWishlistId(url);
  }

  function isSameWishlistUrl(a, b) {
    const aId = getWishlistId(a);
    const bId = getWishlistId(b);
    return Boolean(aId && bId && aId === bId);
  }

  function findVisibleWishlistTabs(url, tabs) {
    return tabs.filter(tab => {
      const tabUrl = tab?.url || '';
      if (!isAmazonWishlistPageUrl(tabUrl)) return false;
      const tabWishlistId = getWishlistId(tabUrl);
      return !tabWishlistId || isSameWishlistUrl(tabUrl, url);
    });
  }

  function extractVisibleWishlistFromOpenTab(url) {
    return new Promise((resolve) => {
      chrome.tabs.query({}, async (tabs) => {
        const wishlistId = getWishlistId(url);
        const wishlistTabs = findVisibleWishlistTabs(url, tabs);
        if (!wishlistTabs.length || !wishlistId) {
          resolve(null);
          return;
        }

        for (const wishlistTab of wishlistTabs) {
          const response = await new Promise((resolveResponse) => {
            chrome.tabs.sendMessage(wishlistTab.id, { type: 'EXTRACT_VISIBLE_WISHLIST' }, (value) => {
              if (chrome.runtime.lastError) {
                resolveResponse(null);
                return;
              }
              resolveResponse(value);
            });
          });
          if (response?.success && response.items?.length && response.wishlistId === wishlistId) {
            resolve(response);
            return;
          }
        }
        resolve(null);
      });
    });
  }

  async function extractWishlistItems(url) {
    const historyGeneration = Number(
      await getStorageData(StorageKeys.PRICE_HISTORY_GENERATION, StorageArea.LOCAL)
    ) || 0;
    return extractWishlistWithVisibleFallback({
      historyGeneration,
      readBackground: () => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'EXTRACT_WISHLIST', url }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response);
        });
      }),
      readVisible: () => extractVisibleWishlistFromOpenTab(url)
    });
  }

  function wishlistPauseMessage(response, fallback) {
    if (!response?.paused) return fallback;
    const resumeAt = Number(response.backoffUntil);
    const resumeText = Number.isFinite(resumeAt) && resumeAt > Date.now()
      ? ` until ${new Date(resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    return `Amazon paused background wishlist reads${resumeText}. Wait for the pause to end, then try again.`;
  }

  function renderSelectionPage() {
    selectionList.replaceChildren();
    const totalPages = Math.max(1, Math.ceil(extractedWishlistItems.length / SELECTION_PAGE_SIZE));
    selectionPage = Math.min(selectionPage, totalPages - 1);
    const start = selectionPage * SELECTION_PAGE_SIZE;
    const pageItems = extractedWishlistItems.slice(start, start + SELECTION_PAGE_SIZE);

    pageItems.forEach((item, pageIndex) => {
      const itemIndex = start + pageIndex;
      const clone = selectionTemplate.content.cloneNode(true);
      const titleEl = clone.querySelector('.selection-title');
      const priceEl = clone.querySelector('.selection-price');
      const checkbox = clone.querySelector('.item-checkbox');

      titleEl.textContent = item.title || 'Unknown product';
      priceEl.textContent = Number.isFinite(item.currentPrice)
        ? formatPrice(item.currentPrice, item.currency)
        : 'Price not found';
      const priceDropSummary = formatPriceDropSummary(item);
      if (priceDropSummary) priceEl.textContent += ` · ${priceDropSummary}`;
      checkbox.dataset.index = itemIndex;
      checkbox.checked = selectedWishlistIndices.has(itemIndex);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedWishlistIndices.add(itemIndex);
        else selectedWishlistIndices.delete(itemIndex);
        updateSelectionCounter();
      });
      selectionList.appendChild(clone);
    });

    const pagination = document.createElement('div');
    pagination.className = 'selection-pagination';
    const previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.textContent = 'Previous 50';
    previousButton.disabled = selectionPage === 0;
    previousButton.addEventListener('click', () => {
      selectionPage -= 1;
      renderSelectionPage();
      selectionList.scrollTop = 0;
    });
    const pageLabel = document.createElement('span');
    pageLabel.textContent = `${start + 1}–${start + pageItems.length} of ${extractedWishlistItems.length}`;
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.textContent = 'Next 50';
    nextButton.disabled = selectionPage >= totalPages - 1;
    nextButton.addEventListener('click', () => {
      selectionPage += 1;
      renderSelectionPage();
      selectionList.scrollTop = 0;
    });
    pagination.append(previousButton, pageLabel, nextButton);
    selectionList.appendChild(pagination);
    updateSelectionCounter();
  }

  const importWishlistHandler = async (urlToImport, buttonEl) => {
    const parsedUrl = parseCanonicalAmazonWishlistUrl(urlToImport.trim());
    if (!parsedUrl) {
      showStatus('Enter a valid shared Amazon wishlist URL.', 'error');
      wishlistInput.focus();
      return;
    }
    const url = parsedUrl.href;
    
    currentWishlistUrl = url;
    const originalText = buttonEl.textContent;
    buttonEl.textContent = 'Reading wishlist (0 products found)…';
    buttonEl.disabled = true;

    // Temporary listener to show live progress
    const progressListener = (message) => {
      if (message.type === 'WISHLIST_IMPORT_PROGRESS') {
        buttonEl.textContent = `Reading wishlist (${message.count} products found)…`;
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    const response = await extractWishlistItems(url);
    chrome.runtime.onMessage.removeListener(progressListener);
    buttonEl.textContent = originalText;
    buttonEl.disabled = false;

    if (!response || !response.success) {
      showStatus(wishlistPauseMessage(
        response,
        'Could not read this wishlist. Confirm it is shared, then reload the list and try again.'
      ), 'error');
      wishlistInput.focus();
      return;
    }

    extractedWishlistItems = response.items || [];
    extractedWishlistHistoryGeneration = response.historyGeneration || 0;
    if (extractedWishlistItems.length === 0) {
      showStatus('No products were found on this wishlist.', 'error');
      wishlistInput.focus();
      return;
    }

    selectionPage = 0;
    selectedWishlistIndices = new Set(extractedWishlistItems.map((_, index) => index));
    clearSelectionStatus();
    if (response.paused) {
      showSelectionStatus(
        `${wishlistPauseMessage(response, 'Amazon paused background wishlist reads.')} ` +
        `You can still review the ${extractedWishlistItems.length} products found before the pause.`,
        'info'
      );
    } else if (response.limited) {
      showSelectionStatus('Only a bounded partial list could be read. Review the products shown here before importing them.', 'info');
    }
    renderSelectionPage();
    openSecondaryView(selectionView, selectionTitle, buttonEl);
  };

  const syncWishlistHandler = async (urlToSync, buttonEl) => {
    const parsedUrl = parseCanonicalAmazonWishlistUrl(urlToSync.trim());
    if (!parsedUrl) {
      showStatus('Open the Amazon wishlist tab, then sync again.', 'error');
      return;
    }
    const url = parsedUrl.href;

    const originalText = buttonEl.textContent;
    setButtonProgress(buttonEl, 'Reading wishlist…', 'info');
    buttonEl.disabled = true;

    const progressListener = (message) => {
      if (message.type === 'WISHLIST_IMPORT_PROGRESS') {
        setButtonProgress(buttonEl, `Reading wishlist (${message.count} products found)…`, 'info');
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    const response = await extractWishlistItems(url);
    chrome.runtime.onMessage.removeListener(progressListener);
    if (!response || !response.success || !response.items?.length) {
      buttonEl.textContent = originalText;
      buttonEl.disabled = false;
      showStatus(wishlistPauseMessage(
        response,
        'Could not sync this wishlist. Open or reload the shared list, then try again.'
      ), 'error');
      return;
    }

    const wishlistId = getWishlistId(url);
    const syncedItems = response.items.map(item => ({
      ...item,
      wishlistIds: wishlistId ? [wishlistId] : []
    }));
    setButtonProgress(buttonEl, `Saving ${response.items.length} products...`, 'info');
    chrome.runtime.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS',
      items: syncedItems,
      historyGeneration: response.historyGeneration || 0,
      syncWishlistUrl: url,
      complete: response.complete === true
    }, async (saveResponse) => {
      buttonEl.textContent = originalText;
      buttonEl.disabled = false;
      if (chrome.runtime.lastError || !saveResponse?.success) {
        showStatus('Wishlist sync failed while saving items.', 'error');
        return;
      }
      const wishlistResponse = await sendBackgroundMessage({ type: 'UPSERT_TRACKED_WISHLIST', url });
      await renderItems();
      if (!wishlistResponse.success) {
        showStatus('Products synced, but the wishlist region setting could not be saved. Re-enter the wishlist URL to retry.', 'error');
        return;
      }
      showStatus(
        response.paused
          ? `${response.items.length} products found before Amazon paused background reads were refreshed. Wait for the pause to end before syncing again.`
          : response.limited
            ? `Wishlist sync refreshed ${response.items.length} products from a bounded partial read.`
          : `Wishlist synced (${response.items.length} products refreshed).`,
        response.limited || response.paused ? 'info' : 'success'
      );
    });
  };

  const updateSelectionCounter = () => {
    const counter = document.getElementById('selection-counter');
    const checkedCount = selectedWishlistIndices.size;
    if (counter) counter.textContent = `${checkedCount} / ${extractedWishlistItems.length} selected`;
    selectAllCheckbox.checked = extractedWishlistItems.length > 0 && checkedCount === extractedWishlistItems.length;
    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < extractedWishlistItems.length;
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
    selectedWishlistIndices = e.target.checked
      ? new Set(extractedWishlistItems.map((_, index) => index))
      : new Set();
    renderSelectionPage();
  });

  cancelBtn.addEventListener('click', () => {
    clearSelectionStatus();
    closeSecondaryView(selectionView);
  });

  if (closeDetailsBtn) {
    closeDetailsBtn.addEventListener('click', () => {
      closeSecondaryView(detailsView);
    });
  }

  confirmBtn.addEventListener('click', () => {
    const selectedItems = [...selectedWishlistIndices]
      .sort((a, b) => a - b)
      .map(index => extractedWishlistItems[index])
      .filter(Boolean);

    if (selectedItems.length === 0) {
      showSelectionStatus('Select at least one product to continue.', 'error');
      selectAllCheckbox.focus();
      return;
    }

    confirmBtn.textContent = 'Adding...';
    confirmBtn.disabled = true;

    const wishlistId = getWishlistId(currentWishlistUrl);
    const sourcedItems = selectedItems.map(item => ({
      ...item,
      wishlistIds: wishlistId ? [wishlistId] : []
    }));
    chrome.runtime.sendMessage({
      type: 'BULK_ADD_TRACKED_ITEMS',
      items: sourcedItems,
      historyGeneration: extractedWishlistHistoryGeneration
    }, async (response) => {
      confirmBtn.textContent = 'Confirm Tracking';
      confirmBtn.disabled = false;
      
      if (chrome.runtime.lastError || !response || !response.success) {
        showSelectionStatus('Could not add the selected products. Try again.', 'error');
      } else {
        // Save the tracked wishlist and autoSync setting
        const autoSyncCheckbox = document.getElementById('auto-sync-checkbox');
        const isAutoSync = autoSyncCheckbox ? autoSyncCheckbox.checked : false;

        const wishlistResponse = currentWishlistUrl
          ? await sendBackgroundMessage({
              type: 'UPSERT_TRACKED_WISHLIST',
              url: currentWishlistUrl,
              autoSync: isAutoSync
            })
          : { success: true };

        wishlistInput.value = '';
        clearSelectionStatus();
        closeSecondaryView(selectionView);
        await renderItems();
        if (!wishlistResponse.success) {
          showStatus(`${selectedItems.length} product${selectedItems.length === 1 ? '' : 's'} added, but the wishlist region setting could not be saved.`, 'error');
        } else {
          showStatus(`${selectedItems.length} product${selectedItems.length === 1 ? '' : 's'} added.`, 'success');
        }
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
        showStatus('That product is hidden by the current search or filter. Clear the filters and try again.', 'error');
      }
    });
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', async () => {
      visibleItemLimit = PAGE_SIZE;
      if (itemList) itemList.scrollTop = 0;
      renderItems();
      try {
        await saveDashboardPreference('dashboardSort', sortSelect.value);
      } catch (_error) {
        showStatus('Could not save the sorting preference.', 'error');
      }
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
      const currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.has('filter')) {
        currentUrl.searchParams.delete('filter');
        window.history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      }
      visibleItemLimit = PAGE_SIZE;
      if (itemList) itemList.scrollTop = 0;
      renderItems();
      try {
        await saveDashboardPreference('dashboardFilter', filterSelect.value);
      } catch (_error) {
        showStatus('Could not save the filter preference.', 'error');
      }
    });
  }

  async function renderItems() {
    const savedScrollTop = itemList ? itemList.scrollTop : 0;
    itemList.replaceChildren();
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
        captchaBanner.hidden = false;
      } else {
        captchaBanner.hidden = true;
      }
    }

    const mainTitle = document.getElementById('main-title');
    if (mainTitle) {
      mainTitle.textContent = `Tracked Items (${items.length})`;
    }

    const trackedWishlists = await getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL) || [];

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
      setEmptyState('No matching products found.', 'Try a different title, author, ASIN, status, or target search.');
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
    if (appContainer.classList.contains('show-all-charts') && visibleItems.length > 10) {
      appContainer.classList.remove('show-all-charts');
      toggleAllChartsBtn.textContent = 'Expand Visible Histories';
      toggleAllChartsBtn.setAttribute('aria-expanded', 'false');
    }

    visibleItems.forEach((item) => {
      const clone = template.content.cloneNode(true);
      const card = clone.querySelector('.item-card');
      card.dataset.id = item.id;
      const accessibleTitleId = `item-title-${String(item.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
      card.setAttribute('aria-labelledby', accessibleTitleId);
      
      const chartBtn = clone.querySelector('.chart-btn');
      if (chartBtn) {
        const globallyExpanded = appContainer.classList.contains('show-all-charts');
        chartBtn.setAttribute('aria-expanded', String(globallyExpanded));
        chartBtn.textContent = globallyExpanded ? 'History shown' : 'History';
        chartBtn.disabled = globallyExpanded;
        chartBtn.addEventListener('click', () => {
          card.classList.toggle('show-graph');
          const isExpanded = card.classList.contains('show-graph');
          chartBtn.setAttribute('aria-expanded', String(isExpanded));
          chartBtn.textContent = isExpanded ? 'Hide history' : 'History';
          if (isExpanded) {
            requestAnimationFrame(prepareChart);
          }
        });
      }

      const priorityBtn = clone.querySelector('.priority-btn');
      if (item.isPriority) {
        priorityBtn.classList.add('active');
        priorityBtn.setAttribute('aria-pressed', 'true');
        priorityBtn.title = 'Turn off fast checks';
      } else {
        priorityBtn.setAttribute('aria-pressed', 'false');
        priorityBtn.title = 'Turn on fast checks';
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
          priorityBtn.classList.toggle('active', item.isPriority);
          priorityBtn.setAttribute('aria-pressed', String(item.isPriority));
          priorityBtn.title = item.isPriority ? 'Turn off fast checks' : 'Turn on fast checks';
          showStatus(item.isPriority ? 'Fast checks turned on.' : 'Fast checks turned off.', 'success');
          const index = items.findIndex(i => i.id === item.id);
          if (index > -1) items[index].isPriority = item.isPriority;
        } catch (error) {
          showStatus('Could not change the checking speed. Try again.', 'error');
        } finally {
          priorityBtn.disabled = false;
        }
      });

      const titleEl = clone.querySelector('.item-title');
      titleEl.textContent = item.title || 'Unknown Product';
      titleEl.id = accessibleTitleId;
      
      const imgEl = clone.querySelector('.item-image');
      const safeImageUrl = sanitizeAmazonImageUrl(item.imageUrl || '');
      if (safeImageUrl) {
        imgEl.src = safeImageUrl;
        imgEl.style.display = 'block';
      }
      
      const storedProductUrl = normalizeStoredAmazonProductUrl(item.url, item.id);
      const associatedOrigins = new Set((item.wishlistIds || []).flatMap((wishlistId) => {
        const wishlist = trackedWishlists.find((entry) => typeof entry !== 'string' && entry?.id === wishlistId);
        const parsedWishlist = parseCanonicalAmazonWishlistUrl(wishlist?.url || '');
        return parsedWishlist ? [parsedWishlist.origin] : [];
      }));
      const fallbackOrigin = associatedOrigins.size === 1 ? [...associatedOrigins][0] : null;
      const productUrl = storedProductUrl || (fallbackOrigin ? `${fallbackOrigin}/dp/${item.id}` : null);
      if (productUrl) {
        titleEl.href = productUrl;
      } else {
        titleEl.removeAttribute('href');
        titleEl.title = 'Amazon region unknown. Re-import the source wishlist to restore this link.';
      }
      
      clone.querySelector('.item-price').textContent = formatPrice(item.currentPrice, item.currency);

      // Same baseline and 0.5% threshold as the popup highlights; a drop is good news, so down = green.
      const trackingChangeEl = clone.querySelector('.tracking-change');
      const trackingChange = getTrackingChange(item, history[item.id]);
      if (trackingChangeEl && trackingChange) {
        const { percent, amount, baseline } = trackingChange;
        trackingChangeEl.hidden = false;
        trackingChangeEl.className = `tracking-change ${percent < 0 ? 'change-down' : 'change-up'}`;
        trackingChangeEl.textContent = `${percent < 0 ? '▼' : '▲'} ${Math.abs(percent).toFixed(0)}% · ${formatPrice(Math.abs(amount), item.currency)}`;
        const since = Number.isFinite(baseline.timestamp) ? ` on ${new Date(baseline.timestamp).toLocaleDateString()}` : '';
        trackingChangeEl.title = baseline.exact
          ? `Since tracking started${since} at ${formatPrice(baseline.price, item.currency)}`
          : `Since earliest retained sample${since} at ${formatPrice(baseline.price, item.currency)}`;
      }

      const discountInfoEl = clone.querySelector('.discount-info');
      const originalPriceEl = clone.querySelector('.original-price');
      const discountBadgeEl = clone.querySelector('.discount-badge');

      const priceDrop = getPriceDropDetails(item);
      if (priceDrop) {
        discountInfoEl.hidden = false;
        originalPriceEl.textContent = formatPrice(priceDrop.whenAddedPrice, item.currency);
        discountBadgeEl.textContent = formatPriceDropBadge(priceDrop, item.currency);
      }

      const targetEl = clone.querySelector('.target-price');
      const renderTargetLabel = () => {
        const hasTarget = Number.isFinite(item.targetPrice) && item.targetPrice > 0;
        const targetReached = hasTarget && Number.isFinite(item.currentPrice) && item.currentPrice <= item.targetPrice;
        targetEl.classList.toggle('target-reached', targetReached);
        targetEl.textContent = !hasTarget
          ? 'No target set'
          : targetReached
            ? `✓ Target ${formatPrice(item.targetPrice, item.currency)} reached`
            : `Target: ${formatPrice(item.targetPrice, item.currency)}`;
      };
      renderTargetLabel();

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
      const chartTooltip = clone.querySelector('.chart-tooltip');
      const chartMeta = clone.querySelector('.chart-meta');
      const chartSamples = clone.querySelector('.chart-samples');
      const itemHistory = history[item.id] || [];
      let chartPrepared = false;
      const prepareChart = () => {
        if (chartPrepared) return;
        chartPrepared = true;
        if (itemHistory.length > 0) {
          renderChartMeta(chartMeta, itemHistory, item);
          renderChartSamples(chartSamples, itemHistory, item.currency);
          setupPriceChart(canvas, chartTooltip, itemHistory, item);
        }
      };
      if (itemHistory.length === 0) {
        const placeholder = document.createElement('p');
        placeholder.className = 'chart-empty';
        placeholder.textContent = item.lastChecked
          ? `No price history yet. Last checked ${formatTimestamp(item.lastChecked)}.`
          : 'No price history yet. The first successful price check will add a timestamp.';
        canvas.closest('.chart-plot').replaceWith(placeholder);
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
        } catch (error) {
          removeBtn.disabled = false;
          removeBtn.classList.remove('confirming');
          removeBtn.textContent = 'Remove';
          showStatus('Could not remove this product. Try again.', 'error');
        }
      });

      const detailsBtn = clone.querySelector('.details-btn');
      if (detailsBtn) {
        if (itemHistory.length === 0) detailsBtn.textContent = 'Product details';
        detailsBtn.addEventListener('click', () => {
          document.getElementById('details-product-name').textContent = item.title;
          document.getElementById('details-current-price').textContent = formatPrice(item.currentPrice, item.currency);
          document.getElementById('details-stock-status').textContent = item.inStock ? 'In Stock' : 'Out of Stock';
          const detailsTarget = document.getElementById('details-target-price');
          const detailsTargetReached = Number.isFinite(item.targetPrice) && item.targetPrice > 0 &&
            Number.isFinite(item.currentPrice) && item.currentPrice <= item.targetPrice;
          detailsTarget.textContent = item.targetPrice
            ? `${formatPrice(item.targetPrice, item.currency)}${detailsTargetReached ? ' ✓ reached' : ''}`
            : 'No target set';
          detailsTarget.classList.toggle('target-reached', detailsTargetReached);
          const detailsDiscount = document.getElementById('details-discount-info');
          if (detailsDiscount) {
            const priceDropSummary = formatPriceDropSummary(item);
            if (priceDropSummary) {
              detailsDiscount.textContent = priceDropSummary;
              detailsDiscount.hidden = false;
            } else {
              detailsDiscount.hidden = true;
            }
          }
          
          renderDetailsHistory(document.getElementById('details-history-list'), itemHistory, item.currency);
          
          openSecondaryView(detailsView, detailsTitle, detailsBtn);
        });
      }

      const editBtn = clone.querySelector('.edit-btn');
      const targetEditor = clone.querySelector('.target-editor');
      const targetInput = clone.querySelector('.target-editor-input');
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

      targetCancelBtn.addEventListener('click', () => {
        closeTargetEditor();
        editBtn.focus();
      });
      targetInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        closeTargetEditor();
        editBtn.focus();
      });
      targetEditor.addEventListener('submit', async (event) => {
        event.preventDefault();
        const rawValue = targetInput.value.trim();
        const parsed = rawValue === '' ? null : Number(rawValue);
        if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
          showStatus('Please enter a valid price or leave it empty to clear.', 'error');
          return;
        }

        const saveButton = targetEditor.querySelector('.target-save-btn');
        saveButton.disabled = true;
        try {
          await updateTrackedItem({ id: item.id, targetPrice: parsed });
          item.targetPrice = parsed;
          renderTargetLabel();
          if (chartPrepared) {
            renderChartMeta(chartMeta, itemHistory, item);
            chartRedrawers.get(canvas)?.();
          }
          closeTargetEditor();
          showStatus(parsed ? 'Target price updated.' : 'Target price cleared.', 'success');
          editBtn.focus();
        } catch (error) {
          showStatus('Could not save the target price. Try again.', 'error');
          targetInput.focus();
        } finally {
          saveButton.disabled = false;
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

  await renderItems();

  // Auto-trigger import if launched with ?import=URL
  const importUrl = startupParams.get('import');
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

function formatChartDate(timestamp, style = 'day') {
  const date = new Date(timestamp);
  if (style === 'time') {
    return date.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  if (style === 'month') {
    return date.toLocaleDateString([], { month: 'short', year: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatChartDateTime(timestamp) {
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatPriceChange(change, currency, percent) {
  const arrow = change < 0 ? '▼' : '▲';
  const percentText = Number.isFinite(percent) ? ` (${Math.abs(percent).toFixed(1)}%)` : '';
  return `${arrow} ${formatPrice(Math.abs(change), currency)}${percentText}`;
}

function appendChip(container, text, className = '') {
  const chip = document.createElement('span');
  if (className) chip.className = className;
  chip.textContent = text;
  container.appendChild(chip);
}

function renderChartMeta(container, dataPoints, item) {
  if (!container) return;
  const summary = summarizeHistory(dataPoints);
  container.replaceChildren();
  if (!summary) {
    container.style.display = 'none';
    return;
  }
  const { currency } = item;
  container.style.display = 'flex';

  appendChip(container, `Now ${formatPrice(summary.latest.price, currency)} · ${formatChartDateTime(summary.latest.timestamp)}`, 'chip-strong');
  if (summary.change === 0) {
    appendChip(container, `No change since ${formatChartDate(summary.first.timestamp)}`);
  } else {
    appendChip(
      container,
      `${formatPriceChange(summary.change, currency, summary.changePercent)} since ${formatChartDate(summary.first.timestamp)}`,
      summary.change < 0 ? 'chip-drop' : 'chip-rise'
    );
  }
  if (summary.low.price !== summary.high.price) {
    const lowWhen = summary.low === summary.latest ? `since ${formatChartDate(summary.lowFrom)}` : formatChartDate(summary.lowFrom);
    const highWhen = summary.high === summary.latest ? `since ${formatChartDate(summary.highFrom)}` : formatChartDate(summary.highFrom);
    appendChip(container, `Low ${formatPrice(summary.low.price, currency)} · ${lowWhen}`);
    appendChip(container, `High ${formatPrice(summary.high.price, currency)} · ${highWhen}`);
  }
  if (Number.isFinite(item.targetPrice) && item.targetPrice > 0) {
    const gap = summary.latest.price - item.targetPrice;
    appendChip(
      container,
      gap <= 0
        ? `Target ${formatPrice(item.targetPrice, currency)} reached`
        : `${formatPrice(gap, currency)} above target`,
      gap <= 0 ? 'chip-drop' : 'chip-target'
    );
  }
  const changeText = summary.changeCount === 0
    ? 'no price changes'
    : `${summary.changeCount} price change${summary.changeCount === 1 ? '' : 's'}`;
  appendChip(container, `${summary.sampleCount} stored sample${summary.sampleCount === 1 ? '' : 's'} · ${changeText}`);
}

const MAX_DETAIL_ROWS = 500;

// Full history as held-price runs, newest first. Raw samples repeat the same price on
// every check, so listing them individually buries the actual changes (and can mean
// thousands of DOM rows).
function renderDetailsHistory(container, dataPoints, currency) {
  container.replaceChildren();
  const segments = priceSegments(dataPoints);
  if (segments.length === 0) {
    const empty = document.createElement('em');
    empty.textContent = 'No price history recorded yet.';
    container.appendChild(empty);
    return;
  }

  const sampleCount = segments.reduce((sum, segment) => sum + segment.samples, 0);
  const intro = document.createElement('p');
  intro.className = 'details-history-intro';
  intro.textContent = `${sampleCount} stored sample${sampleCount === 1 ? '' : 's'} grouped into ${segments.length} price period${segments.length === 1 ? '' : 's'}, newest first.`;
  container.appendChild(intro);

  for (let index = segments.length - 1; index >= Math.max(0, segments.length - MAX_DETAIL_ROWS); index--) {
    const segment = segments[index];
    const previous = segments[index - 1];
    const until = segments[index + 1]?.from ?? null;

    const row = document.createElement('div');
    row.className = 'history-row';

    const when = document.createElement('span');
    when.className = 'history-when';
    const period = until === null
      ? `Since ${formatChartDateTime(segment.from)}`
      : `${formatChartDateTime(segment.from)} → ${formatChartDateTime(until)}`;
    const held = (until ?? segment.to) - segment.from;
    const detail = document.createElement('small');
    detail.textContent = `${held > 0 ? `${formatDuration(held)} · ` : ''}${segment.samples} check${segment.samples === 1 ? '' : 's'}`;
    when.append(period, detail);

    const value = document.createElement('span');
    value.className = 'chart-sample-value';
    const price = document.createElement('strong');
    price.textContent = formatPrice(segment.price, currency);
    value.appendChild(price);
    if (previous) {
      const change = segment.price - previous.price;
      const delta = document.createElement('span');
      delta.className = change < 0 ? 'delta-drop' : 'delta-rise';
      delta.textContent = formatPriceChange(change, currency, previous.price > 0 ? (change / previous.price) * 100 : null);
      value.appendChild(delta);
    }

    row.append(when, value);
    container.appendChild(row);
  }

  if (segments.length > MAX_DETAIL_ROWS) {
    const more = document.createElement('p');
    more.className = 'details-history-intro';
    more.textContent = `${segments.length - MAX_DETAIL_ROWS} older price periods are stored but not listed. Export a backup from Settings for the complete data.`;
    container.appendChild(more);
  }
}

const MAX_CHANGE_ROWS = 6;

function renderChartSamples(container, dataPoints, currency) {
  if (!container) return;
  const segments = priceSegments(dataPoints);
  container.replaceChildren();
  if (segments.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'grid';

  const heading = document.createElement('h4');
  heading.className = 'chart-samples-title';
  heading.textContent = segments.length === 1 ? 'Price held' : 'Price changes (newest first)';
  container.appendChild(heading);

  // A price is considered held until the check that first saw the next price.
  const newestFirst = segments.map((segment, index) => ({
    segment,
    previous: segments[index - 1],
    until: segments[index + 1]?.from ?? null
  })).reverse();
  newestFirst.slice(0, MAX_CHANGE_ROWS).forEach(({ segment, previous, until }) => {
    const row = document.createElement('div');
    row.className = 'chart-sample';

    const when = document.createElement('span');
    const period = until === null
      ? `Since ${formatChartDateTime(segment.from)}`
      : `${formatChartDateTime(segment.from)} → ${formatChartDateTime(until)}`;
    const checks = `${segment.samples} check${segment.samples === 1 ? '' : 's'}`;
    const held = (until ?? segment.to) - segment.from;
    when.textContent = held > 0 ? `${period} · ${formatDuration(held)}, ${checks}` : `${period} · ${checks}`;

    const value = document.createElement('span');
    value.className = 'chart-sample-value';
    const price = document.createElement('strong');
    price.textContent = formatPrice(segment.price, currency);
    value.appendChild(price);
    if (previous) {
      const change = segment.price - previous.price;
      const delta = document.createElement('span');
      delta.className = change < 0 ? 'delta-drop' : 'delta-rise';
      delta.textContent = formatPriceChange(change, currency, previous.price > 0 ? (change / previous.price) * 100 : null);
      value.appendChild(delta);
    }

    row.appendChild(when);
    row.appendChild(value);
    container.appendChild(row);
  });

  if (segments.length > MAX_CHANGE_ROWS) {
    const more = document.createElement('p');
    more.className = 'chart-samples-more';
    more.textContent = `${segments.length - MAX_CHANGE_ROWS} older change${segments.length - MAX_CHANGE_ROWS === 1 ? '' : 's'} — see “Full price history”.`;
    container.appendChild(more);
  }
}

function readChartColors() {
  const styles = getComputedStyle(document.documentElement);
  const value = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    line: value('--focus', '#0e806c'),
    text: value('--text', '#172033'),
    muted: value('--muted', '#5f6b7a'),
    grid: value('--border', '#d7dee5'),
    surface: value('--surface', '#ffffff'),
    low: value('--success', '#087a55'),
    high: value('--danger', '#b42318'),
    target: value('--warning', '#8a4b08')
  };
}

// Step-after price chart on a time axis: a price holds until the next observed change,
// so plateaus are as wide as the time they actually lasted.
function setupPriceChart(canvas, tooltip, dataPoints, item) {
  const points = validHistory(dataPoints);
  if (points.length === 0 || !canvas) return;
  const { currency } = item;
  const summary = summarizeHistory(points);
  const segments = priceSegments(points);
  const segmentStarts = segments.map((segment) => ({ timestamp: segment.from }));

  const startTime = points[0].timestamp;
  const endTime = points[points.length - 1].timestamp;
  const span = endTime - startTime;
  const labelStyle = timeLabelStyle(span);

  let activeSegment = null;
  let layout = null;

  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.removeAttribute('aria-hidden');
  canvas.setAttribute('aria-label', [
    `Price history from ${formatChartDateTime(startTime)} to ${formatChartDateTime(endTime)}.`,
    `Now ${formatPrice(summary.latest.price, currency)}, low ${formatPrice(summary.low.price, currency)}, high ${formatPrice(summary.high.price, currency)}.`,
    'Use left and right arrow keys to step through price changes.'
  ].join(' '));

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width < 40 || height < 40) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const colors = readChartColors();

    const target = Number.isFinite(item.targetPrice) && item.targetPrice > 0 ? item.targetPrice : null;
    // Only pull the target into view when it would not flatten the actual price movement.
    const targetInView = target !== null && target >= summary.low.price * 0.5 && target <= summary.high.price * 1.5;
    const domainPrices = targetInView ? [summary.low.price, summary.high.price, target] : [summary.low.price, summary.high.price];
    const yTicks = niceTicks(Math.min(...domainPrices), Math.max(...domainPrices), 4);
    const yMin = yTicks[0];
    const yMax = yTicks[yTicks.length - 1];

    ctx.font = '11px Inter, system-ui, sans-serif';
    const yLabels = yTicks.map((value) => formatPrice(value, currency));
    const left = Math.ceil(Math.max(...yLabels.map((label) => ctx.measureText(label).width))) + 16;
    const right = 16;
    const top = 22;
    const bottom = 26;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const xOf = (timestamp) => span === 0 ? left + plotWidth / 2 : left + ((timestamp - startTime) / span) * plotWidth;
    const yOf = (price) => top + ((yMax - price) / (yMax - yMin)) * plotHeight;
    layout = { left, right, top, bottom, width, height, plotWidth, xOf, yOf };

    // Horizontal grid + price labels.
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    yTicks.forEach((value, index) => {
      const y = Math.round(yOf(value)) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.globalAlpha = index === 0 ? 1 : 0.6;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(width - right, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.muted;
      ctx.fillText(yLabels[index], left - 8, y);
    });

    // Date labels along the bottom.
    ctx.textBaseline = 'alphabetic';
    const tickCount = Math.max(2, Math.min(5, Math.floor(plotWidth / 110)));
    const xTicks = timeTicks(startTime, endTime, tickCount);
    xTicks.forEach((timestamp, index) => {
      const x = xOf(timestamp);
      ctx.textAlign = xTicks.length === 1 ? 'center' : index === 0 ? 'left' : index === xTicks.length - 1 ? 'right' : 'center';
      ctx.fillStyle = colors.muted;
      ctx.fillText(formatChartDate(timestamp, labelStyle), x, height - 8);
    });

    // Target reference line.
    if (targetInView) {
      const y = Math.round(yOf(target)) + 0.5;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = colors.target;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(width - right, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = colors.target;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`Target ${formatPrice(target, currency)}`, left + 4, y - 3);
    }

    // Step path: horizontal until the next sample, then vertical to the new price.
    const tracePath = () => {
      ctx.beginPath();
      points.forEach((point, index) => {
        const x = xOf(point.timestamp);
        const y = yOf(point.price);
        if (index === 0) ctx.moveTo(x, y);
        else {
          ctx.lineTo(x, yOf(points[index - 1].price));
          ctx.lineTo(x, y);
        }
      });
    };

    if (points.length > 1) {
      const baseY = yOf(yMin);
      tracePath();
      ctx.lineTo(xOf(endTime), baseY);
      ctx.lineTo(xOf(startTime), baseY);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = colors.line;
      ctx.fill();
      ctx.globalAlpha = 1;

      tracePath();
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = colors.line;
      ctx.stroke();
    }

    const drawMarker = (point, color, label, placeAbove) => {
      const x = xOf(point.timestamp);
      const y = yOf(point.price);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = colors.surface;
      ctx.stroke();
      if (!label) return;
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      const labelWidth = ctx.measureText(label).width;
      const labelX = Math.min(Math.max(x - labelWidth / 2, left + 2), width - right - labelWidth - 2);
      const labelY = placeAbove ? Math.max(y - 9, top - 6) : Math.min(y + 18, height - bottom - 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = color;
      ctx.fillText(label, labelX, labelY);
      ctx.font = '11px Inter, system-ui, sans-serif';
    };

    const hasRange = summary.low.price !== summary.high.price;
    const nowPrefix = (point) => point === summary.latest ? 'Now · ' : '';
    if (hasRange) {
      drawMarker(summary.high, colors.high, `${nowPrefix(summary.high)}High ${formatPrice(summary.high.price, currency)}`, true);
      drawMarker(summary.low, colors.low, `${nowPrefix(summary.low)}Low ${formatPrice(summary.low.price, currency)}`, false);
    }
    const latestIsExtreme = hasRange && (summary.latest === summary.low || summary.latest === summary.high);
    if (!latestIsExtreme) {
      drawMarker(summary.latest, colors.line, `Now ${formatPrice(summary.latest.price, currency)}`, true);
    }

    // Hover / keyboard focus crosshair.
    if (activeSegment !== null) {
      const segment = segments[activeSegment];
      const nextStart = segments[activeSegment + 1]?.from ?? endTime;
      const x0 = xOf(segment.from);
      const x1 = xOf(nextStart);
      const y = yOf(segment.price);
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = colors.text;
      ctx.fillRect(Math.min(x0, x1), top, Math.max(2, Math.abs(x1 - x0)), plotHeight);
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(Math.max(x1, x0 + 1), y);
      ctx.lineWidth = 4;
      ctx.strokeStyle = colors.line;
      ctx.stroke();
    }
  }

  function showTooltip(segmentIndex) {
    activeSegment = segmentIndex;
    draw();
    if (!tooltip || !layout) return;
    const segment = segments[segmentIndex];
    const previous = segments[segmentIndex - 1];
    const isCurrent = segmentIndex === segments.length - 1;

    const price = document.createElement('strong');
    price.textContent = formatPrice(segment.price, currency);
    const period = document.createElement('span');
    period.textContent = isCurrent
      ? `Since ${formatChartDateTime(segment.from)}`
      : `${formatChartDateTime(segment.from)} → ${formatChartDateTime(segments[segmentIndex + 1].from)}`;
    const detail = document.createElement('span');
    const held = (isCurrent ? endTime : segments[segmentIndex + 1].from) - segment.from;
    const parts = [`${segment.samples} check${segment.samples === 1 ? '' : 's'}`];
    if (held > 0) parts.unshift(`held ${formatDuration(held)}`);
    detail.textContent = parts.join(' · ');
    tooltip.replaceChildren(price, period, detail);
    if (previous) {
      const change = segment.price - previous.price;
      const delta = document.createElement('span');
      delta.className = change < 0 ? 'delta-drop' : 'delta-rise';
      delta.textContent = `${formatPriceChange(change, currency, previous.price > 0 ? (change / previous.price) * 100 : null)} vs before`;
      tooltip.appendChild(delta);
    }
    tooltip.hidden = false;

    const nextStart = segments[segmentIndex + 1]?.from ?? endTime;
    const anchorX = (layout.xOf(segment.from) + layout.xOf(nextStart)) / 2;
    const anchorY = layout.yOf(segment.price);
    const tipWidth = tooltip.offsetWidth;
    const tipHeight = tooltip.offsetHeight;
    const x = Math.min(Math.max(anchorX - tipWidth / 2, 4), layout.width - tipWidth - 4);
    const y = anchorY - tipHeight - 12 >= 0 ? anchorY - tipHeight - 12 : anchorY + 12;
    tooltip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function hideTooltip() {
    if (activeSegment === null) return;
    activeSegment = null;
    if (tooltip) tooltip.hidden = true;
    draw();
  }

  let pendingFrame = 0;
  canvas.addEventListener('pointermove', (event) => {
    if (!layout) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    cancelAnimationFrame(pendingFrame);
    pendingFrame = requestAnimationFrame(() => {
      const ratio = layout.plotWidth > 0 ? (x - layout.left) / layout.plotWidth : 0;
      const timestamp = startTime + Math.min(Math.max(ratio, 0), 1) * span;
      const index = activePointIndex(segmentStarts, timestamp);
      if (index !== activeSegment) showTooltip(index);
    });
  });
  canvas.addEventListener('pointerleave', () => {
    cancelAnimationFrame(pendingFrame);
    hideTooltip();
  });
  canvas.addEventListener('blur', hideTooltip);
  canvas.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideTooltip();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const fallback = event.key === 'ArrowLeft' ? segments.length : -1;
    const current = activeSegment ?? fallback;
    const next = Math.min(Math.max(current + (event.key === 'ArrowLeft' ? -1 : 1), 0), segments.length - 1);
    showTooltip(next);
  });

  // Charts first render while their card is expanding and must also follow window resizes.
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const nextWidth = Math.floor(entry.contentRect.width);
    if (nextWidth === lastWidth || nextWidth === 0) return;
    lastWidth = nextWidth;
    if (activeSegment !== null) showTooltip(activeSegment);
    else draw();
  }).observe(canvas);
  chartRedrawers.forEach((_, registered) => {
    if (!registered.isConnected) chartRedrawers.delete(registered);
  });
  chartRedrawers.set(canvas, draw);
}

// One theme listener for every chart; detached canvases drop out on the next change.
const chartRedrawers = new Map();
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  chartRedrawers.forEach((redraw, canvas) => {
    if (canvas.isConnected) redraw();
    else chartRedrawers.delete(canvas);
  });
});
