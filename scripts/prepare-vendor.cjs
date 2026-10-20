const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', '@mediapipe', 'hands');
const destination = path.join(root, 'vendor');
// Copy every runtime/model asset in the pinned package. The SIMD .data file is
// intentionally zero bytes, but it must still exist because the MediaPipe loader
// may request it by URL during WebAssembly initialization.
const required = [
  'hands.js',
  'hands.binarypb',
  'hand_landmark_full.tflite',
  'hand_landmark_lite.tflite',
  'hands_solution_packed_assets_loader.js',
  'hands_solution_packed_assets.data',
  'hands_solution_simd_wasm_bin.data',
  'hands_solution_simd_wasm_bin.js',
  'hands_solution_simd_wasm_bin.wasm',
  'hands_solution_wasm_bin.js',
  'hands_solution_wasm_bin.wasm'
];

if (!fs.existsSync(source)) {
  console.error('MediaPipe package is missing. Run `npm install` from the AirSign folder first.');
  process.exit(1);
}
fs.mkdirSync(destination, { recursive: true });
const missing = [];
for (const filename of required) {
  const from = path.join(source, filename);
  if (!fs.existsSync(from)) { missing.push(filename); continue; }
  fs.copyFileSync(from, path.join(destination, filename));
}
if (missing.length) {
  console.error('Some MediaPipe runtime files were not found in the installed package:');
  for (const filename of missing) console.error(` - ${filename}`);
  process.exit(1);
}
const license = path.join(source, 'README.md');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(destination, 'MEDIAPIPE_README.md'));
console.log(`Copied ${required.length} MediaPipe runtime/model assets into vendor/.`);
console.log(`SIMD data asset size: ${fs.statSync(path.join(destination, 'hands_solution_simd_wasm_bin.data')).size} bytes (0 bytes is expected).`);
console.log('Next: reload the unpacked AirSign extension in chrome://extensions.');
