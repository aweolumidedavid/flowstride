const { test, expect } = require('playwright/test');
const { discountedTotal } = require('../helpers/catalog.js');

test('applies the catalog discount in cents', () => {
  expect(discountedTotal([12500, 8500, 4000], 10)).toBe(22500);
});
