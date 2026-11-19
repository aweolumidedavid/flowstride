const { defineConfig } = require('playwright/test');

module.exports = defineConfig({
  testDir: './specs',
  reporter: [
    ['list'],
    ['flowstride/playwright-reporter'],
  ],
});
