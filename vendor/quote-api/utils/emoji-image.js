const path = require('path')
const fs = require('fs')
const { gunzipSync } = require('zlib')
const modern = require('./emoji-modern')

const emojiJFilesDir = '../assets/emoji/'

const emojiJsonByBrand = {
  apple: 'emoji-apple-image.json.gz'
}

// Lazy-loaded emoji data — only apple is loaded eagerly (default brand)
const emojiImageByBrand = {}

function loadBrand (brand) {
  if (emojiImageByBrand[brand]) return emojiImageByBrand[brand]

  const jsonFile = emojiJsonByBrand[brand]
  if (!jsonFile) return {}

  const filePath = path.resolve(__dirname, emojiJFilesDir + jsonFile)

  try {
    if (fs.existsSync(filePath)) {
      // Hararest keeps the upstream default emoji set compressed on disk.
      // Keep existing artwork; Noto fills only missing newer emoji.
      emojiImageByBrand[brand] = { ...modern.images, ...JSON.parse(gunzipSync(fs.readFileSync(filePath)).toString('utf8')) }
    } else {
      emojiImageByBrand[brand] = {}
    }
  } catch (error) {
    console.error('Failed to load emoji brand', brand, error.message)
    emojiImageByBrand[brand] = {}
  }

  return emojiImageByBrand[brand]
}

// Eager-load apple (default brand) at startup
loadBrand('apple')

module.exports = { loadBrand, brands: emojiJsonByBrand }
