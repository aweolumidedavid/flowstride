function discountedTotal(pricesInCents, discountPercent) {
  const subtotal = pricesInCents.reduce((total, price) => total + price, 0);
  return Math.round(subtotal * (100 - discountPercent) / 100);
}

module.exports = { discountedTotal };
