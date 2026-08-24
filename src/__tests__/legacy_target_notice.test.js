const {
  LEGACY_TARGET_NOTIFICATION_ID,
  getLegacyTargetNoticeFingerprint,
  decideLegacyTargetNotice,
  isLegacyTargetNoticeNotification
} = require('../background/legacy_target_notice.js');

describe('legacy target upgrade notice', () => {
  test('does not notify or retain a marker without a valid legacy target', async () => {
    const showNotice = jest.fn();
    const decision = await decideLegacyTargetNotice(
      { defaultDiscount: 20 },
      { fingerprint: 'v1-old', outcome: 'shown' },
      showNotice
    );

    expect(decision).toEqual({ clearMarker: true });
    expect(showNotice).not.toHaveBeenCalled();
    expect(getLegacyTargetNoticeFingerprint({ defaultTargetPrice: 0 })).toBeNull();
  });

  test('notifies once for one legacy value, but allows a changed value once', async () => {
    const showNotice = jest.fn().mockResolvedValue(undefined);
    const first = await decideLegacyTargetNotice({ defaultTargetPrice: 10 }, null, showNotice);
    const storedMarker = { fingerprint: first.fingerprint, outcome: first.outcome };
    const repeat = await decideLegacyTargetNotice({ defaultTargetPrice: 10 }, storedMarker, showNotice);
    const changed = await decideLegacyTargetNotice({ defaultTargetPrice: 11 }, storedMarker, showNotice);

    expect(first).toEqual({
      fingerprint: expect.stringMatching(/^v1-[a-z0-9]+$/),
      notify: true,
      outcome: 'shown'
    });
    expect(repeat).toEqual({ fingerprint: first.fingerprint, notify: false });
    expect(changed).toEqual({
      fingerprint: expect.not.stringMatching(new RegExp(`^${first.fingerprint}$`)),
      notify: true,
      outcome: 'shown'
    });
    expect(showNotice).toHaveBeenCalledTimes(2);
  });

  test('records an unavailable notification service without retry-spam and keeps Options routing separate from products', async () => {
    const showNotice = jest.fn().mockRejectedValue(new Error('notification permission denied'));
    const failed = await decideLegacyTargetNotice({ defaultTargetPrice: 12 }, null, showNotice);
    const repeat = await decideLegacyTargetNotice(
      { defaultTargetPrice: 12 },
      { fingerprint: failed.fingerprint, outcome: failed.outcome },
      showNotice
    );

    expect(failed).toEqual({
      fingerprint: expect.stringMatching(/^v1-[a-z0-9]+$/),
      notify: true,
      outcome: 'unavailable'
    });
    expect(repeat).toEqual({ fingerprint: failed.fingerprint, notify: false });
    expect(showNotice).toHaveBeenCalledTimes(1);
    expect(isLegacyTargetNoticeNotification(LEGACY_TARGET_NOTIFICATION_ID)).toBe(true);
    expect(isLegacyTargetNoticeNotification('B012345678')).toBe(false);
  });
});
