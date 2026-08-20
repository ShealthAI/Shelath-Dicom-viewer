/** @type {import('tailwindcss').Config} */
module.exports = {
  // ONE theme, permanently. Libraries in the tree (next-themes, sonner) still
  // read prefers-color-scheme and may put a `dark` class on the document; this
  // binds the `dark:` variant to a selector nothing ever has, so those classes
  // compile to rules that can never match. Combined with deleting the `.dark`
  // palette block in tailwind.css, there is no second look to drift into.
  darkMode: ['selector', '[data-theme="never"]'],
  presets: [require('../ui/tailwind.config.js')],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  prefix: '',
  theme: {
    fontFamily: {
      inter: ['Inter', 'sans-serif'],
    },
    fontSize: {
      xxs: '0.625rem', // 10px
      xs: '0.6875rem', // 11px
      sm: '0.75rem', // 12px
      base: '0.8125rem', // 13px
      lg: '0.875rem', // 14px
      xl: '1rem', // 16px
      // 2xl and above will be updated in an upcoming version
      '2xl': '1.5rem',
      '3xl': '1.875rem',
      '4xl': '2.25rem',
      '5xl': '3rem',
      '6xl': '4rem',
      // '2xl': '1.125rem', // 18px
      // '3xl': '1.375rem', // 22px
      // '4xl': '1.5rem', // 24px
      // '5xl': '1.875rem', // 30px
    },
    fontWeight: {
      hairline: '100',
      thin: '200',
      light: '300',
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
      extrabold: '800',
      black: '900',
    },
    extend: {
      colors: {
        highlight: 'hsl(var(--highlight))',
        neutral: 'hsl(var(--neutral))',
        'neutral-light': 'hsl(var(--neutral-light))',
        'neutral-dark': 'hsl(var(--neutral-dark))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
      // Legacy OHIF colour groups. These are HARDCODED hexes that bypass the
      // CSS variables in tailwind.css, so re-theming the variables alone left
      // stock OHIF blue (#348CFD) leaking through wherever these are used.
      // Re-pointed at the Shealth palette so the viewer matches the app and the
      // super-admin exactly.
      // Legacy OHIF colour groups: HARDCODED hexes that bypass the CSS
      // variables, so re-theming the variables alone left stock OHIF navy and
      // #348CFD blue showing through. Re-pointed at the Shealth light palette.
      // Same dark palette as the @ohif/ui preset; both must agree or the chrome
      // splits between two looks depending on which package renders a component.
      bkg: {
        low: '#1E1E1E',
        med: '#242424',
        full: '#282828',
      },
      info: {
        primary: '#F0F0F0',
        secondary: '#949595',
      },
      actions: {
        primary: '#82BBE0',
        highlight: '#82BBE0',
        hover: 'rgba(130, 187, 224, 0.14)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
