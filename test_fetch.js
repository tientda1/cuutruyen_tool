const fs = require('fs');
async function test() {
  const cookiesData = JSON.parse(fs.readFileSync('cuutruyen-cookies.json', 'utf8'));
  const cookieStr = cookiesData.map(c => `${c.name}=${c.value}`).join('; ');
  
  // Chapter 120286 is just a guess from ID. Let's find a real chapter ID.
  // Actually, let's fetch recently updated mangas to get a valid chapter ID.
  let res = await fetch('https://cuutruyen.net/api/v2/mangas/recently_updated?page=1&per_page=1', {
    headers: { 'Cookie': cookieStr }
  });
  let json = await res.json();
  const mangaId = json.data[0].id;
  
  res = await fetch(`https://cuutruyen.net/api/v2/mangas/${mangaId}/chapters`, {
    headers: { 'Cookie': cookieStr }
  });
  json = await res.json();
  const chapterId = json.data[0].id;
  
  res = await fetch(`https://cuutruyen.net/api/v2/chapters/${chapterId}`, {
    headers: { 'Cookie': cookieStr }
  });
  json = await res.json();
  fs.writeFileSync('chapter_api_dump.json', JSON.stringify(json, null, 2));
  console.log("Done");
}
test();
