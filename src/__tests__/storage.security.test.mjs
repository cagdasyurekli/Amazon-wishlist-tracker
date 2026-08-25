import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import {
  applyMissingTrackingBaselines,
  compactHistorySeries,
  compactPriceHistory,
  limitHistoryTotal
} from '../utils/history.mjs';

const storageSource = await readFile(new URL('../utils/storage.js', import.meta.url), 'utf8');
const historySource = await readFile(new URL('../utils/history.mjs', import.meta.url), 'utf8');

async function loadStorage({
  local = {},
  sync = {},
  failLocalSet = false,
  failSyncSet = false,
  corruptReadback = false,
  beforeHistoryRead = null
} = {}) {
  const areas = {
    local: new Map(Object.entries(local)),
    sync: new Map(Object.entries(sync))
  };
  const calls = [];
  let localSetAttempted = false;
  const makeArea = (name) => ({
    async get(keys) {
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      calls.push(`${name}:get:${requestedKeys.join(',')}`);
      if (name === 'local' && requestedKeys.includes('priceHistory') && beforeHistoryRead) {
        await beforeHistoryRead();
      }
      if (name === 'local' && corruptReadback && localSetAttempted) {
        return { [requestedKeys[0]]: [{ id: 'CORRUPTED' }] };
      }
      return Object.fromEntries(
        requestedKeys
          .filter((key) => areas[name].has(key))
          .map((key) => [key, areas[name].get(key)])
      );
    },
    async set(values) {
      calls.push(`${name}:set:${Object.keys(values).join(',')}`);
      if (name === 'local') localSetAttempted = true;
      if (name === 'local' && failLocalSet) throw new Error('local write failed');
      if (name === 'sync' && failSyncSet) throw new Error('sync write failed');
      Object.entries(values).forEach(([key, value]) => areas[name].set(key, value));
    },
    async remove(keys) {
      const requestedKeys = Array.isArray(keys) ? keys : [keys];
      calls.push(`${name}:remove:${requestedKeys.join(',')}`);
      requestedKeys.forEach((key) => areas[name].delete(key));
    }
  });

  const context = vm.createContext({
    chrome: { storage: { local: makeArea('local'), sync: makeArea('sync') } },
    console,
    Date,
    JSON,
    Number,
    Promise,
    parseInt
  });
  const module = new vm.SourceTextModule(storageSource, { context });
  const historyModule = new vm.SourceTextModule(historySource, { context });
  await module.link((specifier) => {
    if (specifier === './history.mjs') return historyModule;
    throw new Error(`Unexpected storage dependency: ${specifier}`);
  });
  await module.evaluate();
  return { api: module.namespace, areas, calls };
}

describe('legacy trackedItems privacy migration', () => {
  let legacyItems;

  beforeEach(() => {
    legacyItems = [{ id: 'B000000001', title: 'Legacy item' }];
  });

  it('reads back a durable local copy before removing the Sync key', async () => {
    const { api, areas, calls } = await loadStorage({ sync: { trackedItems: legacyItems } });

    assert.deepEqual(Array.from(await api.getTrackedItems()), legacyItems);
    assert.deepEqual(areas.local.get('trackedItems'), legacyItems);
    assert.equal(areas.sync.has('trackedItems'), false);
    assert.ok(calls.indexOf('local:get:trackedItems') < calls.indexOf('sync:remove:trackedItems'));
    assert.ok(calls.indexOf('local:set:trackedItems') < calls.lastIndexOf('local:get:trackedItems'));
  });

  it('leaves the Sync key intact when the local write fails', async () => {
    const { api, areas } = await loadStorage({
      sync: { trackedItems: legacyItems },
      failLocalSet: true
    });

    await assert.rejects(api.getTrackedItems(), /local write failed/);
    assert.deepEqual(areas.sync.get('trackedItems'), legacyItems);
  });

  it('leaves the Sync key intact when local readback does not match', async () => {
    const { api, areas } = await loadStorage({
      sync: { trackedItems: legacyItems },
      corruptReadback: true
    });

    await assert.rejects(api.getTrackedItems(), /could not be verified/);
    assert.deepEqual(areas.sync.get('trackedItems'), legacyItems);
  });

  it('idempotently removes a residual Sync key when local data already exists, including empty arrays', async () => {
    const { api, areas } = await loadStorage({
      local: { trackedItems: [] },
      sync: { trackedItems: legacyItems }
    });

    assert.deepEqual(Array.from(await api.getTrackedItems()), []);
    assert.equal(areas.sync.has('trackedItems'), false);
    assert.deepEqual(Array.from(await api.getTrackedItems()), []);
  });

  it('does not write trackedItems anywhere on a fresh install', async () => {
    const { api, areas, calls } = await loadStorage();

    assert.deepEqual(Array.from(await api.getTrackedItems()), []);
    assert.equal(areas.local.has('trackedItems'), false);
    assert.equal(areas.sync.has('trackedItems'), false);
    assert.equal(calls.some((call) => call.includes(':set:') || call.includes(':remove:')), false);
  });
});

