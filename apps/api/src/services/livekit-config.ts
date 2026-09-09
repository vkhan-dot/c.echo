export function getLiveKitApiUrl(): string {
  const url = process.env.LIVEKIT_URL || process.env.PUBLIC_LIVEKIT_URL || ''
  return url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
}

const toWebSocketUrl = (url: string): string =>
  url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')

export function getPublicLiveKitUrl(): string {
  if (process.env.PUBLIC_LIVEKIT_URL) {
    return process.env.PUBLIC_LIVEKIT_URL
  }

  const livekitUrl = process.env.LIVEKIT_URL || ''
  if (
    livekitUrl &&
    !livekitUrl.includes('localhost') &&
    !livekitUrl.includes('127.0.0.1') &&
    !livekitUrl.includes('.internal') &&
    (livekitUrl.startsWith('wss://') || livekitUrl.startsWith('ws://'))
  ) {
    return livekitUrl
  }

  const frontendUrl = process.env.FRONTEND_URL || ''
  if (frontendUrl && !frontendUrl.includes('localhost') && !frontendUrl.includes('127.0.0.1')) {
    try {
      const url = new URL(frontendUrl)
      return `wss://livekit.${url.hostname}`
    } catch {
      // ignore
    }
  }

  return livekitUrl ? toWebSocketUrl(livekitUrl) : 'ws://localhost:7880'
}

export function getLiveKitCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET

  if (!apiKey || !apiSecret) {
    throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET environment variables are required.')
  }

  return { apiKey, apiSecret }
}
