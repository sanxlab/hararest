// Import a built-in image_gen output without resizing or changing its pixels.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
(async () => {
  const [id, source] = process.argv.slice(2);
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'public/rpg/assets/manifest.json'), 'utf8'),
  );
  const asset = manifest.assets.find((a) => a.id === id);
  if (!asset || asset.status === 'existing' || !source)
    throw new Error('Expected a new catalog asset and generated source path');
  const data = await fs.readFile(source);
  const metadata = await sharp(data).metadata();
  const stats = await sharp(data).stats();
  if (
    asset.kind !== 'arena' &&
    (!metadata.hasAlpha || stats.channels.at(-1).min !== 0 || stats.channels.at(-1).max !== 255)
  ) {
    throw new Error('Sprite must contain genuine transparent and opaque pixels');
  }
  const encoded = await sharp(data).webp({ lossless: true, effort: 6 }).toBuffer();
  const dest = path.join(root, 'public', asset.path);
  await fs.writeFile(dest, encoded, { flag: 'wx' });
  const record = {
    id,
    generator: 'built-in image_gen',
    source_file: path.basename(source),
    source_sha256: crypto.createHash('sha256').update(data).digest('hex'),
    sha256: crypto.createHash('sha256').update(encoded).digest('hex'),
    width: metadata.width,
    height: metadata.height,
    alpha: metadata.hasAlpha,
    bytes: encoded.length,
    prompt: asset.prompt,
  };
  await fs.mkdir(path.join(root, 'public/rpg/assets/provenance'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'public/rpg/assets/provenance', id + '.json'),
    JSON.stringify(record, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({ id, path: asset.path, bytes: encoded.length, alpha: metadata.hasAlpha }),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
