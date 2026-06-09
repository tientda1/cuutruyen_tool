const fs = require('fs');
const initSqlJs = require('sql.js');

async function run() {
  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync('cuutruyen-cache.db');
  const db = new SQL.Database(fileBuffer);
  
  const res = db.exec("SELECT * FROM manga_list WHERE title LIKE '%thú nhận%'");
  console.log("Manga Search:", JSON.stringify(res, null, 2));

  const downloaded = db.exec("SELECT * FROM downloaded");
  console.log("Downloaded:", JSON.stringify(downloaded, null, 2));
}
run().catch(console.error);
