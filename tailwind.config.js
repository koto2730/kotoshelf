/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx,js,jsx}",
  ],
  // Follow the OS preference for dark mode. Custom theme JSON files load
  // via a separate mechanism (planned) so this only handles the
  // built-in light/dark pair.
  darkMode: "media",
  theme: {
    extend: {},
  },
  plugins: [],
}
