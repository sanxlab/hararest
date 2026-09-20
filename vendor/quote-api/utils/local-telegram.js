// Hararest runs a local renderer, without a Telegram bot or API connection.
const unavailable = async () => {
  throw new Error('Telegram file IDs and custom emoji are unavailable in the local renderer')
}

module.exports = Object.freeze({
  getChat: async () => null,
  getFileLink: unavailable,
  callApi: unavailable,
  getCustomEmojiStickers: unavailable
})
