import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest ${manifest.version}, package ${pkg.version}.`);
  process.exit(1);
}

const version = manifest.version;
const folder = `AirSign-v${version}`;
const dist = path.join(root, 'dist');
const stage = path.join(dist, folder);
const zipPath = path.join(dist, `${folder}.zip`);
const storeZipPath = path.join(dist, `${folder}-store.zip`);

const files = [
  'manifest.json', 'background.js', 'bubble.js', 'content.js',
  'offscreen.html', 'offscreen.js', 'permission.html', 'permission.js',
  'sandbox.html', 'sandbox.js', 'sidepanel.css', 'sidepanel.html', 'sidepanel.js',
  'README.md', 'LICENSE'
];
const folders = ['lib', 'vendor', 'icons'];

await rm(stage, { recursive: true, force: true });
await rm(zipPath, { force: true });
await rm(storeZipPath, { force: true });
await mkdir(stage, { recursive: true });
for (const file of files) await cp(path.join(root, file), path.join(stage, file));
for (const directory of folders) {
  await cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await collect(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function collectManifestAssets(value, assets = new Set()) {
  if (typeof value === 'string') {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && /\.(?:js|mjs|html|css|png|svg|json|wasm|task)$/i.test(value)) {
      assets.add(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectManifestAssets(item, assets);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectManifestAssets(item, assets);
  }
  return assets;
}

async function collectHtmlAssets(directory) {
  const assets = new Set();
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.html')) continue;
    const source = await readFile(path.join(directory, name), 'utf8');
    for (const match of source.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*?(?:src|href)="([^"]+)"/gi)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
      assets.add(path.posix.normalize(target.replace(/^\.?\//, '')));
    }
  }
  return assets;
}

async function collectJsAssets(directory) {
  const assets = new Set();
  for (const file of await collect(directory)) {
    if (!/\.(?:js|mjs)$/i.test(file)) continue;
    const relative = path.relative(directory, file).split(path.sep).join('/');
    if (relative.startsWith('vendor/')) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/['"]([^'"]+\.(?:js|mjs|html|css|png|svg|json|wasm|task))['"]/gi)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target) || target.includes('${')) continue;
      const resolved = target.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), target))
        : path.posix.normalize(target);
      assets.add(resolved);
    }
  }
  return assets;
}

async function zipEntryNames(file) {
  const buffer = await readFile(file);
  const names = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    names.push(buffer.toString('utf8', offset + 30, offset + 30 + nameLength));
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  return names;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const filesToZip = await collect(stage);
const relativeToDist = (file) => path.relative(dist, file).split(path.sep).join('/');
const relativeToStage = (file) => path.relative(stage, file).split(path.sep).join('/');

const stagedNames = new Set(filesToZip.map(relativeToStage));
const requiredAssets = new Set([
  'manifest.json',
  ...collectManifestAssets(manifest),
  ...await collectHtmlAssets(stage),
  ...await collectJsAssets(stage)
]);
const missingAssets = [...requiredAssets].filter((name) => !stagedNames.has(name));
if (missingAssets.length) {
  console.error(`Package is missing referenced assets: ${missingAssets.join(', ')}`);
  process.exit(1);
}
console.log(`Staged ${filesToZip.length} files; verified ${requiredAssets.size} referenced assets.`);

async function writeZip(entries, destination, entryName) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of entries) {
    const name = entryName(file);
    const nameBytes = Buffer.from(name, 'utf8');
    const data = await readFile(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const zip = Buffer.concat([Buffer.concat(localParts), centralDirectory, end]);
  await writeFile(destination, zip);
  const digest = createHash('sha256').update(zip).digest('hex');
  await writeFile(`${destination}.sha256`, `${digest}  ${path.basename(destination)}\n`);

  const info = await stat(destination);
  const megabytes = (info.size / 1024 / 1024).toFixed(2);
  console.log(`Packaged ${entries.length} files -> ${path.relative(root, destination)} (${megabytes} MB)`);
  console.log(`SHA-256: ${digest}`);
}

async function verifyArchive(file, prefix) {
  const expected = filesToZip.map((entry) => `${prefix}${relativeToStage(entry)}`);
  const expectedSet = new Set(expected);
  const names = await zipEntryNames(file);
  const actual = new Set(names);
  const missing = expected.filter((name) => !actual.has(name));
  const extra = names.filter((name) => !expectedSet.has(name));
  if (names.length !== expected.length || missing.length || extra.length) {
    console.error(`Archive verification failed for ${path.basename(file)}.`);
    if (missing.length) console.error(`- Missing: ${missing.join(', ')}`);
    if (extra.length) console.error(`- Unexpected: ${extra.join(', ')}`);
    if (names.length !== expected.length) {
      console.error(`- Entry count ${names.length}, expected ${expected.length}.`);
    }
    process.exit(1);
  }
  console.log(`Verified ${path.basename(file)}: ${names.length} entries.`);
}

await writeZip(filesToZip, zipPath, relativeToDist);
await verifyArchive(zipPath, `${folder}/`);
await writeZip(filesToZip, storeZipPath, relativeToStage);
await verifyArchive(storeZipPath, '');
