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
        bg: {
          primary:   '#0d1117',
          secondary: '#161b22',
          tertiary:  '#21262d',
        },
        border: '#30363d',
        accent: {
          blue:   '#3b82f6',
          green:  '#10b981',
          red:    '#ef4444',
          yellow: '#f59e0b',
          purple: '#8b5cf6',
        },
        text: {
          primary:   '#f0f6fc',
          secondary: '#8b949e',
          muted:     '#484f58',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
export default config
