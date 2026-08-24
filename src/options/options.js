import { getStorageData, setStorageData, getTrackedItems, StorageKeys, StorageArea } from '../utils/storage.js';

document.addEventListener('DOMContentLoaded', async () => {
  const discountInput = document.getElementById('default-discount');
  const exportBtn = document.getElementById('export-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const settingsStatus = document.getElementById('settings-status');

  const retentionSelect = document.getElementById('history-retention');
  let statusTimer = null;

  function showStatus(message, type = 'info') {
    if (!settingsStatus) return;
    settingsStatus.textContent = message;
    settingsStatus.className = `settings-status visible${type === 'error' ? ' error' : ''}`;
    settingsStatus.setAttribute('role', type === 'error' ? 'alert' : 'status');
    clearTimeout(statusTimer);
    if (type !== 'error') {
      statusTimer = setTimeout(() => {
        settingsStatus.classList.remove('visible');
      }, 3000);
    }
  }

  // Load current settings
  const settings = await getStorageData(StorageKeys.SETTINGS) || {};
  if (settings.defaultDiscount) {
    discountInput.value = settings.defaultDiscount;
  }
  if (settings.defaultTargetPrice != null) {
    delete settings.defaultTargetPrice;
    await setStorageData(StorageKeys.SETTINGS, settings);
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
      try {
        delete settings.defaultDiscount;
        await setStorageData(StorageKeys.SETTINGS, settings);
        e.target.removeAttribute('aria-invalid');
        showStatus('Default discount cleared.');
      } catch (error) {
        showStatus('Could not clear the default discount. Try again.', 'error');
      }
      return;
    }
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      e.target.setAttribute('aria-invalid', 'true');
      showStatus('Enter a discount from 1 to 99.', 'error');
      return;
    }
    try {
      settings.defaultDiscount = value;
      await setStorageData(StorageKeys.SETTINGS, settings);
      e.target.removeAttribute('aria-invalid');
      showStatus('Default discount saved.');
    } catch (error) {
      showStatus('Could not save the default discount. Try again.', 'error');
    }
  });

  retentionSelect.addEventListener('change', async (e) => {
    try {
      settings.historyRetentionDays = e.target.value;
      await setStorageData(StorageKeys.SETTINGS, settings);
      showStatus('History retention saved.');
    } catch (error) {
      showStatus('Could not save history retention. Try again.', 'error');
    }
  });

  // Export Data
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const items = await getTrackedItems();
      const history = await getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL);
      const exportObj = { items, history, exportedAt: new Date().toISOString() };
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute('download', 'saved_signal_backup.json');
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      showStatus('Export downloaded.');
    } catch (error) {
      showStatus('Could not export your data. Try again.', 'error');
    } finally {
      exportBtn.disabled = false;
    }
  });

  // Clear History
  let clearConfirmationTimer = null;
  clearHistoryBtn.addEventListener('click', async () => {
    if (!clearHistoryBtn.classList.contains('confirming')) {
      clearHistoryBtn.classList.add('confirming');
      clearHistoryBtn.textContent = 'Confirm Clear History';
      clearTimeout(clearConfirmationTimer);
      clearConfirmationTimer = setTimeout(() => {
        clearHistoryBtn.classList.remove('confirming');
        clearHistoryBtn.textContent = 'Clear Price History';
      }, 4000);
      return;
    }

    clearTimeout(clearConfirmationTimer);
    clearHistoryBtn.disabled = true;
    try {
      await setStorageData(StorageKeys.PRICE_HISTORY, {}, StorageArea.LOCAL);
      clearHistoryBtn.classList.remove('confirming');
      clearHistoryBtn.textContent = 'Clear Price History';
      showStatus('Price history cleared. Price tracking continues.');
    } catch (error) {
      showStatus('Could not clear price history. Try again.', 'error');
    } finally {
      clearHistoryBtn.disabled = false;
    }
  });
});
