import { getStorageData, setStorageData, getTrackedItems, StorageKeys, StorageArea } from '../utils/storage.js';

document.addEventListener('DOMContentLoaded', async () => {
  const discountInput = document.getElementById('default-discount');
  const exportBtn = document.getElementById('export-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const settingsStatus = document.getElementById('settings-status');
  const legacyTargetMigration = document.getElementById('legacy-target-migration');
  const legacyTargetMessage = document.getElementById('legacy-target-message');
  const legacyTargetApplyBtn = document.getElementById('legacy-target-apply-btn');
  const legacyTargetDismissBtn = document.getElementById('legacy-target-dismiss-btn');

  const retentionSelect = document.getElementById('history-retention');
  let statusTimer = null;
  let settings = {};

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

  function showStatus(message) {
    if (!settingsStatus) return;
    settingsStatus.textContent = message;
    settingsStatus.classList.add('visible');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      settingsStatus.classList.remove('visible');
    }, 3000);
  }

  async function updateSettings(mutator, failureMessage = 'Could not save settings. Try again.') {
    const nextSettings = { ...settings };
    mutator(nextSettings);
    try {
      await setStorageData(StorageKeys.SETTINGS, nextSettings);
      settings = nextSettings;
      return true;
    } catch (_error) {
      // Keep the in-memory legacy value too. A later unrelated preference write
      // must not silently acknowledge or discard a migration the user could
      // not persist.
      showStatus(failureMessage);
      return false;
    }
  }

  function hideLegacyTargetMigration() {
    if (legacyTargetMigration) legacyTargetMigration.hidden = true;
  }

  async function renderLegacyTargetMigration() {
    const targetPrice = Number(settings.defaultTargetPrice);
    if (!Number.isFinite(targetPrice) || !legacyTargetMigration) {
      hideLegacyTargetMigration();
      return;
    }

    legacyTargetMigration.hidden = false;
    if (legacyTargetApplyBtn) legacyTargetApplyBtn.hidden = true;
    if (legacyTargetMessage) {
      legacyTargetMessage.textContent = targetPrice > 0
        ? `A previous version saved ${targetPrice.toFixed(2)} as one default target price. A number without a currency cannot safely be applied to products from different Amazon regions. It will remain saved until you choose an action.`
        : 'A previous version saved an invalid default target price. It will remain saved until you acknowledge it; it cannot be copied to products.';
    }

    try {
      const items = await getTrackedItems();
      const itemCurrencies = items.map((item) => typeof item.currency === 'string' ? item.currency.trim() : '');
      const currencies = [...new Set(itemCurrencies)];
      const allItemsHaveOneKnownCurrency = items.length > 0 && itemCurrencies.every(Boolean) && currencies.length === 1;
      const eligibleItems = allItemsHaveOneKnownCurrency
        ? items.filter((item) => item.currency === currencies[0] && !Number.isFinite(item.targetPrice))
        : [];

      if (targetPrice > 0 && allItemsHaveOneKnownCurrency && eligibleItems.length > 0 && legacyTargetApplyBtn) {
        const [currency] = currencies;
        legacyTargetApplyBtn.hidden = false;
        legacyTargetApplyBtn.textContent = `Apply ${currency}${targetPrice.toFixed(2)} to ${eligibleItems.length} ${currency} product${eligibleItems.length === 1 ? '' : 's'}`;
        legacyTargetApplyBtn.dataset.currency = currency;
        legacyTargetApplyBtn.dataset.expectedCount = String(eligibleItems.length);
      } else if (legacyTargetMessage) {
        legacyTargetMessage.textContent += ' Set targets individually in the Dashboard, then acknowledge this legacy value when you are done.';
      }
    } catch (_error) {
      if (legacyTargetMessage) {
        legacyTargetMessage.textContent += ' Product currencies could not be read right now, so no automatic copy is available.';
      }
    }
  }

  async function loadSettings() {
    try {
      settings = await getStorageData(StorageKeys.SETTINGS) || {};
      if (settings.defaultDiscount) discountInput.value = settings.defaultDiscount;
      retentionSelect.value = settings.historyRetentionDays || '30';
      await renderLegacyTargetMigration();
    } catch (_error) {
      showStatus('Could not load saved settings. Controls are still available; try again.');
    }
  }

  // Save on change
  discountInput.addEventListener('change', async (e) => {
    const value = parseInt(e.target.value, 10);
    if (e.target.value === '') {
      if (await updateSettings((next) => delete next.defaultDiscount)) {
        showStatus('Default discount cleared.');
      }
      return;
    }
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      showStatus('Enter a discount from 1 to 99.');
      return;
    }
    if (await updateSettings((next) => { next.defaultDiscount = value; })) {
      showStatus('Default discount saved.');
    }
  });

  retentionSelect.addEventListener('change', async (e) => {
    if (await updateSettings((next) => { next.historyRetentionDays = e.target.value; })) {
      showStatus('History retention saved.');
    }
  });

  legacyTargetApplyBtn?.addEventListener('click', async () => {
    const targetPrice = Number(settings.defaultTargetPrice);
    const currency = legacyTargetApplyBtn.dataset.currency;
    const expectedCount = Number(legacyTargetApplyBtn.dataset.expectedCount);
    legacyTargetApplyBtn.disabled = true;
    try {
      const response = await sendBackgroundMessage({ type: 'MIGRATE_LEGACY_TARGET_PRICE', targetPrice, currency, expectedCount });
      if (!response.success || response.updated !== expectedCount) throw new Error(response.error || 'Failed to copy legacy target price');
      if (!await updateSettings((next) => delete next.defaultTargetPrice, 'Targets were copied, but the legacy value could not be acknowledged. Try again.')) return;
      hideLegacyTargetMigration();
      showStatus(`Legacy target copied to ${response.updated} product${response.updated === 1 ? '' : 's'}.`);
    } catch (_error) {
      showStatus('Could not migrate the legacy target. Try again.');
    } finally {
      legacyTargetApplyBtn.disabled = false;
    }
  });

  legacyTargetDismissBtn?.addEventListener('click', async () => {
    legacyTargetDismissBtn.disabled = true;
    try {
      if (await updateSettings((next) => delete next.defaultTargetPrice, 'Could not acknowledge the legacy target. It is still saved; try again.')) {
        hideLegacyTargetMigration();
        showStatus('Legacy target acknowledged. Existing product targets were not changed.');
      }
    } finally {
      legacyTargetDismissBtn.disabled = false;
    }
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
    downloadAnchor.setAttribute("download", "amazon_tracker_export.json");
    document.body.appendChild(downloadAnchor); // Required for Firefox, safe for Chrome
    downloadAnchor.click();
    downloadAnchor.remove();
    showStatus('Export downloaded.');
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
      const response = await sendBackgroundMessage({ type: 'CLEAR_PRICE_HISTORY' });
      if (!response.success) throw new Error(response.error || 'Failed to clear price history');
      showStatus('Price history cleared.');
    } catch (_error) {
      showStatus('Could not clear price history. Try again.');
    } finally {
      clearHistoryBtn.classList.remove('confirming');
      clearHistoryBtn.textContent = 'Clear Price History';
      clearHistoryBtn.disabled = false;
    }
  });

  // Attach every control before async storage reads so a failed migration
  // acknowledgement or transient sync error cannot strand the Options page.
  await loadSettings();
});
