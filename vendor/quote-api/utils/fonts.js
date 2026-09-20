// Hararest adaptation: use deployment-provided fonts without downloading files.
const fs = require('fs')
const path = require('path')
const { registerFont } = require('canvas')

const NOTO_DIRS = [
  '/usr/share/fonts/truetype/noto',
  '/usr/share/fonts/google-noto',
  '/usr/share/fonts/noto'
]
const DEJAVU_DIRS = [
  '/usr/share/fonts/truetype/dejavu',
  '/usr/share/fonts/dejavu',
  '/usr/share/fonts/dejavu-sans-fonts',
  '/usr/share/fonts/dejavu-sans-mono-fonts'
]

let loaded = false

module.exports = async () => {
  if (loaded) return
  loaded = true

  for (const [family, fallback] of [['NotoSans', 'DejaVuSans'], ['NotoSansMono', 'DejaVuSansMono']]) {
    for (const [suffix, fallbackSuffix, weight, style] of [
      ['Regular', '', 'normal', 'normal'],
      ['Bold', '-Bold', 'bold', 'normal'],
      ['Italic', '-Oblique', 'normal', 'italic'],
      ['BoldItalic', '-BoldOblique', 'bold', 'italic']
    ]) {
      const candidates = [
        ...NOTO_DIRS.map(dir => path.join(dir, `${family}-${suffix}.ttf`)),
        ...DEJAVU_DIRS.map(dir => path.join(dir, `${fallback}${fallbackSuffix}.ttf`))
      ]
      const file = candidates.find(candidate => fs.existsSync(candidate))
      if (!file) continue // Pango's system fallback remains available.
      registerFont(file, { family, weight, style })
      if (family === 'NotoSans') registerFont(file, { family: 'Noto Sans', weight, style })
    }
  }
}
