// This intentionally has no ESM exports so Jest can load the same pure helper
// through CommonJS. The MV3 service worker imports it for its global API.
(function registerLegacyTargetNotice(root) {
  const LEGACY_TARGET_NOTIFICATION_ID = 'legacy-target-upgrade-v1';

  function getLegacyTargetNoticeFingerprint(settings) {
    if (!settings || !Object.hasOwn(settings, 'defaultTargetPrice')) return null;

    const targetPrice = Number(settings.defaultTargetPrice);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return null;

    // A value-specific marker lets a changed legacy target be noticed again
    // without retaining a raw target price in local storage.
    const source = `legacy-target-notice-v1:${targetPrice}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `v1-${(hash >>> 0).toString(36)}`;
  }

  async function decideLegacyTargetNotice(settings, existingMarker, showNotice) {
    const fingerprint = getLegacyTargetNoticeFingerprint(settings);
    if (!fingerprint) {
      return { clearMarker: Boolean(existingMarker) };
    }
    if (existingMarker?.fingerprint === fingerprint) {
      return { fingerprint, notify: false };
    }

    try {
      await showNotice();
      return { fingerprint, notify: true, outcome: 'shown' };
    } catch (_error) {
      // The caller persists the unavailable outcome to avoid retry-spam while
      // the Dashboard remains the visible recovery path.
      return { fingerprint, notify: true, outcome: 'unavailable' };
    }
  }

  const api = {
    LEGACY_TARGET_NOTIFICATION_ID,
    getLegacyTargetNoticeFingerprint,
    decideLegacyTargetNotice,
    isLegacyTargetNoticeNotification: (notificationId) => notificationId === LEGACY_TARGET_NOTIFICATION_ID
  };

  root.LegacyTargetNotice = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
