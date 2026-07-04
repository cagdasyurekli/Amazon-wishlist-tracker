/**
 * Dev-only mock of the chrome.* APIs used by the popup, so the popup UI can be
 * previewed and iterated in a plain browser tab (no extension loading needed).
 * Never referenced by the manifest — this file must not ship behavior.
 *
 * Query params on the harness page:
 *   ?empty=1  → no tracked items (empty state)
 *   ?fail=1   → chrome.tabs.sendMessage fails (missing content script path)
 *   ?tab=X    → active-tab context: product (default, untracked),
 *               product-tracked, wishlist, wishlist-tracked, other (non-Amazon),
 *               amazon-home (Amazon but not a product/wishlist page)
 */
(function () {
  const params = new URLSearchParams(window.parent === window ? location.search : window.parent.location.search);

  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // Generate a descending/eventful history series.
  function series(days, from, to, wobble) {
    const points = [];
    const steps = days * 4;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const price = from + (to - from) * t + Math.sin(i * 1.7) * wobble;
      points.push({ price: Math.round(price * 100) / 100, timestamp: now - (days * DAY) + i * (DAY / 4) });
    }
    return points;
  }

  const items = params.get('empty') ? [] : [
    {
      id: 'B09B8V1LZ3',
      title: 'Echo Dot (5th Gen, 2022 release) | Smart speaker with bigger vibrant sound and Alexa | Charcoal',
      url: 'https://www.amazon.com/dp/B09B8V1LZ3',
      currentPrice: 39.99, currency: '$', originalPrice: 49.99, targetPrice: 35,
      inStock: true, lastChecked: now - 12 * 60 * 1000, addedAt: now - 21 * DAY
    },
    {
      id: 'B08KTZ8249',
      title: 'Kindle Paperwhite (16 GB) – Jetzt mit 6,8-Zoll-Display',
      url: 'https://www.amazon.de/dp/B08KTZ8249',
      currentPrice: 154.99, currency: '€', originalPrice: 139.99,
      inStock: true, lastChecked: now - 2 * HOUR, addedAt: now - 30 * DAY
    },
    {
      id: 'B0BXQKQ5QF',
      title: 'LEGO Icons Orchid Building Set for Adults',
      url: 'https://www.amazon.com/dp/B0BXQKQ5QF',
      currentPrice: 47.99, currency: '$', originalPrice: 47.99,
      inStock: false, lastChecked: now - 26 * HOUR, addedAt: now - 45 * DAY
    },
    {
      id: 'B0863TXGM3',
      title: 'Sony WH-1000XM4 Wireless Noise Cancelling Headphones',
      url: 'https://www.amazon.com/dp/B0863TXGM3',
      currentPrice: 199.0, currency: '$', originalPrice: 299.0, targetPrice: 180,
      inStock: true, lastChecked: now - 35 * 60 * 1000, addedAt: now - 60 * DAY
    },
    {
      id: 'B01N5IB20Q',
      title: 'Anker USB C Cable, 2-Pack',
      url: 'https://www.amazon.com/dp/B01N5IB20Q',
      currentPrice: 12.99, currency: '$', originalPrice: 12.99,
      inStock: true, lastChecked: now - 5 * 60 * 1000, addedAt: now - 10 * DAY
    },
    {
      id: 'NEWITEM001',
      title: 'Logitech MX Master 3S Wireless Mouse (added just now — no history yet)',
      url: 'https://www.amazon.com/dp/NEWITEM001',
      currentPrice: 89.99, currency: '$', originalPrice: 89.99,
      inStock: true, addedAt: now - 2 * 60 * 1000
    }
  ];

  const priceHistory = params.get('empty') ? {} : {
    B09B8V1LZ3: series(21, 49.99, 39.99, 0.6),
    B08KTZ8249: series(30, 139.99, 154.99, 1.2),
    B0BXQKQ5QF: series(45, 47.99, 47.99, 0.2),
    B0863TXGM3: series(60, 299.0, 199.0, 3.5),
    B01N5IB20Q: series(10, 12.99, 12.99, 0.05)
  };

  const store = {
    local: {
      trackedItems: items,
      priceHistory,
      trackedWishlists: params.get('empty')
        ? []
        : [{ id: 'WL1TRACKED', url: 'https://www.amazon.com/hz/wishlist/ls/WL1TRACKED', autoSync: true }]
    },
    sync: { settings: { historyRetentionDays: '30' } }
  };

  const TAB_URLS = {
    product: 'https://www.amazon.com/dp/B0UNTRACK1',
    'product-tracked': 'https://www.amazon.com/dp/B09B8V1LZ3',
    wishlist: 'https://www.amazon.com/hz/wishlist/ls/NEWLIST123',
    'wishlist-tracked': 'https://www.amazon.com/hz/wishlist/ls/WL1TRACKED',
    'amazon-home': 'https://www.amazon.com/gp/goldbox',
    other: 'https://www.google.com/'
  };
  const activeTabUrl = TAB_URLS[params.get('tab')] || TAB_URLS.product;

  function storageArea(name) {
    return {
      get(keys) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { out[k] = store[name][k]; });
        return Promise.resolve(out);
      },
      set(values) {
        Object.assign(store[name], values);
        return Promise.resolve();
      }
    };
  }

  window.chrome = {
    storage: { local: storageArea('local'), sync: storageArea('sync') },
    runtime: {
      lastError: undefined,
      openOptionsPage() { console.log('[mock] openOptionsPage'); },
      getURL(path) { return `/${path}`; },
      onMessage: { addListener() {} }
    },
    tabs: {
      query(_opts, cb) {
        cb([{ id: 1, url: activeTabUrl }]);
      },
      sendMessage(_tabId, _msg, cb) {
        setTimeout(() => {
          if (params.get('fail')) {
            chrome.runtime.lastError = { message: 'Could not establish connection.' };
            cb(undefined);
            chrome.runtime.lastError = undefined;
          } else {
            cb({ success: true });
          }
        }, 300);
      },
      create(opts) { console.log('[mock] tabs.create', opts.url); }
    }
  };
})();
