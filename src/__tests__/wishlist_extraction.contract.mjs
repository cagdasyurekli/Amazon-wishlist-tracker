import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const source = await readFile(new URL('../dashboard/wishlist_extraction.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { extractWishlistWithVisibleFallback } = await import(moduleUrl);

describe('wishlist extraction source policy', () => {
  it('keeps complete background pagination authoritative over a short visible DOM', async () => {
    let visibleReads = 0;
    const backgroundItems = Array.from({ length: 784 }, (_, index) => ({ id: index }));

    const response = await extractWishlistWithVisibleFallback({
      readBackground: async () => ({ success: true, items: backgroundItems, complete: true, limited: false }),
      readVisible: async () => {
        visibleReads += 1;
        return { success: true, items: Array.from({ length: 10 }, (_, index) => ({ id: index })) };
      }
    });

    assert.equal(response.items.length, 784);
    assert.equal(response.complete, true);
    assert.equal(response.limited, false);
    assert.equal(visibleReads, 0);
  });

  it('labels visible rows as a partial fallback when background pagination fails', async () => {
    const response = await extractWishlistWithVisibleFallback({
      historyGeneration: 7,
      readBackground: async () => ({ error: 'RATE_LIMITED', paused: true, backoffUntil: 123 }),
      readVisible: async () => ({ success: true, items: Array.from({ length: 10 }, (_, index) => ({ id: index })) })
    });

    assert.equal(response.items.length, 10);
    assert.equal(response.complete, false);
    assert.equal(response.limited, true);
    assert.equal(response.stopReason, 'visible_partial');
    assert.equal(response.paused, true);
    assert.equal(response.backoffUntil, 123);
    assert.equal(response.historyGeneration, 7);
  });

  it('preserves the background error when neither source returns products', async () => {
    const response = await extractWishlistWithVisibleFallback({
      readBackground: async () => ({ error: 'NO_PRODUCTS' }),
      readVisible: async () => null
    });

    assert.deepEqual(response, { error: 'NO_PRODUCTS' });
  });
});
