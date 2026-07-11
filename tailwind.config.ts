import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"]
      },
      colors: {
        cyanGlow: "#22d3ee",
        ink: "#0a0a0f"
      },
      boxShadow: {
        glass: "0 20px 80px rgba(0, 0, 0, 0.32)",
        cyan: "0 0 24px rgba(34, 211, 238, 0.15)"
      }
    }
  },
  plugins: []
};

export default config;