describe('locale-aware price formatting', () => {
  it('uses the requested browser locale ordering and separators', async () => {
    const { api } = await loadStorage();
    const expected = new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(1299.5);

    assert.equal(api.formatPrice(1299.5, '€', 'de-DE'), expected);
    assert.equal(api.formatPrice(Number.NaN, '€', 'de-DE'), 'N/A');
  });
});

describe('validated backup replacement', () => {
  it('replaces user data in one local batch and resets transient scheduler state', async () => {
    const { api, areas, calls } = await loadStorage({
      local: {
        trackedItems: [{ id: 'B000000001' }],
        priceHistoryGeneration: 4,
        lastScrapeTime: 123,
        wishlistScrapeState: { stale: true },
        captchaBackoffUntil: 999999,
        captchaBackoffAttempts: 3
      },
      sync: { settings: { defaultDiscount: 10 } }
    });
    const replacement = {
      items: [{ id: 'B000000002', title: 'Restored' }],
      history: { B000000002: [{ price: 8, timestamp: 456 }] },
      trackedWishlists: [{ id: 'LIST-A', url: 'https://www.amazon.com/hz/wishlist/ls/LIST-A', autoSync: true }],
      settings: { defaultDiscount: 20, historyRetentionDays: '90' }
    };

    await api.replaceTrackingData(replacement);

    assert.deepEqual(areas.local.get('trackedItems'), replacement.items);
    assert.deepEqual(areas.local.get('priceHistory'), replacement.history);
    assert.equal(areas.local.get('priceHistoryGeneration'), 5);
    assert.deepEqual(areas.local.get('trackedWishlists'), replacement.trackedWishlists);
    assert.equal(areas.local.get('lastScrapeTime'), null);
    assert.equal(areas.local.get('scrapeCursor'), 0);
    assert.deepEqual(Object.keys(areas.local.get('wishlistScrapeState')), []);
    assert.equal(areas.local.get('captchaBackoffUntil'), 999999);
    assert.equal(areas.local.get('captchaBackoffAttempts'), 3);
    assert.deepEqual(areas.sync.get('settings'), replacement.settings);
    assert.equal(calls.filter((call) => call.startsWith('local:set:')).length, 1);
  });

  it('restores the exact local snapshot if Sync settings cannot be written and leaves the mutex usable', async () => {
    const originalLocal = {
      trackedItems: [{ id: 'B000000001', title: 'Keep me' }],
      priceHistory: { B000000001: [{ price: 10, timestamp: 123 }] },
      scrapeCursor: 7
    };
    const { api, areas } = await loadStorage({
      local: originalLocal,
      sync: { settings: { defaultDiscount: 10 } },
      failSyncSet: true
    });

    await assert.rejects(api.replaceTrackingData({
      items: [{ id: 'B000000002' }],
      history: {},
      trackedWishlists: [],
      settings: { defaultDiscount: 20 }
    }), /sync write failed/);

    assert.deepEqual(Object.fromEntries(areas.local), originalLocal);
    await api.updateTrackedItems((items) => items.map((item) => ({ ...item, isPriority: true })));
    assert.equal(areas.local.get('trackedItems')[0].isPriority, true);
  });

  it('leaves the prior snapshot intact when the Local replacement batch fails', async () => {
    const originalItems = [{ id: 'B000000001', title: 'Still here' }];
    const { api, areas } = await loadStorage({
      local: { trackedItems: originalItems, scrapeCursor: 4 },
      failLocalSet: true
    });

    await assert.rejects(api.replaceTrackingData({
      items: [{ id: 'B000000002' }],
      history: {},
      trackedWishlists: [],
      settings: {}
    }), /local write failed/);

    assert.deepEqual(areas.local.get('trackedItems'), originalItems);
    assert.equal(areas.local.get('scrapeCursor'), 4);
  });
});

