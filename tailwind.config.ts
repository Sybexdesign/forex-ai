import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'forex-bg':     '#040810',
        'forex-panel':  '#0a1628',
        'forex-border': '#1a2940',
        'forex-green':  '#00ff87',
        'forex-red':    '#ff3056',
        'forex-amber':  '#ffb800',
        'forex-blue':   '#0080ff',
      },
      fontFamily: {
        mono:  ['JetBrains Mono', 'monospace'],
        rajdhani: ['Rajdhani', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
export default config
