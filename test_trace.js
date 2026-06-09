const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const fs = require('fs');

async function test() {
  const browser = await chromium.launchPersistentContext('.browser-profile', { headless: true });
  const page = await browser.newPage();
  
  // Listen for all API requests
  page.on('response', async (res) => {
    if (res.url().includes('api')) {
      console.log('API RESPONSE:', res.url(), res.status());
    }
  });

  // Navigate to a valid manga URL (e.g., getting one from recently updated)
  await page.goto('https://cuutruyen.net/mangas', { waitUntil: 'networkidle' });
  
  // Now evaluate to get a real manga URL
  const href = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/mangas/"]');
    return a ? a.href : null;
  });
  
  if (href) {
    console.log('Navigating to manga:', href);
    await page.goto(href, { waitUntil: 'networkidle' });
  } else {
    console.log('No manga link found on /mangas');
  }

  await browser.close();
}

test().catch(console.error);
