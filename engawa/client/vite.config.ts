import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const SERVER_HOST = process.env.SERVER_HOST ?? 'server';
const SERVER_PORT = process.env.SERVER_PORT ?? '3000';
const target = `http://${SERVER_HOST}:${SERVER_PORT}`;

export default defineConfig({
  // simple-peer pulls in readable-stream which needs Node's events/util/stream/buffer.
  // Without these polyfills the Peer constructor throws "Cannot read properties of undefined".
  plugins: [
    nodePolyfills({
      include: ['events', 'util', 'stream', 'buffer'],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Served behind Caddy at https://engawa.localhost — allow that Host and
    // point the HMR websocket at Caddy's TLS port so HMR works over wss.
    allowedHosts: ['engawa.localhost'],
    hmr: { clientPort: 443 },
    proxy: {
      '/api': { target, changeOrigin: true },
      // http-proxy needs http(s) target even for ws upgrades; ws://… target
      // makes vite 5 swallow the 101 response.
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
