import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { compression } from "vite-plugin-compression2";

// P2-44: pre-compresses the build output (.js/.css/.html/.svg/.json) into
// .gz and .br sibling files at build time, not on every request — there's
// no Dockerfile/nginx/Caddy config anywhere in this repo yet to actually
// pick the right one by Accept-Encoding and serve it (a documented gap,
// not silently assumed solved), and Cloudflare itself compresses at the
// edge regardless of origin behavior once this is actually deployed behind
// it. This just has both variants ready for whichever serving layer gets
// built, rather than requiring it to compress on the fly.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    compression({ algorithms: ["gzip"] }),
    compression({ algorithms: ["brotliCompress"] }),
  ],
  server: {
    port: 5173,
  },
});
