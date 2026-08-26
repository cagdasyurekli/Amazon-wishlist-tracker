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
});
