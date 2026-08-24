import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8'));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
    return {};
  }
}

function requireFile(relativePath, label = relativePath) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    fail(`${label} is missing: ${relativePath}`);
  }
}

function inspectPng(relativePath, expectedSize) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) return;

  const png = readFileSync(absolutePath);
  const signature = '89504e470d0a1a0a';
  if (png.length < 33 || png.subarray(0, 8).toString('hex') !== signature) {
    fail(`${relativePath} is not a valid PNG`);
    return;
  }

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25];
  let hasTransparencyChunk = false;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'tRNS') hasTransparencyChunk = true;
    offset += length + 12;
    if (type === 'IEND') break;
  }

  if (width !== expectedSize || height !== expectedSize) {
    fail(`${relativePath} must be ${expectedSize}x${expectedSize}, found ${width}x${height}`);
  }
  if (![4, 6].includes(colorType) && !hasTransparencyChunk) {
    fail(`${relativePath} must include alpha transparency for light and dark Chrome themes`);
  }
}

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
const lock = readJson('package-lock.json');

for (const publicFile of [
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'PRIVACY.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'RELEASE_CHECKLIST.md',
  'CHROMEWEBSTORE.md'
]) {
  requireFile(publicFile, 'public-readiness document');
}

if (manifest.manifest_version !== 3) fail('manifest.json must remain Manifest V3');
if (!pkg.private) fail('package.json must remain private to prevent accidental npm publication');
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  fail('The no-build extension must not declare production npm dependencies');
}

const versions = {
  manifest: manifest.version,
  package: pkg.version,
  lockfile: lock.version,
  lockRoot: lock.packages?.['']?.version
};
if (new Set(Object.values(versions)).size !== 1 || Object.values(versions).some((value) => !value)) {
  fail(`Version mismatch: ${JSON.stringify(versions)}`);
}
if (lock.packages?.['']?.license !== pkg.license) {
  fail(`License mismatch: package.json=${pkg.license}, package-lock.json=${lock.packages?.['']?.license}`);
}

const manifestFiles = [
  [manifest.background?.service_worker, 'background service worker'],
  [manifest.action?.default_popup, 'action popup'],
  [manifest.options_ui?.page, 'options page']
];
for (const contentScript of manifest.content_scripts || []) {
  for (const script of contentScript.js || []) manifestFiles.push([script, 'content script']);
  for (const style of contentScript.css || []) manifestFiles.push([style, 'content stylesheet']);
}
for (const [relativePath, label] of manifestFiles) {
  if (!relativePath) fail(`${label} is not declared in manifest.json`);
  else requireFile(relativePath, label);
}

for (const size of [16, 32, 48, 128]) {
  const key = String(size);
  const iconPath = manifest.icons?.[key];
  const actionIconPath = manifest.action?.default_icon?.[key];
  if (!iconPath) fail(`manifest icons.${key} is required`);
  else {
    requireFile(iconPath, `manifest icon ${key}`);
    inspectPng(iconPath, size);
  }
  if (!actionIconPath) fail(`manifest action.default_icon.${key} is required`);
  else {
    requireFile(actionIconPath, `action icon ${key}`);
    inspectPng(actionIconPath, size);
  }
}

for (const htmlPath of [manifest.action?.default_popup, manifest.options_ui?.page, 'src/dashboard/dashboard.html']) {
  if (!htmlPath || !existsSync(join(repoRoot, htmlPath))) continue;
  const html = readFileSync(join(repoRoot, htmlPath), 'utf8');
  if (/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) {
    fail(`${htmlPath} references remote executable or stylesheet content`);
  }
}

try {
  const insideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim() === 'true';
  if (insideWorkTree) {
    execFileSync('git', ['diff', '--check'], { cwd: repoRoot, stdio: 'inherit' });
    const trackedFiles = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).split('\n').filter(Boolean);
    const localOnlyFiles = trackedFiles.filter((relativePath) =>
      relativePath === '.DS_Store' ||
      relativePath.startsWith('.agents/') ||
      relativePath.startsWith('.remember/') ||
      relativePath.startsWith('.claude/')
    );
    if (localOnlyFiles.length > 0) {
      fail(`Local-only files are tracked: ${localOnlyFiles.join(', ')}`);
    }
  }
} catch (error) {
  if (existsSync(join(repoRoot, '.git'))) fail(`git diff --check failed: ${error.message}`);
  else console.log('SKIP git diff --check (not a Git worktree)');
}

if (failures.length > 0) {
  console.error('Release validation failed:');
  failures.forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log(`Release metadata and assets are valid for version ${manifest.version}.`);
}
