// Lets `node --test playwright/tests` run the whole suite (Node resolves a directory argument
// to its index.js). Each *.test.js file can also be run on its own.
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).filter(n => n.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, f));
}
