const { classifyAvailabilityText } = require('../utils/availability.js');
const availabilityFixtures = require('../__fixtures__/availability-fixtures.cjs');

describe('Amazon marketplace availability phrases', () => {
  test.each(availabilityFixtures)('recognizes $locale in-stock text', ({ available }) => {
    expect(classifyAvailabilityText(available)).toBe(true);
  });

  test.each(availabilityFixtures)('recognizes $locale unavailable text', ({ unavailable }) => {
    expect(classifyAvailabilityText(unavailable)).toBe(false);
  });

  it('lets negative phrases veto positive substrings', () => {
    expect(classifyAvailabilityText('This item is not in stock.')).toBe(false);
    expect(classifyAvailabilityText('Available from these sellers')).toBe(false);
    expect(classifyAvailabilityText('Indisponible')).toBe(false);
    expect(classifyAvailabilityText('Non disponibile')).toBe(false);
    expect(classifyAvailabilityText('Bu ürün stokta değil.')).toBe(false);
  });

  it('recognizes Turkish low-stock and orderable dispatch wording', () => {
    expect(classifyAvailabilityText('Stokta sadece 4 adet kaldı.')).toBe(true);
    expect(classifyAvailabilityText('Genellikle 2–3 gün içinde kargoya verilir.')).toBe(true);
  });

  it('returns unknown for unrelated availability copy', () => {
    expect(classifyAvailabilityText('See product details')).toBeNull();
  });

  it('classifies purchased status across all supported marketplaces', () => {
    const { classifyPurchasedText } = require('../utils/availability.js');
    expect(classifyPurchasedText('Purchased on 1 September 2026')).toBe(true);
    expect(classifyPurchasedText('Gekocht op 12 mei')).toBe(true);
    expect(classifyPurchasedText('Gekauft am 3. März')).toBe(true);
    expect(classifyPurchasedText('Acheté le 4 avril')).toBe(true);
    expect(classifyPurchasedText('Comprado el 5 de mayo')).toBe(true);
    expect(classifyPurchasedText('Acquistato il 6 giugno')).toBe(true);
    expect(classifyPurchasedText('Satın alındı: 10 Ekim')).toBe(true);
    expect(classifyPurchasedText('Bu ürüne sahipsiniz')).toBe(true);
    expect(classifyPurchasedText('In stock soon')).toBe(false);
  });

  it('parses wishlist price drops with Turkish Lira (₺/TL) and European locales', () => {
    const { parseWishlistPriceDrop } = require('../utils/availability.js');
    const trDrop = parseWishlistPriceDrop('Fiyatı %15 düştü (listeye eklendiğinde 1.299,00 TL idi)', 1104.15);
    expect(trDrop).toMatchObject({
      percent: 15,
      wasPrice: 1299,
      amount: 194.85,
      currency: '₺'
    });

    const enTrDrop = parseWishlistPriceDrop('Price dropped 10% (was 1.000,00 TL when added to List)', 900);
    expect(enTrDrop).toMatchObject({
      percent: 10,
      wasPrice: 1000,
      amount: 100,
      currency: '₺'
    });

    const deDrop = parseWishlistPriceDrop('Preis um 20% gesunken (war 49,99 € beim Hinzufügen)', 39.99);
    expect(deDrop).toMatchObject({
      percent: 20,
      wasPrice: 49.99,
      amount: 10,
      currency: '€'
    });
  });
});
