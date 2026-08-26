const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'assets', 'github-social-preview.svg');
const outputPath = path.join(projectRoot, 'assets', 'github-social-preview.png');

async function main() {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 1 });
    await page.goto(`file://${sourcePath}`, { waitUntil: 'load' });
    await page.screenshot({ path: outputPath, omitBackground: false });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
