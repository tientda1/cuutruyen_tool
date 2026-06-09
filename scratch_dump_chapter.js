const fs = require('fs');

(async () => {
  // Try to use playwright to get the chapter data directly from API using existing profile/cookies
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  
  // Nạp cookies từ file (để bypass Cloudflare & Login)
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
  
  // Listen for the specific API response
  page.on('response', async response => {
    if (response.url().includes('/api/v2/chapters/')) {
      const json = await response.json();
      console.log(JSON.stringify(json, null, 2));
      fs.writeFileSync('chapter_api_dump.json', JSON.stringify(json, null, 2));
      await browser.close();
      process.exit(0);
    }
  });

  // Example chapter url
  // I need to find a valid chapter url. Let's just do a search first to get one.
  console.log("Navigating...");
  await page.goto('https://cuutruyen.net/chapters/120286', { waitUntil: 'domcontentloaded' });
  
  setTimeout(async () => {
    console.log("Timeout reached");
    await browser.close();
  }, 15000);
})();
