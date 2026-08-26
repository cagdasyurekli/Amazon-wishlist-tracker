const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const iconVariants = [
  { size: 16, source: 'saved-signal-logo-16.svg' },
  { size: 32, source: 'saved-signal-logo-32.svg' }
];

async function main() {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  try {
    const page = await browser.newPage();

    for (const { size, source } of iconVariants) {
      const svg = fs.readFileSync(path.join(projectRoot, 'assets', source), 'utf8');
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await page.setContent(
        `<style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
      );
      await page.screenshot({
        path: path.join(projectRoot, 'assets', `icon${size}.png`),
        omitBackground: true
      });
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
