/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://www.amazon.com/dp/B000000001"}
 */

const availabilityFixtures = require('../__fixtures__/availability-fixtures.cjs');

describe('content-script tracking boundary', () => {
  let contentMessageListener;
  let capturedShadow;
  let originalAttachShadow;

  beforeEach(() => {
    jest.resetModules();
    require('../utils/availability.js');
    document.body.innerHTML = `
      <div id="buybox"></div>
      <h1 id="productTitle">A legitimate product</h1>
      <span class="a-price"><span class="a-offscreen">$19.99</span></span>
    `;

    contentMessageListener = null;
    capturedShadow = null;
    originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function attachClosedShadow(init) {
      capturedShadow = originalAttachShadow.call(this, init);
      return capturedShadow;
    };

    global.chrome = {
      runtime: {
        id: 'test-extension',
        lastError: null,
        sendMessage: jest.fn((message, callback) => {
          callback(message.type === 'CHECK_IF_TRACKED' ? { isTracked: true } : { success: true });
        }),
        onMessage: {
          addListener: jest.fn((listener) => {
            contentMessageListener = listener;
          })
        }
      }
    };
  });

  afterEach(() => {
    Element.prototype.attachShadow = originalAttachShadow;
    delete global.chrome;
  });

  it('keeps private membership state inside a closed shadow root', () => {
    require('../content/content.js');

    const host = document.getElementById('amz-tracker-control');
    expect(host).not.toBeNull();
    expect(host.shadowRoot).toBeNull();
    expect(host.textContent).toBe('');
    expect(capturedShadow.querySelector('button').textContent).toBe('Tracking price');
    expect(capturedShadow.querySelector('button').disabled).toBe(true);
  });

  it('ignores synthetic clicks from the shared Amazon page DOM', () => {
    require('../content/content.js');
    chrome.runtime.sendMessage.mockClear();

    capturedShadow.querySelector('button').dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      composed: true
    }));

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves the extension-owned popup tracking flow for a valid ASIN', async () => {
    require('../content/content.js');
    chrome.runtime.sendMessage.mockClear();

    const response = await new Promise((resolve) => {
      expect(contentMessageListener({ type: 'TRACK_CURRENT_PAGE' }, { id: 'test-extension' }, resolve)).toBe(true);
    });

    expect(response).toEqual({ success: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ADD_TRACKED_ITEM',
        item: expect.objectContaining({
          id: 'B000000001',
          url: 'https://www.amazon.com/dp/B000000001'
        })
      }),
      expect.any(Function)
    );
  });

  it('bounds visible wishlist extraction while preserving normal item fields', () => {
    const rows = Array.from({ length: 2001 }, (_, index) => {
      const asin = `B${String(index).padStart(9, '0')}`;
      return `<li data-itemid="${'x'.repeat(140)}"><a href="/dp/${asin}">${'Long title '.repeat(40)}</a><span class="a-price">$19.99</span></li>`;
    }).join('');
    document.body.innerHTML = `<div id="buybox"></div><div id="g-items">${rows}</div>`;
    require('../content/content.js');

    let response;
    contentMessageListener({ type: 'EXTRACT_VISIBLE_WISHLIST' }, { id: 'test-extension' }, (value) => { response = value; });

    expect(response.success).toBe(true);
    expect(response.limited).toBe(true);
    expect(response.items).toHaveLength(2000);
    expect(response.items[0].title.length).toBe(300);
    expect(response.items[0].wishlistItemId.length).toBe(128);
    expect(response.items[0].url).toBe('https://www.amazon.com/dp/B000000000');
  });

  test.each(availabilityFixtures)('uses shared $locale unavailable phrases for visible wishlist rows', ({ available, unavailable }) => {
    document.body.innerHTML = `
      <div id="buybox"></div>
      <div id="g-items">
        <li data-itemid="available"><a href="/dp/B000000001">Available item</a><span class="a-price">$19.99</span><p>${available}</p></li>
        <li data-itemid="unavailable"><a href="/dp/B000000002">Unavailable item</a><span class="a-price">$20.99</span><p>${unavailable}</p></li>
      </div>`;
    require('../content/content.js');

    let response;
    contentMessageListener({ type: 'EXTRACT_VISIBLE_WISHLIST' }, { id: 'test-extension' }, (value) => { response = value; });

    expect(response.items.map((item) => item.inStock)).toEqual([true, false]);
  });
});
