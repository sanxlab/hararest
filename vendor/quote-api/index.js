const render = require('./methods/generate')
const { loadFonts } = require('./utils')

let initialized

async function generate (payload) {
  if (!initialized) initialized = loadFonts()
  await initialized
  // WhatsApp clients identify senders through from.id, while upstream uses
  // chatId to decide which consecutive bubbles belong to the same sender.
  const normalized = payload && Array.isArray(payload.messages)
    ? {
        ...payload,
        messages: payload.messages.map(message => message && ({
          ...message,
          chatId: message.chatId ?? message.from?.id ?? 0
        }))
      }
    : payload
  const result = await render(normalized)
  if (result.error) return result
  return {
    image: Buffer.isBuffer(result.image) ? result.image.toString('base64') : result.image,
    type: result.type || 'png',
    width: result.width,
    height: result.height
  }
}

module.exports = generate
