const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('response', response => {
    if (response.url().includes('api') || response.request().resourceType() === 'fetch' || response.request().resourceType() === 'xhr') {
      console.log('API Request:', response.url());
    }
  });

  await page.goto('https://cuutruyen.net/mangas', { waitUntil: 'networkidle', timeout: 30000 });
  const content = await page.content();
  fs.writeFileSync('cuutruyen_dump.html', content);
  
  await browser.close();
  console.log('Done dump.');
})();
