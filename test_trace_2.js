const { getPage, initBrowser } = require('./src/browser');
const { getMangaList } = require('./src/scraper');

async function test() {
  const { browser, context } = await initBrowser({ headless: true });
  const page = await context.newPage();
  
  page.on('response', res => {
    if (res.url().includes('api')) {
      console.log('API:', res.url(), res.status());
    }
  });

  console.log("Getting manga list...");
  const items = await getMangaList(page, { useCache: false });
  console.log(`Found ${items.length} items`);
  
  if (items.length > 0) {
    const targetUrl = items[0].url;
    console.log('Navigating to', targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
  }

  setTimeout(() => process.exit(0), 10000);
}

test().catch(console.error);
