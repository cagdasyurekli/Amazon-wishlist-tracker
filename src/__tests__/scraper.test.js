/**
 * @jest-environment jsdom
 */

// Mock chrome API for Node environment
global.chrome = {
  runtime: {
    onMessage: {
      addListener: jest.fn()
    }
  }
};

const { parseAmazonHtml, parseAmazonWishlist, parsePrice, parseWishlistPriceDrop } = require('../background/offscreen.js');

describe('Amazon HTML Parser (Offscreen Worker)', () => {
  it('should throw an error if a CAPTCHA is detected via the title', () => {
    const html = `
      <html>
        <head><title>Robot Check</title></head>
        <body>Please enter the captcha</body>
      </html>
    `;
    expect(() => parseAmazonHtml(html, 'https://amazon.com')).toThrow('CAPTCHA_BLOCKED');
  });

  it('should detect a CAPTCHA when the title looks normal but the body is a challenge', () => {
    // Amazon sometimes serves the interstitial without changing the <title>.
    const html = `
      <html>
        <head><title>Amazon.com</title></head>
        <body>
          <p>Type the characters you see in this image:</p>
          <img src="captcha.jpg" />
        </body>
      </html>
    `;
    expect(() => parseAmazonHtml(html, 'https://amazon.com')).toThrow('CAPTCHA_BLOCKED');
  });

  it('should parse price, title, and stock from standard Amazon product page', () => {
    const html = `
      <html>
        <head><title>Some Product</title></head>
        <body>
          <span id="productTitle">   Test Product Title   </span>
          <div id="corePrice_feature_div">
            <span class="a-offscreen">$49.99</span>
          </div>
          <div id="availability">
            <span>In Stock.</span>
          </div>
          <div id="merchant-info">Ships from and sold by Amazon.com.</div>
        </body>
      </html>
    `;
    
    const data = parseAmazonHtml(html, 'https://amazon.com/dp/123');
    
    expect(data.success).toBe(true);
    expect(data.title).toBe('Test Product Title');
    expect(data.price).toBe(49.99);
    expect(data.buyBoxPrice).toBe(49.99);
    expect(data.inStock).toBe(true);
    expect(data.soldByAmazon).toBe(true);
  });

  it('should mark items as purchased if purchased text exists on the page', () => {
    const html = `
      <html>
        <head><title>Product Title</title></head>
        <body>
          <div id="productTitle">Some Book</div>
          <span id="kindle-price">$9.99</span>
          <div class="a-box">Purchased on 6 Jul 2026</div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com/dp/123');
    expect(data.isPurchased).toBe(true);
    expect(data.price).toBe(9.99);
  });

  it('should parse European price formats (comma as decimal)', () => {
    const html = `
      <html>
        <body>
          <span id="priceblock_ourprice">€ 19,95</span>
        </body>
      </html>
    `;
    
    const data = parseAmazonHtml(html, 'https://amazon.nl/dp/123');
    expect(data.price).toBe(19.95);
  });

  it('should detect out of stock items', () => {
    const html = `
      <html>
        <body>
          <div id="availability">
            <span>Currently unavailable.</span>
          </div>
        </body>
      </html>
    `;
    
    const data = parseAmazonHtml(html, 'https://amazon.com');
    expect(data.inStock).toBe(false);
  });

  it('should parse US prices with a thousands separator (regression: $1,299.99)', () => {
    const html = `
      <html>
        <body>
          <div id="corePrice_feature_div">
            <span class="a-offscreen">$1,299.99</span>
          </div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com/dp/123');
    // Previously parsed as 1.299 because the first comma was naively turned
    // into a decimal point.
    expect(data.price).toBe(1299.99);
    expect(data.currency).toBe('$');
  });

  it('should parse EU prices with a thousands separator (1.299,95)', () => {
    const html = `
      <html>
        <body>
          <span id="priceblock_ourprice">€ 1.299,95</span>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.de/dp/123');
    expect(data.price).toBe(1299.95);
  });

  it('should treat a grouped integer with no decimals as a whole number', () => {
    // e.g. JPY-style or a list price rendered without cents.
    expect(parsePrice('1,234,567')).toBe(1234567);
    expect(parsePrice('1.234.567')).toBe(1234567);
  });

  it('parsePrice handles both conventions and junk input', () => {
    expect(parsePrice('$49.99')).toBe(49.99);
    expect(parsePrice('19,95')).toBe(19.95);
    expect(parsePrice('1.299,95')).toBe(1299.95);
    expect(parsePrice('1,299.99')).toBe(1299.99);
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice('Currently unavailable')).toBeNull();
  });

  it('should return a null price when no price selector matches', () => {
    const html = `
      <html>
        <body>
          <span id="productTitle">A Product With No Visible Price</span>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com/dp/123');
    expect(data.price).toBeNull();
    expect(data.buyBoxPrice).toBeNull();
    // No availability node and no price -> should not be falsely "in stock".
    expect(data.inStock).toBe(false);
  });

  it('should treat "Only N left in stock" as in stock', () => {
    const html = `
      <html>
        <body>
          <div id="availability"><span>Only 2 left in stock - order soon.</span></div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com');
    expect(data.inStock).toBe(true);
  });

  it('should NOT treat "Available from these sellers" as in stock (buy box empty)', () => {
    // Classic false positive: "available" is present but the item has no buy box.
    const html = `
      <html>
        <body>
          <div id="availability"><span>Available from these sellers.</span></div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com');
    expect(data.inStock).toBe(false);
  });

  it('should treat "Temporarily out of stock" as out of stock', () => {
    const html = `
      <html>
        <body>
          <div id="availability"><span>Temporarily out of stock.</span></div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com');
    expect(data.inStock).toBe(false);
  });

  it('should mark soldByAmazon false for third-party sellers', () => {
    const html = `
      <html>
        <body>
          <div id="merchant-info">Ships from and sold by SomeThirdPartyShop.</div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com');
    expect(data.soldByAmazon).toBe(false);
  });

  it('should pick the buy-box price selector ahead of legacy selectors', () => {
    const html = `
      <html>
        <body>
          <div class="a-price aok-align-center reinventPricePriceToPayMargin">
            <span class="a-offscreen">$24.50</span>
          </div>
          <span id="priceblock_ourprice">$99.99</span>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com');
    expect(data.price).toBe(24.50);
  });

  it('should parse split whole/fraction price spans when a-offscreen is missing', () => {
    const html = `
      <html>
        <body>
          <div id="corePrice_feature_div">
            <span class="priceToPay">
              <span class="a-price-whole">1,299.</span>
              <span class="a-price-fraction">99</span>
            </span>
          </div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com/dp/123');
    expect(data.price).toBe(1299.99);
  });

  it('should parse price from the apex_desktop buy-box container', () => {
    const html = `
      <html>
        <body>
          <div id="apex_desktop">
            <span class="priceToPay">
              <span class="a-offscreen">$32.10</span>
            </span>
          </div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com/dp/123');
    expect(data.price).toBe(32.10);
  });

  it('should treat usually-ships availability text as in stock/orderable', () => {
    const html = `
      <html>
        <body>
          <div id="availability"><span>Usually ships within 2 to 3 days.</span></div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com');
    expect(data.inStock).toBe(true);
  });

  it('should not treat "not available" text as in stock', () => {
    const html = `
      <html>
        <body>
          <div id="availability"><span>This item is not available for purchase.</span></div>
        </body>
      </html>
    `;
    const data = parseAmazonHtml(html, 'https://amazon.com');
    expect(data.inStock).toBe(false);
  });

  it('should parse wishlist native price-drop metadata from Amazon text', () => {
    const parsed = parseWishlistPriceDrop('Price dropped 8% (was €11.98 when added to List)', 10.99);
    expect(parsed.percent).toBe(8);
    expect(parsed.wasPrice).toBe(11.98);
    expect(parsed.amount).toBe(0.99);
    expect(parsed.currency).toBe('€');
  });

  it('should preserve wishlist price-drop details on extracted wishlist items', () => {
    const html = `
      <html>
        <body>
          <ul>
            <li data-itemid="abc">
              <a id="itemName_B012345678" href="https://www.amazon.nl/dp/B012345678">
                The Man Who Knew: The Life and Times of Alan Greenspan
              </a>
              <span class="a-price"><span class="a-offscreen">€10.99</span></span>
              <div>
                <strong>Price dropped 8%</strong>
                <span>(was €11.98 when added to List)</span>
              </div>
              <img src="https://m.media-amazon.com/images/I/book.jpg">
            </li>
          </ul>
        </body>
      </html>
    `;

    const data = parseAmazonWishlist(html, 'https://www.amazon.nl/hz/wishlist/ls/ABC123');
    expect(data.items).toHaveLength(1);
    expect(data.items[0].currentPrice).toBe(10.99);
    expect(data.items[0].originalPrice).toBe(11.98);
    expect(data.items[0].wishlistPriceDropPercent).toBe(8);
    expect(data.items[0].wishlistPriceWhenAdded).toBe(11.98);
    expect(data.items[0].wishlistPriceDropAmount).toBe(0.99);
    expect(data.items[0].currency).toBe('€');
  });

  it('should preserve price-drop metadata for duplicate-title wishlist rows by ASIN', () => {
    const html = `
      <html>
        <body>
          <ul>
            <li data-itemid="I2KRWKMZ0JY1G6">
              <a id="itemName_B01FR8MGXS" href="https://www.amazon.nl/-/en/dp/B01FR8MGXS/">
                The Man Who Knew: The Life & Times of Alan Greenspan (English Edition)
              </a>
              <span class="a-price"><span class="a-offscreen">€13.49</span></span>
              <img src="https://m.media-amazon.com/images/I/first.jpg">
            </li>
            <li data-itemid="I29PZ3CYGRJ5ML">
              <a id="itemName_B01CDVCAXS" href="https://www.amazon.nl/-/en/dp/B01CDVCAXS/">
                The Man Who Knew: The Life and Times of Alan Greenspan (English Edition)
              </a>
              <span class="a-price"><span class="a-offscreen">€10.99</span></span>
              <div>Price dropped 8%  (was €11.98 when added to List)</div>
              <img src="https://m.media-amazon.com/images/I/second.jpg">
            </li>
          </ul>
        </body>
      </html>
    `;

    const data = parseAmazonWishlist(html, 'https://www.amazon.nl/hz/wishlist/ls/2P9W94G73GF4E');
    expect(data.items).toHaveLength(2);
    const droppedItem = data.items.find(item => item.id === 'B01CDVCAXS');
    expect(droppedItem.currentPrice).toBe(10.99);
    expect(droppedItem.originalPrice).toBe(11.98);
    expect(droppedItem.wishlistPriceDropPercent).toBe(8);
    expect(droppedItem.wishlistPriceWhenAdded).toBe(11.98);
    expect(droppedItem.wishlistPriceDropAmount).toBe(0.99);
  });
});
