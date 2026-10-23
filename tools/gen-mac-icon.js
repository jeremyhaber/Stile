// Generates mac/Resources/AppIcon.iconset (macOS app icon). Run: node tools/gen-mac-icon.js
// build.sh turns the iconset into AppIcon.icns with iconutil.
const sharp = require('/opt/npm-tools/node_modules/sharp');
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'mac', 'Resources', 'AppIcon.iconset');
fs.mkdirSync(out, { recursive: true });

// Apple's grid: the shape is 824x824 centred on a 1024 canvas, with a soft shadow below.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#8b9bff"/><stop offset="1" stop-color="#5a3fd8"/>
    </linearGradient>
    <linearGradient id="win" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef0ff"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#1b1060" flood-opacity="0.35"/>
    </filter>
    <filter id="soft" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#1b1060" flood-opacity="0.25"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#shadow)"/>
  <!-- browser window -->
  <rect x="210" y="250" width="604" height="524" rx="64" fill="url(#win)" filter="url(#soft)"/>
  <!-- sidebar -->
  <path d="M274 250 h150 v524 h-150 a64 64 0 0 1 -64 -64 v-396 a64 64 0 0 1 64 -64 z" fill="#d9ddff"/>
  <circle cx="262" cy="300" r="13" fill="#ff6159"/><circle cx="302" cy="300" r="13" fill="#ffbd2e"/><circle cx="342" cy="300" r="13" fill="#28c941"/>
  <rect x="246" y="350" width="146" height="36" rx="18" fill="#6d55e6"/>
  <rect x="246" y="410" width="146" height="28" rx="14" fill="#ffffff" fill-opacity="0.9"/>
  <rect x="246" y="458" width="120" height="28" rx="14" fill="#ffffff" fill-opacity="0.75"/>
  <rect x="246" y="506" width="134" height="28" rx="14" fill="#ffffff" fill-opacity="0.6"/>
  <!-- page -->
  <rect x="468" y="320" width="300" height="34" rx="17" fill="#e3e6ff"/>
  <rect x="468" y="392" width="300" height="160" rx="24" fill="#eceeff"/>
  <rect x="468" y="580" width="220" height="24" rx="12" fill="#e3e6ff"/>
  <rect x="468" y="624" width="260" height="24" rx="12" fill="#e3e6ff"/>
</svg>`;

const sizes = [16, 32, 128, 256, 512];
(async () => {
  for (const s of sizes) {
    await sharp(Buffer.from(svg)).resize(s, s).png().toFile(path.join(out, `icon_${s}x${s}.png`));
    await sharp(Buffer.from(svg)).resize(s * 2, s * 2).png().toFile(path.join(out, `icon_${s}x${s}@2x.png`));
  }
  await sharp(Buffer.from(svg)).resize(1024, 1024).png().toFile(path.join(__dirname, '..', 'mac', 'Resources', 'AppIcon-preview.png'));
  console.log('mac icon written');
})();
