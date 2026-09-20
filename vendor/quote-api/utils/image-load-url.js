// Hararest adaptation: remote resources are fetched and decoded by the API
// service before rendering. Never pass caller-controlled URLs or paths to
// canvas, sharp, filesystem APIs, or a network transport from this module.
const PNG_PREFIX = 'data:image/png;base64,'
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

module.exports = async (value) => {
  if (typeof value !== 'string' || !value.startsWith(PNG_PREFIX)) {
    throw new Error('Quote renderer only accepts normalized PNG data URLs')
  }

  const encoded = value.slice(PNG_PREFIX.length)
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Invalid or oversized quote image data')
  }

  const image = Buffer.from(encoded, 'base64')
  if (image.length > MAX_IMAGE_BYTES || image.toString('base64') !== encoded ||
      !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Quote image is not a normalized PNG')
  }

  return image
}
