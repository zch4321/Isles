import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.ISLES_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.ISLES_SERVER_PORT ?? 4310}` },
  },
});
