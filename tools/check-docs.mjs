import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

async function read(relative) {
  return readFile(path.join(root, relative));
}

async function exists(relative) {
  try {
    await stat(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function compare(extensionPath, docsPath, transform = (value) => value) {
  const [extension, docs] = await Promise.all([read(extensionPath), read(docsPath)]);
  check(
    transform(extension.toString('utf8')) === docs.toString('utf8'),
    `${docsPath} is stale; copy ${extensionPath} into docs (matching the docs import paths).`
  );
}

const manifest = JSON.parse(await read('manifest.json'));
const pkg = JSON.parse(await read('package.json'));
check(manifest.version === pkg.version, `manifest.json (${manifest.version}) and package.json (${pkg.version}) disagree.`);

const runtimeFiles = [
  'manifest.json', 'background.js', 'bubble.js', 'content.js',
  'offscreen.html', 'offscreen.js', 'permission.html', 'permission.js',
  'sandbox.html', 'sandbox.js', 'sidepanel.css', 'sidepanel.html', 'sidepanel.js',
  'lib/gestures.mjs', 'lib/one-euro.mjs',
  'vendor/vision_bundle.mjs', 'vendor/hand_landmarker.task',
  'vendor/wasm/vision_wasm_internal.js', 'vendor/wasm/vision_wasm_internal.wasm',
  'vendor/wasm/vision_wasm_nosimd_internal.js', 'vendor/wasm/vision_wasm_nosimd_internal.wasm',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png',
  'README.md', 'LICENSE'
];

const docsFiles = [
  'docs/.nojekyll',
  'docs/index.html', 'docs/styles.css', 'docs/demo.js', 'docs/content.js',
  'docs/lib/gestures.js', 'docs/lib/one-euro.js',
  'docs/vendor/vision_bundle.js', 'docs/vendor/hand_landmarker.task',
  'docs/vendor/wasm/vision_wasm_internal.js', 'docs/vendor/wasm/vision_wasm_internal.wasm',
  'docs/vendor/wasm/vision_wasm_nosimd_internal.js', 'docs/vendor/wasm/vision_wasm_nosimd_internal.wasm',
  'docs/icon16.png', 'docs/icon128.png'
];

for (const file of [...runtimeFiles, ...docsFiles]) {
  check(await exists(file), `Missing required file: ${file}`);
}

await compare('content.js', 'docs/content.js');
await compare('lib/one-euro.mjs', 'docs/lib/one-euro.js');
await compare(
  'lib/gestures.mjs',
  'docs/lib/gestures.js',
  (source) => source.replace("from './one-euro.mjs'", "from './one-euro.js'")
);
await compare('vendor/vision_bundle.mjs', 'docs/vendor/vision_bundle.js');
await compare('vendor/hand_landmarker.task', 'docs/vendor/hand_landmarker.task');

for (const icon of ['icon16.png', 'icon128.png']) {
  const [extension, docs] = await Promise.all([read(`icons/${icon}`), read(`docs/${icon}`)]);
  check(sha256(extension) === sha256(docs), `docs/${icon} is stale; copy icons/${icon} into docs.`);
}

const wasmFiles = await readdir(path.join(root, 'vendor/wasm'));
const docsWasmFiles = await readdir(path.join(root, 'docs/vendor/wasm'));
check(
  wasmFiles.sort().join('\n') === docsWasmFiles.sort().join('\n'),
  'docs/vendor/wasm does not contain the same files as vendor/wasm.'
);
for (const file of wasmFiles) {
  const [extension, docs] = await Promise.all([
    read(`vendor/wasm/${file}`),
    read(`docs/vendor/wasm/${file}`)
  ]);
  check(sha256(extension) === sha256(docs), `docs/vendor/wasm/${file} is stale.`);
}

const [contentSource, demoSource, docsIndex] = await Promise.all([
  read('content.js'),
  read('docs/demo.js'),
  read('docs/index.html')
]);
const versionPattern = new RegExp(`const VERSION = '${manifest.version.replaceAll('.', '\\.')}'`);
check(versionPattern.test(contentSource.toString('utf8')), `content.js VERSION does not match manifest ${manifest.version}.`);
check(versionPattern.test(demoSource.toString('utf8')), `docs/demo.js VERSION does not match manifest ${manifest.version}.`);
check(docsIndex.toString('utf8').includes('src="./content.js"'), 'docs/index.html does not load the page bridge (docs/content.js).');
check(docsIndex.toString('utf8').includes('src="./demo.js"'), 'docs/index.html does not load the showcase module (docs/demo.js).');

const pageText = docsIndex.toString('utf8');
check(!pageText.includes('vendor/vision_bundle.mjs'), 'docs/index.html should use the .js vision bundle copy.');
check(!pageText.includes('lib/gestures.mjs'), 'docs/index.html should use the .js engine copy.');

if (failures.length) {
  console.error(`Docs check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Docs and runtime assets match AirSign ${manifest.version}.`);
}
