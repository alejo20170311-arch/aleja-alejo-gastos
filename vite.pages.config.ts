import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_PAGES_BASE ?? "./",
  plugins: [react()],
  build: {
    outDir: "gh-pages-dist",
  },
});
