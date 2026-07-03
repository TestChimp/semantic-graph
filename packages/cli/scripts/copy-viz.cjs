const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '../../viz/dist');
const dest = path.resolve(__dirname, '../static/viz');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('Missing viz build output. Run: npm run build -w @testchimp/semantic-graph-viz');
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name);
  const to = path.join(dest, name);
  if (fs.statSync(from).isDirectory()) {
    fs.cpSync(from, to, { recursive: true });
  } else {
    fs.copyFileSync(from, to);
  }
}

console.log(`Copied viz assets to ${dest}`);
