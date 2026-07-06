import { getStorageData, setStorageData, getTrackedItems, StorageKeys, StorageArea } from '../utils/storage.js';

document.addEventListener('DOMContentLoaded', async () => {
  const discountInput = document.getElementById('default-discount');
  const targetPriceInput = document.getElementById('default-target-price');
  const exportBtn = document.getElementById('export-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const settingsStatus = document.getElementById('settings-status');

  const retentionSelect = document.getElementById('history-retention');
  let statusTimer = null;

  function showStatus(message) {
    if (!settingsStatus) return;
    settingsStatus.textContent = message;
    settingsStatus.classList.add('visible');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      settingsStatus.classList.remove('visible');
    }, 3000);
  }

  // Load current settings
  const settings = await getStorageData(StorageKeys.SETTINGS) || {};
  if (settings.defaultDiscount) {
    discountInput.value = settings.defaultDiscount;
  }
  if (settings.defaultTargetPrice) {
    targetPriceInput.value = settings.defaultTargetPrice;
  }
  if (settings.historyRetentionDays) {
    retentionSelect.value = settings.historyRetentionDays;
  } else {
    retentionSelect.value = "30";
  }

  // Save on change
  discountInput.addEventListener('change', async (e) => {
    const value = parseInt(e.target.value, 10);
    if (e.target.value === '') {
      delete settings.defaultDiscount;
      await setStorageData(StorageKeys.SETTINGS, settings);
      showStatus('Default discount cleared.');
      return;
    }
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      showStatus('Enter a discount from 1 to 99.');
      return;
    }
    settings.defaultDiscount = value;
    await setStorageData(StorageKeys.SETTINGS, settings);
    showStatus('Default discount saved.');
  });

  targetPriceInput.addEventListener('change', async (e) => {
    const value = parseFloat(e.target.value);
    if (e.target.value === '') {
      delete settings.defaultTargetPrice;
      await setStorageData(StorageKeys.SETTINGS, settings);
      showStatus('Default target price cleared.');
      return;
    }
    if (Number.isNaN(value) || value < 0) {
      showStatus('Enter a valid price.');
      return;
    }
    settings.defaultTargetPrice = value;
    await setStorageData(StorageKeys.SETTINGS, settings);
    showStatus('Default target price saved.');
  });

  retentionSelect.addEventListener('change', async (e) => {
    settings.historyRetentionDays = e.target.value;
    await setStorageData(StorageKeys.SETTINGS, settings);
    showStatus('History retention saved.');
  });

  // Export Data
  exportBtn.addEventListener('click', async () => {
    const items = await getTrackedItems();
    const history = await getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL);
    
    const exportObj = {
      items,
      history,
      exportedAt: new Date().toISOString()
    };
    
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "amazon_tracker_backup.json");
    document.body.appendChild(downloadAnchor); // Required for Firefox, safe for Chrome
    downloadAnchor.click();
    downloadAnchor.remove();
    showStatus('Export downloaded.');
  });

  // Clear History
  clearHistoryBtn.addEventListener('click', async () => {
    if (confirm("Are you sure you want to delete all price history? Tracked items will remain.")) {
      await setStorageData(StorageKeys.PRICE_HISTORY, {}, StorageArea.LOCAL);
      showStatus('Price history cleared.');
    }
  });
});
