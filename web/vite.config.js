import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = "http://127.0.0.1:" + (process.env.PORT || 4500);

export default defineConfig({
  root,
  server: { port: 4501, proxy: { "/api": { target: api, changeOrigin: true } } },
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [react()],
});
