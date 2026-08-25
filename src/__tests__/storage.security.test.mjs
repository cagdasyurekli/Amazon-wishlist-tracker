import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const storageSource = await readFile(new URL('../utils/storage.js', import.meta.url), 'utf8');

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
  await module.link(() => { throw new Error('storage.js must remain dependency-free'); });
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
