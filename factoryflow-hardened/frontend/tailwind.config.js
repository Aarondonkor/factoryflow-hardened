/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#edf7f3',
          100: '#d4ede4',
          200: '#a8dac9',
          300: '#6fbfaa',
          400: '#3d9f87',
          500: '#1f8268',
          600: '#156853',
          700: '#115344',
          800: '#0e4237',
          900: '#0c362d',
          950: '#061f1a',
        },
        accent: {
          400: '#e8c468',
          500: '#d4a853',
          600: '#b8892e',
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(6, 31, 26, 0.06), 0 8px 24px rgba(6, 31, 26, 0.06)',
        elevated: '0 4px 6px rgba(6, 31, 26, 0.04), 0 20px 40px rgba(6, 31, 26, 0.08)',
      },
    },
  },
  plugins: [],
}
