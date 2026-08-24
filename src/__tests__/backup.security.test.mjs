import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';

const amazonSource = await readFile(new URL('../utils/amazon.js', import.meta.url), 'utf8');
const amazonModuleUrl = `data:text/javascript;base64,${Buffer.from(amazonSource).toString('base64')}`;
const backupSource = (await readFile(new URL('../utils/backup.js', import.meta.url), 'utf8'))
  .replace('./amazon.js', amazonModuleUrl);
const backup = await import(`data:text/javascript;base64,${Buffer.from(backupSource).toString('base64')}`);

function validItem(overrides = {}) {
  return {
    id: 'B000000001',
    title: 'A tracked product',
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

  it('creates a versioned export envelope without mutating its inputs', () => {
    const items = [validItem()];
    const payload = backup.createBackupPayload({ items, history: {}, trackedWishlists: [], settings: {} });

    assert.equal(payload.format, backup.BACKUP_FORMAT);
    assert.equal(payload.version, backup.BACKUP_VERSION);
    assert.equal(payload.items, items);
    assert.equal(Number.isNaN(Date.parse(payload.exportedAt)), false);
  });
});