describe('price history deletion transaction', () => {
  it('waits for an in-flight history mutation, then clears and advances the generation', async () => {
    let releaseHistoryRead;
    let markHistoryReadStarted;
    const historyReadStarted = new Promise((resolve) => { markHistoryReadStarted = resolve; });
    const historyReadBarrier = new Promise((resolve) => { releaseHistoryRead = resolve; });
    let firstHistoryRead = true;
    const { api, areas } = await loadStorage({
      local: {
        priceHistory: { B000000001: [{ price: 10, timestamp: Date.now() }] },
        priceHistoryGeneration: 3
      },
      sync: { settings: { historyRetentionDays: 'forever' } },
      beforeHistoryRead: async () => {
        if (!firstHistoryRead) return;
        firstHistoryRead = false;
        markHistoryReadStarted();
        await historyReadBarrier;
      }
    });

    const pendingMutation = api.updatePriceHistory((history) => history);
    await historyReadStarted;
    let clearCompleted = false;
    const pendingClear = api.clearPriceHistory().then(() => { clearCompleted = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(clearCompleted, false);

    releaseHistoryRead();
    await Promise.all([pendingMutation, pendingClear]);
    assert.equal(Object.keys(areas.local.get('priceHistory')).length, 0);
    assert.equal(areas.local.get('priceHistoryGeneration'), 4);
  });
});

describe('bounded price-history compaction', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 7, 25, 12);

  it('keeps seven recent days raw and reduces older days to chronological low/high samples', () => {
    const recent = [
      { price: 10, timestamp: NOW - 7 * DAY },
      { price: 11, timestamp: NOW - 7 * DAY + 1 },
      { price: 9, timestamp: NOW - 7 * DAY + 2 }
    ];
    const olderDay = [
      { price: 12, timestamp: NOW - 10 * DAY },
      { price: 8, timestamp: NOW - 10 * DAY + 1 },
      { price: 10, timestamp: NOW - 10 * DAY + 2 }
    ];
    const result = compactHistorySeries([...olderDay, ...recent], { now: NOW, retention: '30' });

    assert.deepEqual(result.points.map((point) => point.price), [12, 8, 10, 11, 9]);
    assert.equal(result.compacted, true);
  });

  it('uses monthly extrema beyond one year and remains idempotent', () => {
    const points = [
      { price: 15, timestamp: NOW - 400 * DAY },
      { price: 5, timestamp: NOW - 399 * DAY },
      { price: 12, timestamp: NOW - 398 * DAY }
    ];
    const first = compactHistorySeries(points, { now: NOW, retention: 'forever' });
    const second = compactHistorySeries(first.points, { now: NOW, retention: 'forever' });

    assert.deepEqual(first.points.map((point) => point.price), [15, 5]);
    assert.deepEqual(second.points, first.points);
  });

  it('captures the true first sample before extrema compaction without mutating source items', () => {
    const items = [{ id: 'B000000001', title: 'Baseline test', addedAt: NOW - 500 * DAY }];
    const history = {
      B000000001: [
        { price: 10, timestamp: NOW - 400 * DAY },
        { price: 5, timestamp: NOW - 399 * DAY },
        { price: 15, timestamp: NOW - 398 * DAY }
      ]
    };
    const baselines = applyMissingTrackingBaselines(items, history);
    const compacted = compactHistorySeries(history.B000000001, { now: NOW, retention: 'forever' });

    assert.equal(items[0].trackingStartPrice, undefined);
    assert.deepEqual(compacted.points.map((point) => point.price), [5, 15]);
    assert.equal(baselines.items[0].trackingStartPrice, 10);
    assert.equal(baselines.items[0].trackingStartedAt, NOW - 400 * DAY);
    assert.equal(baselines.items[0].trackingBaselineExact, false);
    assert.equal(baselines.updatedCount, 1);
  });

  it('drops expired and malformed samples, deduplicates, sorts, and remains idempotent', () => {
    const kept = { price: 10, timestamp: NOW - 2 * DAY };
    const source = [
      kept,
      { price: 9, timestamp: NOW - 31 * DAY },
      { price: Number.NaN, timestamp: NOW },
      { price: 11, timestamp: Number.NaN },
      { ...kept },
      { price: 8, timestamp: NOW - DAY }
    ];
    const first = compactHistorySeries(source, { now: NOW, retention: '30' });
    const second = compactHistorySeries(first.points, { now: NOW, retention: '30' });

    assert.deepEqual(first.points, [kept, { price: 8, timestamp: NOW - DAY }]);
    assert.equal(first.removedCount, 4);
    assert.deepEqual(second.points, first.points);
    assert.equal(second.removedCount, 0);
  });

  it('enforces the per-item cap while preserving the first and newest samples', () => {
    const source = Array.from({ length: 10 }, (_, index) => ({
      price: index,
      timestamp: NOW - 1000 + index
    }));
    const result = compactHistorySeries(source, {
      now: NOW,
      retention: 'forever',
      maxPoints: 4
    });

    assert.deepEqual(result.points, [source[0], ...source.slice(-3)]);
    assert.equal(result.removedCount, 6);
    assert.equal(result.compacted, true);
  });

  it('does not mutate source history and enforces a fair global bound', () => {
    const source = {
      A: Array.from({ length: 4 }, (_, index) => ({ price: index, timestamp: index })),
      B: Array.from({ length: 4 }, (_, index) => ({ price: index + 10, timestamp: index + 10 }))
    };
    const snapshot = structuredClone(source);
    const compacted = compactPriceHistory(source, { now: NOW, retention: 'forever' });
    const bounded = limitHistoryTotal(source, 5);

    assert.deepEqual(source, snapshot);
    assert.equal(Object.values(compacted.history).flat().length, 4);
    assert.equal(Object.values(bounded.history).flat().length, 5);
    assert.equal(bounded.history.A[0].timestamp, 0);
    assert.equal(bounded.history.B.at(-1).timestamp, 13);
  });

  it('compacts only a changed series during a storage history mutation', async () => {
    const oldDay = [
      { price: 12, timestamp: NOW - 10 * DAY },
      { price: 8, timestamp: NOW - 10 * DAY + 1 },
      { price: 10, timestamp: NOW - 10 * DAY + 2 }
    ];
    const untouched = [{ price: 20, timestamp: NOW - DAY }];
    const { api, areas } = await loadStorage({
      local: { priceHistory: { B000000001: oldDay, B000000002: untouched } },
      sync: { settings: { historyRetentionDays: '30' } }
    });

    await api.updatePriceHistory((history) => ({
      ...history,
      B000000001: [...history.B000000001, { price: 9, timestamp: NOW - DAY }]
    }));

    assert.deepEqual(
      Array.from(areas.local.get('priceHistory').B000000001, (point) => point.price),
      [12, 8, 9]
    );
    assert.equal(areas.local.get('priceHistory').B000000002, untouched);
  });

  it('persists a missing tracking baseline in the same history mutation', async () => {
    const points = [
      { price: 10, timestamp: NOW - 400 * DAY },
      { price: 5, timestamp: NOW - 399 * DAY },
      { price: 15, timestamp: NOW - 398 * DAY }
    ];
    const { api, areas } = await loadStorage({
      local: {
        trackedItems: [{ id: 'B000000001', title: 'Legacy item' }],
        priceHistory: { B000000001: points }
      },
      sync: { settings: { historyRetentionDays: 'forever' } }
    });

    await api.updatePriceHistory((history) => ({
      ...history,
      B000000001: [...history.B000000001]
    }));

    assert.equal(areas.local.get('trackedItems')[0].trackingStartPrice, 10);
    assert.equal(areas.local.get('trackedItems')[0].trackingStartedAt, NOW - 400 * DAY);
    assert.equal(areas.local.get('trackedItems')[0].trackingBaselineExact, false);
    assert.deepEqual(
      Array.from(areas.local.get('priceHistory').B000000001, (point) => point.price),
      [5, 15]
    );
  });
});

describe('tracked-item finalizer transaction', () => {
  it('restores the exact prior collection on finalizer failure and leaves the mutex usable', async () => {
    const originalItems = [{ id: 'B000000001', title: 'Original item', currency: '€' }];
    const { api, areas } = await loadStorage({ local: { trackedItems: originalItems } });

    await assert.rejects(
      api.updateTrackedItemsWithFinalizer(
        (items) => ({
          commit: true,
          items: items.map((item) => ({ ...item, targetPrice: 12.5 })),
          result: { updated: 1 }
        }),
        async () => { throw new Error('Synthetic finalizer failure'); }
      ),
      /Synthetic finalizer failure/
    );
    assert.deepEqual(areas.local.get('trackedItems'), originalItems);

    await api.updateTrackedItems((items) => items.map((item) => ({ ...item, isPriority: true })));
    assert.equal(areas.local.get('trackedItems')[0].isPriority, true);
    assert.equal(areas.local.get('trackedItems')[0].targetPrice, undefined);
  });
});
