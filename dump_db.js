const fs = require('fs');
const initSqlJs = require('sql.js');

async function dump() {
  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync('cuutruyen-cache.db');
  const db = new SQL.Database(fileBuffer);
  
  const res = db.exec("SELECT * FROM manga_list LIMIT 5");
  if (res.length > 0) {
    console.log(JSON.stringify(res[0], null, 2));
  } else {
    console.log("No data in manga_list");
  }
}
dump();
