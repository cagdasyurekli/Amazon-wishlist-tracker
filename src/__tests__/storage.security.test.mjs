import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const storageSource = await readFile(new URL('../utils/storage.js', import.meta.url), 'utf8');

async function loadStorage({ local = {}, sync = {}, failLocalSet = false, corruptReadback = false } = {}) {
  const areas = {
    local: new Map(Object.entries(local)),
    sync: new Map(Object.entries(sync))
  };
  const calls = [];
  let localSetAttempted = false;
  const makeArea = (name) => ({
    async get(keys) {
      const key = Array.isArray(keys) ? keys[0] : keys;
      calls.push(`${name}:get:${key}`);
      if (name === 'local' && corruptReadback && localSetAttempted) {
        return { [key]: [{ id: 'CORRUPTED' }] };
      }
      return areas[name].has(key) ? { [key]: areas[name].get(key) } : {};
    },
    async set(values) {
      calls.push(`${name}:set:${Object.keys(values).join(',')}`);
      if (name === 'local') localSetAttempted = true;
      if (name === 'local' && failLocalSet) throw new Error('local write failed');
      Object.entries(values).forEach(([key, value]) => areas[name].set(key, value));
    },
    async remove(key) {
      calls.push(`${name}:remove:${key}`);
      areas[name].delete(key);
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
