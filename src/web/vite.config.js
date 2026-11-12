import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const pages = ['index', 'welcome', 'login', 'interview', 'history', 'organizing', 'biography', 'chapter', 'story', 'profile', 'profile-edit', 'preview', 'photo', 'text-chat', 'realtime-interview', 'interview-history'];

export default defineConfig(({ mode }) => {
  const usePrototype = mode === 'manji' || mode === 'html-static';
  return {
    root,
    base: mode === 'html-static' ? '/html/' : mode === 'manji' ? '/web/' : '/web2/',
    define: usePrototype ? { 'import.meta.env.VITE_STATIC_PREVIEW': JSON.stringify(mode === 'html-static' ? 'true' : 'false') } : {},
    plugins: [vue(), ...(usePrototype ? [{
      name: 'static-html-entry',
      transformIndexHtml: {
        order: 'pre',
        handler: html => html.replace('./src/main.js', mode === 'manji' ? './src/connected-main.js' : './src/static-main.js'),
      },
    }] : [])],
    server: { proxy: { '/api': process.env.MANJI_API_PROXY_TARGET || 'http://127.0.0.1:8003' } },
    build: {
      outDir: mode === 'html-static' ? 'dist-html' : 'dist',
      emptyOutDir: mode !== 'watch',
      rolldownOptions: { input: pages.map(page => fileURLToPath(new URL(`./${page}.html`, import.meta.url))) },
    },
    test: {
      environment: 'jsdom',
      environmentOptions: { jsdom: { url: 'http://localhost/web2/index.html' } },
      setupFiles: ['./tests/setup.js'],
      include: ['tests/**/*.test.js'],
      restoreMocks: true,
      clearMocks: true,
    },
  };
});
