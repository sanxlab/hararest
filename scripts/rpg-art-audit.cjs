// Verify catalog coverage and generated-image integrity before publishing.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

(async () => {
  const root = path.resolve(__dirname, '../public');
  const directory = path.join(root, 'rpg/assets');
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const index = JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8'));
  const groups = { character: 'characters', enemy: 'enemies', arena: 'arenas' };
  const counts = { character: 0, enemy: 0, arena: 0 };
  const ids = new Set();
  const paths = new Set();
  let bytes = 0;
  for (const asset of manifest.assets) {
    assert(!ids.has(asset.id), `Duplicate ID: ${asset.id}`);
    assert(!paths.has(asset.path), `Duplicate image: ${asset.path}`);
    ids.add(asset.id);
    paths.add(asset.path);
    counts[asset.kind]++;
    const key = asset.kind === 'arena' ? asset.region : asset.id;
    assert.equal(index[groups[asset.kind]][key], asset.path, `Index mismatch: ${asset.id}`);
    assert.match(asset.path, /^\/rpg\/assets\/v\d+\/[a-z0-9_-]+\.webp$/);
    const data = await fs.readFile(path.join(root, asset.path));
    const metadata = await sharp(data).metadata();
    assert.equal(metadata.format, 'webp');
    assert(metadata.width > 0 && metadata.height > 0);
    if (asset.kind !== 'arena') {
      const stats = await sharp(data).stats();
      assert(metadata.hasAlpha, `Missing alpha: ${asset.id}`);
      assert.equal(stats.channels.at(-1).min, 0, `Missing transparent pixels: ${asset.id}`);
      assert.equal(stats.channels.at(-1).max, 255, `Missing opaque pixels: ${asset.id}`);
    }
    if (asset.status !== 'existing') {
      const record = JSON.parse(
        await fs.readFile(path.join(directory, 'provenance', asset.id + '.json'), 'utf8'),
      );
      assert.equal(record.id, asset.id);
      assert.equal(record.generator, 'built-in image_gen');
      assert.equal(record.prompt, asset.prompt);
      assert.equal(record.bytes, data.length);
      assert.equal(record.width, metadata.width);
      assert.equal(record.height, metadata.height);
      assert.equal(record.sha256, crypto.createHash('sha256').update(data).digest('hex'));
      asset.status = 'generated';
    }
    bytes += data.length;
  }
  assert.deepEqual(counts, { character: 60, enemy: 100, arena: 10 });
  for (const [kind, group] of Object.entries(groups))
    assert.equal(Object.keys(index[group]).length, counts[kind]);
  if (process.argv.includes('--finalize')) {
    await fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
  }
  console.log(JSON.stringify({ assets: ids.size, counts, bytes, verified: true }));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
