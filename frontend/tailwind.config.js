/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'], num: ['"JetBrains Mono"', 'ui-monospace', 'monospace'] },
      colors: {
        ink: { DEFAULT: '#0b1526', soft: '#0f1e38', deep: '#070f20' },
        panel: '#0f1f3a',
        accent: { cyan: '#22d3ee', teal: '#2dd4bf', violet: '#a78bfa', amber: '#fbbf24' },
        teal: { DEFAULT: '#0ea5a4' },
        water: '#0e7490', warn: '#f59e0b', danger: '#ef4444',
      },
      boxShadow: {
        glow: '0 0 40px -10px rgba(14,165,164,.5)',
        card: '0 8px 32px -12px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06)',
        pop: '0 12px 48px -12px rgba(34,211,238,.35)',
      },
      keyframes: {
        'fade-up': { '0%': { opacity: 0, transform: 'translateY(10px)' }, '100%': { opacity: 1, transform: 'translateY(0)' } },
        'pulse-dot': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
        shimmer: { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } },
      },
      animation: {
        'fade-up': 'fade-up .45s cubic-bezier(.21,.9,.35,1) both',
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
