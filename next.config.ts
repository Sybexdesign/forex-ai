import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Allow server-side imports that use technicalindicators (Node.js only)
  serverExternalPackages: ['technicalindicators'],

  // The EA source was renamed to v9.3.1 so that the DOWNLOADED FILE — not just a
  // label next to it — identifies the build. The old URL is kept working for
  // bookmarks and in-flight installs and simply serves the same v9.3.1 content.
  //
  // 307 rather than 308: a permanent redirect would be cached in browsers
  // indefinitely, which would be awkward to undo if the name ever changes again.
  // The cost of a temporary redirect here is one extra round-trip on download.
  async redirects() {
    return [
      {
        source:      '/SybexForexAI_EA_v9.3.mq5',
        destination: '/SybexForexAI_EA_v9.3.1.mq5',
        permanent:   false,
      },
    ]
  },

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
