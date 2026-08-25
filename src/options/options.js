import { getStorageData, getTrackedItems, StorageKeys, StorageArea } from '../utils/storage.js';
import { createBackupBlob, createBackupPayload, validateBackupPayload, MAX_BACKUP_BYTES } from '../utils/backup.js';

document.addEventListener('DOMContentLoaded', async () => {
  const discountInput = document.getElementById('default-discount');
  const exportBtn = document.getElementById('export-btn');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const chooseRestoreBtn = document.getElementById('choose-restore-btn');
  const restoreFileInput = document.getElementById('restore-file-input');
  const restoreBtn = document.getElementById('restore-btn');
  const restoreSummary = document.getElementById('restore-summary');
  const settingsStatus = document.getElementById('settings-status');
  const legacyTargetMigration = document.getElementById('legacy-target-migration');
  const legacyTargetMessage = document.getElementById('legacy-target-message');
  const legacyTargetApplyBtn = document.getElementById('legacy-target-apply-btn');
  const legacyTargetDismissBtn = document.getElementById('legacy-target-dismiss-btn');

  const retentionSelect = document.getElementById('history-retention');
  let statusTimer = null;
  let settings = {};
  let restoreCandidate = null;
  let restoreConfirmationTimer = null;

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

  async function updateSettings(patch, failureMessage = 'Could not save settings. Try again.') {
    try {
      const response = await sendBackgroundMessage({ type: 'PATCH_SETTINGS', ...patch });
      if (!response.success || !response.settings) {
        throw new Error(response.error || 'Failed to update settings');
      }
      settings = response.settings;
      return true;
    } catch (_error) {
      showStatus(failureMessage, 'error');
      return false;
    }
  }

  function hideLegacyTargetMigration() {
    if (legacyTargetMigration) legacyTargetMigration.hidden = true;
  }

  function resetRestoreSelection() {
    restoreCandidate = null;
    restoreFileInput.value = '';
    restoreBtn.hidden = true;
    restoreBtn.disabled = false;
    restoreBtn.classList.remove('confirming');
    restoreBtn.textContent = 'Restore Backup';
    restoreSummary.hidden = true;
    restoreSummary.textContent = '';
    clearTimeout(restoreConfirmationTimer);
  }

  function renderRestoredSettings(nextSettings) {
    settings = nextSettings;
    discountInput.value = Number.isInteger(settings.defaultDiscount)
      ? String(settings.defaultDiscount)
      : '';
    retentionSelect.value = settings.historyRetentionDays || '30';
    hideLegacyTargetMigration();
  }

  async function renderLegacyTargetMigration() {
    const targetPrice = Number(settings.defaultTargetPrice);
    if (!Object.hasOwn(settings, 'defaultTargetPrice') || !Number.isFinite(targetPrice) || !legacyTargetMigration) {
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
        legacyTargetApplyBtn.textContent = `Apply ${currency}${targetPrice.toFixed(2)} to ${eligibleItems.length} product${eligibleItems.length === 1 ? '' : 's'}`;
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

  // Load current settings
  try {
    settings = await getStorageData(StorageKeys.SETTINGS) || {};
    if (settings.defaultDiscount) discountInput.value = settings.defaultDiscount;
    retentionSelect.value = settings.historyRetentionDays || '30';
    await renderLegacyTargetMigration();
  } catch (_error) {
    retentionSelect.value = '30';
    showStatus('Could not load saved settings. Controls are still available; try again.', 'error');
  }

  // Save on change
  discountInput.addEventListener('change', async (e) => {
    const value = parseInt(e.target.value, 10);
    if (e.target.value === '') {
      if (await updateSettings({ remove: ['defaultDiscount'] })) {
        e.target.removeAttribute('aria-invalid');
        showStatus('Default discount cleared.');
      }
      return;
    }
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      e.target.setAttribute('aria-invalid', 'true');
      showStatus('Enter a discount from 1 to 99.', 'error');
      return;
    }
    if (await updateSettings({ set: { defaultDiscount: value } })) {
      e.target.removeAttribute('aria-invalid');
      showStatus('Default discount saved.');
    }
  });

  retentionSelect.addEventListener('change', async (e) => {
    if (await updateSettings({ set: { historyRetentionDays: e.target.value } })) {
      showStatus('History retention saved.');
    }
  });

  legacyTargetApplyBtn?.addEventListener('click', async () => {
    const targetPrice = Number(settings.defaultTargetPrice);
    const currency = legacyTargetApplyBtn.dataset.currency;
    const expectedCount = Number(legacyTargetApplyBtn.dataset.expectedCount);
    legacyTargetApplyBtn.disabled = true;
    try {
      const response = await sendBackgroundMessage({
        type: 'MIGRATE_LEGACY_TARGET_PRICE',
        targetPrice,
        currency,
        expectedCount
      });
      if (!response.success || response.updated !== expectedCount) {
        throw new Error(response.error || 'Failed to copy legacy target price');
      }
      settings = response.settings || settings;
      hideLegacyTargetMigration();
      showStatus(`Legacy target copied to ${response.updated} product${response.updated === 1 ? '' : 's'}.`);
    } catch (_error) {
      showStatus('Could not migrate the legacy target. Try again.', 'error');
    } finally {
      legacyTargetApplyBtn.disabled = false;
    }
  });

  legacyTargetDismissBtn?.addEventListener('click', async () => {
    legacyTargetDismissBtn.disabled = true;
    try {
      const targetPrice = Number(settings.defaultTargetPrice);
      const response = await sendBackgroundMessage({ type: 'ACKNOWLEDGE_LEGACY_TARGET_PRICE', targetPrice });
      if (!response.success) throw new Error(response.error || 'Failed to acknowledge legacy target');
      settings = response.settings || settings;
      hideLegacyTargetMigration();
      showStatus('Legacy target acknowledged. Existing product targets were not changed.');
    } catch (_error) {
      showStatus('Could not acknowledge the legacy target. It is still saved; reload and try again.', 'error');
    } finally {
      legacyTargetDismissBtn.disabled = false;
    }
  });

  // Export Data
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const items = await getTrackedItems();
      const [history, trackedWishlists, latestSettings] = await Promise.all([
        getStorageData(StorageKeys.PRICE_HISTORY, StorageArea.LOCAL),
        getStorageData(StorageKeys.TRACKED_WISHLISTS, StorageArea.LOCAL),
        getStorageData(StorageKeys.SETTINGS, StorageArea.SYNC)
      ]);
      const exportObj = createBackupPayload({
        items,
        history: history || {},
        trackedWishlists: trackedWishlists || [],
        settings: latestSettings || {}
      });
      const backupBlob = createBackupBlob(exportObj);
      const objectUrl = URL.createObjectURL(backupBlob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', objectUrl);
      downloadAnchor.setAttribute('download', 'saved_signal_backup.json');
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      showStatus(exportObj.historyPolicy.compacted
        ? 'Export downloaded. Older high-frequency samples were condensed.'
        : 'Export downloaded.');
    } catch (error) {
      showStatus(error.message || 'Could not export your data. Try again.', 'error');
    } finally {
      exportBtn.disabled = false;
    }
  });

  chooseRestoreBtn.addEventListener('click', () => restoreFileInput.click());

  restoreFileInput.addEventListener('change', async () => {
    const [file] = restoreFileInput.files || [];
    resetRestoreSelection();
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      showStatus('Backup is larger than the 32 MB safety limit.', 'error');
      return;
    }

    try {
      const parsed = JSON.parse(await file.text());
      restoreCandidate = validateBackupPayload(parsed);
      const { itemCount, historyPointCount, wishlistCount } = restoreCandidate.summary;
      restoreSummary.textContent = `Ready to restore ${itemCount} product${itemCount === 1 ? '' : 's'}, ${historyPointCount} history point${historyPointCount === 1 ? '' : 's'}, and ${wishlistCount} wishlist${wishlistCount === 1 ? '' : 's'}. Current local tracking data will be replaced.`;
      restoreSummary.hidden = false;
      restoreBtn.hidden = false;
      restoreBtn.focus();
      showStatus('Backup validated. Review the summary before restoring.');
    } catch (error) {
      restoreCandidate = null;
      showStatus(error.message || 'Could not validate this backup.', 'error');
    }
  });

  restoreBtn.addEventListener('click', async () => {
    if (!restoreCandidate) return;
    if (!restoreBtn.classList.contains('confirming')) {
      restoreBtn.classList.add('confirming');
      restoreBtn.textContent = 'Confirm Replace Local Data';
      clearTimeout(restoreConfirmationTimer);
      restoreConfirmationTimer = setTimeout(() => {
        restoreBtn.classList.remove('confirming');
        restoreBtn.textContent = 'Restore Backup';
      }, 4000);
      return;
    }

    clearTimeout(restoreConfirmationTimer);
    restoreBtn.disabled = true;
    try {
      const response = await sendBackgroundMessage({
        type: 'RESTORE_BACKUP',
        backup: restoreCandidate
      });
      if (!response.success) throw new Error(response.error || 'Restore failed');
      const restoredSettings = response.settings || { ...restoreCandidate.settings };
      resetRestoreSelection();
      renderRestoredSettings(restoredSettings);
      showStatus(`Backup restored: ${response.summary.itemCount} product${response.summary.itemCount === 1 ? '' : 's'}.`);
    } catch (error) {
      restoreBtn.classList.remove('confirming');
      restoreBtn.textContent = 'Restore Backup';
      restoreBtn.disabled = false;
      showStatus(error.message || 'Could not restore this backup.', 'error');
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
      const response = await sendBackgroundMessage({ type: 'CLEAR_PRICE_HISTORY' });
      if (!response.success) throw new Error(response.error || 'History clear failed');
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
