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
  });

  it('returns unknown for unrelated availability copy', () => {
    expect(classifyAvailabilityText('See product details')).toBeNull();
  });
});
