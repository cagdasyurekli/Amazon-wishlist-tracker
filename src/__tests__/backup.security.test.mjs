import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';

const amazonSource = await readFile(new URL('../utils/amazon.js', import.meta.url), 'utf8');
const amazonModuleUrl = `data:text/javascript;base64,${Buffer.from(amazonSource).toString('base64')}`;
const historySource = await readFile(new URL('../utils/history.mjs', import.meta.url), 'utf8');
const historyModuleUrl = `data:text/javascript;base64,${Buffer.from(historySource).toString('base64')}`;
const backupSource = (await readFile(new URL('../utils/backup.js', import.meta.url), 'utf8'))
  .replace('./amazon.js', amazonModuleUrl)
  .replace('./history.mjs', historyModuleUrl);
const backup = await import(`data:text/javascript;base64,${Buffer.from(backupSource).toString('base64')}`);

const DAY = 24 * 60 * 60 * 1000;

function validItem(overrides = {}) {
  return {
    id: 'B000000001',
    title: 'A tracked product',
    authors: ['Virginia Evans', 'Jenny Dooley'],
    url: 'https://www.amazon.com/dp/B000000001?ref_=backup',
    imageUrl: 'https://m.media-amazon.com/images/I/product.jpg#ignored',
    currentPrice: 12.5,
    originalPrice: 20,
    currency: '$',
    inStock: true,
    targetPrice: 10,
    wishlistIds: ['LIST-A'],
    trackedIndividually: true,
    ...overrides
  };
}

function validPayload(overrides = {}) {
  return {
    format: backup.BACKUP_FORMAT,
    version: backup.BACKUP_VERSION,
    exportedAt: '2026-08-24T10:00:00.000Z',
    items: [validItem()],
    history: { B000000001: [{ price: 12.5, timestamp: 123 }] },
    trackedWishlists: [{
      id: 'LIST-A',
      url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A?ref_=backup',
      autoSync: true
    }],
    settings: {
      defaultDiscount: 20,
      historyRetentionDays: '90',
      dashboardSort: 'priceAsc',
      dashboardFilter: 'drops'
    },
    ...overrides
  };
}

