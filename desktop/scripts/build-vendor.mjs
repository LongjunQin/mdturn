import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(SCRIPT_DIR, '..');
const PROJECT_DIR = path.resolve(DESKTOP_DIR, '..');
const VENDOR_DIR = path.join(PROJECT_DIR, 'static', 'vendor');
const PHOSPHOR_PACKAGE_DIR = path.join(DESKTOP_DIR, 'node_modules', '@phosphor-icons', 'web');
const PHOSPHOR_OUTPUT_DIR = path.join(VENDOR_DIR, 'phosphor');

async function walk(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, absolutePath));
    else files.push({ absolutePath, relativePath: path.relative(root, absolutePath) });
  }
  return files;
}

async function validatePinnedVersion(packageDir, expected) {
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  if (manifest.version !== expected) {
    throw new Error(`@phosphor-icons/web 版本必须是 ${expected}，实际是 ${manifest.version || '未知'}。`);
  }
}

async function buildCodeMirror() {
  await build({
    entryPoints: [path.join(DESKTOP_DIR, 'src', 'editor-entry.js')],
    outfile: path.join(VENDOR_DIR, 'mdturn-editor.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome140'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  });
}

async function copyPhosphorAssets() {
  await validatePinnedVersion(PHOSPHOR_PACKAGE_DIR, '2.1.2');
  const assets = (await walk(PHOSPHOR_PACKAGE_DIR)).filter(({ relativePath }) =>
    /\.(?:css|woff2?|ttf)$/i.test(relativePath));
  const styles = assets
    .filter(({ relativePath }) => path.basename(relativePath) === 'style.css')
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (styles.length === 0) throw new Error('没有在 @phosphor-icons/web 中找到 style.css。');

  await rm(PHOSPHOR_OUTPUT_DIR, { recursive: true, force: true });
  for (const asset of assets) {
    const destination = path.join(PHOSPHOR_OUTPUT_DIR, asset.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(asset.absolutePath, destination);
  }

  const imports = styles.map(({ relativePath }) =>
    `@import url("./phosphor/${relativePath.split(path.sep).join('/')}");`);
  await writeFile(path.join(VENDOR_DIR, 'phosphor.css'), `${imports.join('\n')}\n`, 'utf8');
  return { assetCount: assets.length, styleCount: styles.length };
}

await mkdir(VENDOR_DIR, { recursive: true });
await buildCodeMirror();
const phosphor = await copyPhosphorAssets();
console.log(`Vendor build complete: CodeMirror + ${phosphor.styleCount} Phosphor styles / ${phosphor.assetCount} assets.`);

