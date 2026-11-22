const EmojiDbLib = require('emoji-db')
const modern = require('./emoji-modern')

const db = new EmojiDbLib({ useDefaultDb: true })
// The pinned library builds its longest-match search tree from dbData. Extend
// that data rather than splitting new emoji into surrogate or ZWJ fragments.
for (const code of Object.keys(modern.images)) {
  if (!db.dbData[code]) db.dbData[code] = { code, emoji: db.fromCodePoint(code) }
}
for (const [code, qualified] of Object.entries(modern.aliases)) {
  if (!db.dbData[code]) db.dbData[code] = { code, emoji: db.fromCodePoint(code), qualified }
}

module.exports = db
