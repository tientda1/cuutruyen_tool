const fs = require('fs');
let content = fs.readFileSync('src/nutaid.js', 'utf8');
content = content.replace(/\\\`/g, '`').replace(/\\\$/g, '$');
fs.writeFileSync('src/nutaid.js', content);
