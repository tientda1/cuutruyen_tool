const fs = require('fs');

let content = fs.readFileSync('src/nutaid.js', 'utf8');

// If the file is wrapped in a Node script wrapper:
const startIdx = content.indexOf('// ==UserScript==');
if (startIdx !== -1) {
    let extracted = content.substring(startIdx);
    
    // remove the last `;fs.writeFileSync...` part if it exists
    const endIdx = extracted.indexOf('fs.writeFileSync(');
    if (endIdx !== -1) {
        extracted = extracted.substring(0, endIdx);
    }
    
    // It might end with `";` or similar
    extracted = extracted.trim();
    if (extracted.endsWith('`;')) {
        extracted = extracted.substring(0, extracted.length - 2);
    }
    
    // unescape ` and $
    extracted = extracted.replace(/\\\`/g, '`').replace(/\\\$/g, '$');
    
    fs.writeFileSync('src/nutaid.js', extracted);
    console.log('Fixed src/nutaid.js');
} else {
    console.log('File does not seem to have the Node wrapper');
}
