const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('response', async response => {
    if (response.url().includes('/api/v2/chapters/')) {
      const json = await response.json();
      fs.writeFileSync('stealth_dump.json', JSON.stringify(json, null, 2));
      console.log('Intercepted API response and saved to stealth_dump.json');
      await browser.close();
      process.exit(0);
    }
  });

  console.log("Navigating...");
  try {
    await page.goto('https://cuutruyen.net/chapters/120286', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.error(e);
    await browser.close();
  }
})();