describe('backup validation boundary', () => {
  it('round-trips supported user data into canonical, bounded records', () => {
    const validated = backup.validateBackupPayload(validPayload());

    assert.equal(validated.items[0].url, 'https://www.amazon.com/dp/B000000001');
    assert.equal(validated.items[0].imageUrl, 'https://m.media-amazon.com/images/I/product.jpg');
    assert.deepEqual(validated.items[0].authors, ['Virginia Evans', 'Jenny Dooley']);
    assert.equal(validated.trackedWishlists[0].url, 'https://www.amazon.com/hz/wishlist/ls/LIST-A');
    assert.deepEqual(validated.settings, {
      defaultDiscount: 20,
      historyRetentionDays: '90',
      dashboardSort: 'priceAsc',
      dashboardFilter: 'drops'
    });
    assert.deepEqual(validated.summary, {
      itemCount: 1,
      historyPointCount: 1,
      wishlistCount: 1
    });
  });

  it('accepts the legacy 1.1 export shape and defaults fields added later', () => {
    const validated = backup.validateBackupPayload({
      items: [validItem({ wishlistIds: undefined })],
      history: {},
      exportedAt: '2026-08-24T10:00:00.000Z'
    });

    assert.equal(validated.items.length, 1);
    assert.deepEqual(validated.items[0].wishlistIds, []);
    assert.deepEqual(validated.trackedWishlists, []);
    assert.deepEqual(validated.settings, {});
  });

  it('accepts explicit v1 backups, emits v2, and rejects future versions', () => {
    const v1 = backup.validateBackupPayload(validPayload({ version: 1 }));
    const v2 = backup.createBackupPayload(validPayload());

    assert.equal(v1.summary.itemCount, 1);
    assert.equal(v2.version, 2);
    assert.throws(
      () => backup.validateBackupPayload(validPayload({ version: 3 })),
      /Unsupported backup version/
    );
  });

  it('round-trips bounded wishlist IDs containing Amazon padding characters', () => {
    const wishlistId = 'LIST=1-ABC';
    const validated = backup.validateBackupPayload(validPayload({
      items: [validItem({ wishlistIds: [wishlistId] })],
      trackedWishlists: [{
        id: wishlistId,
        url: `https://www.amazon.com.tr/hz/wishlist/ls/${wishlistId}`,
        autoSync: true
      }]
    }));

    assert.deepEqual(validated.items[0].wishlistIds, [wishlistId]);
    assert.equal(validated.trackedWishlists[0].id, wishlistId);
    assert.equal(validated.trackedWishlists[0].url, `https://www.amazon.com.tr/hz/wishlist/ls/${wishlistId}`);
  });

  it('infers a legacy wishlist region only from consistently associated products', () => {
    const inferred = backup.validateBackupPayload(validPayload({
      version: 1,
      items: [validItem({
        url: 'https://www.amazon.de/dp/B000000001',
        wishlistIds: ['LIST_1-ABC']
      })],
      trackedWishlists: ['LIST_1-ABC']
    }));

    assert.deepEqual(inferred.trackedWishlists, [{
      id: 'LIST_1-ABC',
      url: 'https://www.amazon.de/hz/wishlist/ls/LIST_1-ABC',
      autoSync: false
    }]);
  });

  it('preserves unresolved legacy wishlist regions without guessing amazon.com', () => {
    const unresolved = backup.validateBackupPayload(validPayload({
      version: 1,
      items: [
        validItem({ wishlistIds: ['LIST_1-ABC'] }),
        validItem({
          id: 'B000000002',
          url: 'https://www.amazon.de/dp/B000000002',
          wishlistIds: ['LIST_1-ABC']
        })
      ],
      trackedWishlists: ['LIST_1-ABC']
    }));

    assert.deepEqual(unresolved.trackedWishlists, [{
      id: 'LIST_1-ABC',
      url: null,
      autoSync: false,
      needsRegionReview: true
    }]);
    assert.equal(JSON.stringify(unresolved.trackedWishlists).includes('amazon.com'), false);
  });

  it('keeps an explicit region-review marker fail-closed until the URL is re-entered in the UI', () => {
    const unresolved = backup.validateBackupPayload(validPayload({
      trackedWishlists: [{
        id: 'LIST-A',
        url: 'https://www.amazon.de/hz/wishlist/ls/LIST-A',
        autoSync: true,
        needsRegionReview: true
      }]
    }));

    assert.deepEqual(unresolved.trackedWishlists, [{
      id: 'LIST-A',
      url: null,
      autoSync: false,
      needsRegionReview: true
    }]);
  });

  it('strips unknown and destructive state instead of trusting imported object fields', () => {
    const validated = backup.validateBackupPayload(validPayload({
      items: [validItem({
        isPurchased: true,
        arbitraryCommand: 'delete everything',
        nextPriceCheckAt: Number.MAX_SAFE_INTEGER,
        checkCadence: 'Never check again'
      })],
      settings: { defaultDiscount: 25, defaultTargetPrice: 1, injected: true }
    }));

    assert.equal(Object.hasOwn(validated.items[0], 'isPurchased'), false);
    assert.equal(Object.hasOwn(validated.items[0], 'arbitraryCommand'), false);
    assert.equal(Object.hasOwn(validated.items[0], 'nextPriceCheckAt'), false);
    assert.equal(Object.hasOwn(validated.items[0], 'checkCadence'), false);
    assert.deepEqual(validated.settings, { defaultDiscount: 25 });
  });

  it('rejects lookalike URLs, ASIN mismatches, duplicate identities, and ambiguous wishlists', () => {
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        items: [validItem({ url: 'https://amazon.com.evil.test/dp/B000000001' })]
      })),
      /Invalid product URL/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        items: [validItem({ url: 'https://www.amazon.com/dp/B000000002' })]
      })),
      /Invalid product URL/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({ items: [validItem(), validItem()] })),
      /duplicate tracked products/i
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        trackedWishlists: [
          { id: 'LIST-A', url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A' },
          { id: 'LIST-A', url: 'https://www.amazon.de/hz/wishlist/ls/LIST-A' }
        ]
      })),
      /Duplicate tracked wishlist/
    );
  });

  it('rejects unsafe bounds and malformed history before storage is touched', () => {
    assert.throws(
      () => backup.validateBackupPayload(validPayload({ items: Array(5001).fill(null) })),
      /at most 5000 tracked products/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({ trackedWishlists: Array(501).fill('LIST-A') })),
      /Invalid tracked wishlists/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        history: { B000000001: Array(10001).fill({ price: 1, timestamp: 1 }) }
      })),
      /Invalid price history/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        items: [validItem({ wishlistIds: Array.from({ length: 21 }, (_, index) => `LIST-${index}`) })]
      })),
      /Too many wishlist owners/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        history: { B000000001: [{ price: -1, timestamp: 123 }] }
      })),
      /Invalid history price/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({ settings: { defaultDiscount: 100 } })),
      /Invalid default discount/
    );
    assert.throws(
      () => backup.validateBackupPayload({ ...validPayload(), format: 'another-product' }),
      /Unsupported backup format/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        items: [validItem({ isPriority: 'false' })]
      })),
      /Invalid priority state/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        trackedWishlists: [{
          id: 'LIST-A',
          url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A',
          autoSync: 'false'
        }]
      })),
      /Invalid wishlist auto-sync state/
    );
    assert.throws(
      () => backup.validateBackupPayload(validPayload({
        history: { __proto__: [{ price: 1, timestamp: 1 }] }
      })),
      /Invalid price history/
    );
  });

  it('creates a canonical v2 payload that round-trips through JSON and the restore validator', async () => {
    const now = Date.now();
    const source = {
      items: [validItem({ url: 'https://www.amazon.de/dp/B000000001?ref_=export' })],
      history: {
        B000000001: [
          { price: 20, timestamp: now - 10 * DAY },
          { price: 10, timestamp: now - 10 * DAY + 1 },
          { price: 15, timestamp: now - 10 * DAY + 2 },
          { price: 12, timestamp: now - DAY }
        ]
      },
      trackedWishlists: ['REGION_UNKNOWN'],
      settings: { historyRetentionDays: 'forever' }
    };
    const snapshot = structuredClone(source);
    const payload = backup.createBackupPayload(source);
    const restored = backup.validateBackupPayload(JSON.parse(JSON.stringify(payload)));

    assert.deepEqual(source, snapshot);
    assert.equal(payload.format, backup.BACKUP_FORMAT);
    assert.equal(payload.version, backup.BACKUP_VERSION);
    assert.equal(Number.isNaN(Date.parse(payload.exportedAt)), false);
    assert.deepEqual(payload.historyPolicy, {
      recentRawDays: 7,
      olderResolution: 'daily-low-high; monthly-low-high after one year',
      compacted: true,
      removedPointCount: 1
    });
    assert.deepEqual(payload.history.B000000001.map((point) => point.price), [20, 10, 12]);
    assert.equal(payload.items[0].trackingStartPrice, 20);
    assert.equal(payload.items[0].trackingStartedAt, now - 10 * DAY);
    assert.equal(payload.items[0].trackingBaselineExact, false);
    assert.deepEqual(restored.items, payload.items);
    assert.deepEqual(restored.history, payload.history);
    assert.deepEqual(restored.trackedWishlists, [{
      id: 'REGION_UNKNOWN',
      url: null,
      autoSync: false,
      needsRegionReview: true
    }]);
    assert.equal(JSON.stringify(payload.trackedWishlists).includes('amazon.com'), false);
    const blob = backup.createBackupBlob(payload);
    assert.equal(blob.type, 'application/json');
    assert.deepEqual(
      backup.validateBackupPayload(JSON.parse(await blob.text())).history,
      payload.history
    );
  });

  it('compacts oversized per-item history before producing a restorable export', () => {
    const now = Date.now();
    const points = Array.from({ length: 10005 }, (_, index) => ({
      price: index,
      timestamp: now - 20000 + index
    }));
    const payload = backup.createBackupPayload({
      items: [validItem()],
      history: { B000000001: points },
      trackedWishlists: [],
      settings: { historyRetentionDays: 'forever' }
    });
    const restored = backup.validateBackupPayload(payload);

    assert.equal(payload.history.B000000001.length, 10000);
    assert.deepEqual(payload.history.B000000001[0], points[0]);
    assert.deepEqual(payload.history.B000000001.at(-1), points.at(-1));
    assert.equal(restored.summary.historyPointCount, 10000);
    assert.equal(payload.historyPolicy.compacted, true);
    assert.equal(payload.historyPolicy.removedPointCount, 5);
  });

  it('caps the complete export at 500,000 history points and keeps series endpoints', () => {
    const now = Date.now();
    const history = {};
    for (let seriesIndex = 0; seriesIndex < 51; seriesIndex++) {
      const id = `B${seriesIndex.toString(36).toUpperCase().padStart(9, '0')}`;
      history[id] = Array.from({ length: 9804 }, (_, pointIndex) => ({
        price: pointIndex,
        timestamp: now - 1_000_000 + pointIndex * 51 + seriesIndex
      }));
    }
    const firstId = 'B000000000';
    const firstSeries = history[firstId];
    const payload = backup.createBackupPayload({
      items: [validItem()],
      history,
      trackedWishlists: [],
      settings: { historyRetentionDays: 'forever' }
    });
    const restored = backup.validateBackupPayload(payload);

    assert.equal(restored.summary.historyPointCount, 500000);
    assert.deepEqual(payload.history[firstId][0], firstSeries[0]);
    assert.deepEqual(payload.history[firstId].at(-1), firstSeries.at(-1));
    assert.equal(payload.historyPolicy.compacted, true);
    assert.equal(payload.historyPolicy.removedPointCount, 4);
    assert.throws(() => backup.createBackupBlob(payload), /32 MB safety limit/);
  });
});
