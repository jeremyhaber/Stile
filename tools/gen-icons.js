// Generates extension/icons/*.png. Run: node tools/gen-icons.js
const sharp = require('/opt/npm-tools/node_modules/sharp');
const path = require('path');
const out = path.join(__dirname, '..', 'extension', 'icons');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7c8cff"/><stop offset="1" stop-color="#5b3fd9"/></linearGradient></defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g)"/>
  <rect x="16" y="16" width="34" height="96" rx="13" fill="#fff" fill-opacity="0.95"/>
  <rect x="58" y="30" width="48" height="12" rx="6" fill="#fff" fill-opacity="0.55"/>
  <rect x="58" y="58" width="48" height="12" rx="6" fill="#fff" fill-opacity="0.38"/>
  <rect x="58" y="86" width="32" height="12" rx="6" fill="#fff" fill-opacity="0.25"/>
</svg>`;
(async () => {
  for (const s of [16, 32, 48, 128]) {
    await sharp(Buffer.from(svg), { density: 384 }).resize(s, s).png().toFile(path.join(out, `icon${s}.png`));
  }
  console.log('icons written');
})();
