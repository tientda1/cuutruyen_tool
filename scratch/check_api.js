const { initBrowser } = require('../src/browser');
const { getChapterImages } = require('../src/scraper');

async function test() {
  const { browser, context } = await initBrowser({ headless: true });
  const page = await context.newPage();

  console.log("Fetching chapter images metadata for 73429...");
  const chapterUrl = 'https://cuutruyen.net/chapters/73429';
  
  // Intercept and print response URLs and canvas status
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));

  // Inject or check after loading
  const { imageUrls, chapterInfo } = await getChapterImages(page, chapterUrl, {
    mangaTitle: 'Test Manga',
    chapterNumber: '1'
  });

  console.log('Chapter Info:', chapterInfo);
  console.log('Total imageUrls returned:', imageUrls.length);
  
  await browser.close();
}

test().catch(console.error);
