import tailwindcss from '@tailwindcss/vite';
import { ConfigManager } from '@isles/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const config = new ConfigManager().current;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: config.host,
    port: config.webPort,
    strictPort: true,
    proxy: { '/api': `http://${config.host}:${config.port}` },
  },
});
