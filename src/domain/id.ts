let fallbackCounter = 0

/** Creates a UUID-shaped local identifier, including on insecure HTTP origins. */
export function createId(cryptoSource: Crypto | undefined = globalThis.crypto): string {
  const bytes = new Uint8Array(16)
  if (cryptoSource?.getRandomValues) {
    cryptoSource.getRandomValues(bytes)
  } else {
    // randomUUID/getRandomValues may be unavailable on older plain-HTTP origins.
    // Mix clock and a monotonic counter into Math.random output for a collision-resistant fallback.
    fallbackCounter += 1
    const timestamp = Date.now()
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256) ^ (timestamp >>> (index % 24)) ^ (fallbackCounter >>> (index % 16))
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
