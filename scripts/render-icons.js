#!/usr/bin/env node
'use strict';

// Renders a game's icon.svg into the PNG app icons its manifest lists.
//
//   npx -y -p playwright node scripts/render-icons.js ../snap/public/icon.svg ../snap/public/icons
//
// Writes icon-192.png, icon-512.png, apple-touch-icon.png (180) and
// icon-maskable-512.png. Phones crop maskable icons to a circle or squircle,
// so that one shrinks the art to the middle (pass a scale, default 0.72) and
// fills round it with the SVG's first <rect> colour. Needs Chromium: run
// `npx playwright install chromium` once if Playwright can't find one.

const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Needs Playwright: npx -y -p playwright node scripts/render-icons.js <icon.svg> <out-dir>');
  process.exit(1);
}

const [svgFile, outDir, maskScale = '0.72'] = process.argv.slice(2);
if (!svgFile || !outDir) {
  console.error('usage: render-icons.js <icon.svg> <out-dir> [maskable-scale]');
  process.exit(1);
}

(async () => {
  const svg = fs.readFileSync(svgFile, 'utf8');
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const bg = (/<rect[^>]*fill="([^"]+)"/.exec(svg) || [])[1] || '#0d0f1c';
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shot = async (size, file, scale = 1, fill = null) => {
    await page.setViewportSize({ width: size, height: size });
    const inner = Math.round(size * scale);
    await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${fill || 'transparent'}">
      <img src="${src}" style="width:${inner}px;height:${inner}px;display:block">`);
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: path.join(outDir, file), omitBackground: !fill });
    console.log(`wrote ${path.join(outDir, file)}`);
  };
  await shot(192, 'icon-192.png');
  await shot(512, 'icon-512.png');
  await shot(180, 'apple-touch-icon.png', 1, bg);
  await shot(512, 'icon-maskable-512.png', Number(maskScale), bg);
  await browser.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
