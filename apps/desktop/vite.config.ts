import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri's own recommended Vite settings: a fixed dev port (so src-tauri's
// `devUrl` can point at it reliably), screen-clearing disabled (it would hide
// Rust compiler errors), and src-tauri excluded from the watcher (its own
// `cargo watch` rebuild would otherwise double-trigger).
const tauriDevHost = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: tauriDevHost || false,
    hmr: tauriDevHost ? { protocol: "ws", host: tauriDevHost, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rollupOptions: {
      // Two separate HTML entry points, one per window (see src-tauri's
      // tauri.conf.json) — a real multi-page build, not one SPA deciding at
      // runtime which window it is, so a bug in one module's bundle can't
      // reach the other's.
      input: {
        pos: resolve(import.meta.dirname, "pos.html"),
        kitchen: resolve(import.meta.dirname, "kitchen.html"),
      },
    },
  },
});
