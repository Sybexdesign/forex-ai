import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Allow server-side imports that use technicalindicators (Node.js only)
  serverExternalPackages: ['technicalindicators'],

  // Security headers for trading terminal
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
