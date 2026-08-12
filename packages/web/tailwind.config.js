/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
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
