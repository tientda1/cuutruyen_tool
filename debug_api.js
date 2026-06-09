const fs = require('fs');
const { chromium } = require('playwright');

async function debugAPI() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  
  try {
    const cookiesData = JSON.parse(fs.readFileSync('cuutruyen-cookies.json', 'utf8'));
    if (cookiesData && cookiesData.length > 0) {
      const pwCookies = cookiesData.map(c => ({
        ...c,
        domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain
      }));
      await context.addCookies(pwCookies);
    }
  } catch (err) {}

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9',
    'Cache-Control': 'no-cache',
  });
  
  console.log("Navigating to home...");
  await page.goto('https://cuutruyen.net/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  console.log("Evaluating fetch...");
  const result = await page.evaluate(async () => {
    try {
      // test manga 3074
      const res = await fetch(`/api/v2/mangas/3074`);
      const text = await res.text();
      return { status: res.status, text: text.substring(0, 200) };
    } catch(e) {
      return { error: e.message };
    }
  });
  
  console.log("Manga API result:", result);

  const result2 = await page.evaluate(async () => {
    try {
      const res = await fetch(`/api/v2/mangas/3074/chapters`);
      const text = await res.text();
      return { status: res.status, text: text.substring(0, 200) };
    } catch(e) {
      return { error: e.message };
    }
  });

  console.log("Chapters API result:", result2);
  
  await browser.close();
}

debugAPI().catch(console.error);
