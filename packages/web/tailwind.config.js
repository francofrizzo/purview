/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // One radius scale for the whole app: `rounded` on controls (buttons,
    // chips, inputs), `md` on cards and popovers, `lg` on modals/drawers.
    borderRadius: {
      none: "0",
      sm: "4px",
      DEFAULT: "6px",
      md: "8px",
      lg: "10px",
      full: "9999px",
    },
    extend: {
      fontFamily: {
        // The full stacks live in the --font-* custom properties, which the
        // settings store rewrites at runtime (see src/lib/settings.tsx).
        mono: ["var(--font-code)"],
        sans: ["var(--font-ui)"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
    },
  },
  plugins: [],
};
