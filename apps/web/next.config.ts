import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' }, // Google avatars
    ],
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
    NEXT_PUBLIC_LIVEKIT_URL: process.env.NEXT_PUBLIC_LIVEKIT_URL ?? 'ws://localhost:7880',
  },
}

export default nextConfig
