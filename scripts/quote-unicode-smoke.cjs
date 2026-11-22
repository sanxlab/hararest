const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function fontInfo(pattern) {
  const [family, charset] = execFileSync('fc-match', ['-f', '%{family}\n%{charset}', pattern], { encoding: 'utf8' }).trim().split('\n');
  return { family, ranges: charset.split(/\s+/).map(part => part.split('-').map(value => parseInt(value, 16))) };
}

(async () => {
  const japanese = fontInfo('sans-serif:lang=ja');
  assert.match(japanese.family, /Noto Sans CJK JP/, 'Production image needs a Japanese CJK fallback');
  for (const character of 'おはらことね日本語') {
    const code = character.codePointAt(0);
    assert.ok(japanese.ranges.some(([first, last = first]) => code >= first && code <= last), `Missing Japanese glyph U+${code.toString(16)}`);
  }
  assert.match(fontInfo('emoji').family, /Noto Color Emoji/, 'Production image needs an emoji fallback');

  const loadFonts = require(process.cwd() + '/vendor/quote-api/utils/fonts');
  const { prepareText } = require(process.cwd() + '/vendor/quote-api/utils/quote-generate/text-prepare');
  await loadFonts();
  const text = 'Mohamad Fikri 🫪 🫫';
  const prepared = await prepareText('😳 🙄 👩🏽‍💻 🫪 🫫', [], 24, 'apple', {});
  const emojis = prepared.segments.filter(segment => segment.kind === 'emoji');
  assert.equal(emojis.length, 5, 'Legacy and Emoji 17/18 graphemes must stay intact');
  assert.ok(emojis.every(segment => segment.emojiImage), 'Legacy and Emoji 17/18 must load bundled images');

  const response = await fetch('http://127.0.0.1:18080/api/quote/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'quote', format: 'png', backgroundColor: '#FFFFFF', width: 512, height: 512, scale: 2,
      messages: [{ avatar: true, from: { id: 123, name: '~ おおはら ことね', photo: { url: '' } }, text, entities: [] }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  const image = Buffer.from(body.result.image, 'base64');
  const info = await require('sharp')(image).metadata();
  assert.equal(info.format, 'png');
  assert.ok(info.width > 0 && info.width <= 512 && info.height > 0 && info.height <= 512);
  const output = process.argv.find(arg => arg.startsWith('--output='));
  if (output) fs.writeFileSync(output.slice('--output='.length), image);
  console.log('Quote Unicode smoke passed: Japanese glyphs, bundled emoji, color fallback, worker API render');
})().catch(error => { console.error(error); process.exitCode = 1; });
