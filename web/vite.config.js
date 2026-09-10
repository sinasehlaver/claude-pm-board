import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = "http://127.0.0.1:" + (process.env.PORT || 4500);

export default defineConfig({
  root,
  server: { port: 4501, proxy: { "/api": { target: api, changeOrigin: true } } },
  build: { outDir: "dist", emptyOutDir: true },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        navigateFallback: "/index.html",
        runtimeCaching: [
          { urlPattern: /\/api\//, handler: "NetworkFirst", options: { cacheName: "api" } },
        ],
      },
      manifest: {
        name: "PM Board",
        short_name: "PM",
        display: "standalone",
        background_color: "#0b0b0c",
        theme_color: "#0b0b0c",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
    }),
  ],
});
