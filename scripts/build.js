const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const distDir = path.join(publicDir, 'dist');

const entryPoints = [
  { name: 'app', file: path.join(publicDir, 'app.js') },
  { name: 'viewer', file: path.join(publicDir, 'viewer.js') },
  { name: 'selftest', file: path.join(publicDir, 'selftest.js') }
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function build() {
  ensureDir(distDir);
  await esbuild.build({
    entryPoints: entryPoints.map((entry) => entry.file),
    bundle: true,
    minify: true,
    sourcemap: true,
    outdir: distDir,
    entryNames: '[name].bundle'
  });
  console.log(`[build] Bundled assets to ${distDir}`);
}

build().catch((err) => {
  console.error('[build] Failed to bundle assets', err);
  process.exit(1);
});
