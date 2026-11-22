// Locally bundled additions newer than emoji-db 16; no runtime network access.
// Provenance and upstream revision are recorded inside the compressed bundle.
const fs = require('fs')
const path = require('path')
const { gunzipSync } = require('zlib')

module.exports = JSON.parse(gunzipSync(fs.readFileSync(
  path.join(__dirname, '../assets/emoji/emoji-modern-image.json.gz')
)).toString('utf8'))
