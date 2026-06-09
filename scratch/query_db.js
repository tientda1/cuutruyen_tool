const fs = require('fs');
const initSqlJs = require('sql.js');

async function run() {
  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync('cuutruyen-cache.db');
  const db = new SQL.Database(fileBuffer);
  
  // list tables
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  console.log("Tables:", JSON.stringify(tables, null, 2));

  // query download history
  try {
    const history = db.exec("SELECT * FROM download_history LIMIT 10");
    console.log("download_history:", JSON.stringify(history, null, 2));
  } catch (e) {
    console.error(e);
  }

  // query chapters
  try {
    const chapters = db.exec("SELECT * FROM chapters LIMIT 10");
    console.log("chapters:", JSON.stringify(chapters, null, 2));
  } catch (e) {
    console.error(e);
  }
}
run().catch(console.error);
