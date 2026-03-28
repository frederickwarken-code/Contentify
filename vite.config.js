import { defineConfig } from 'vite';

// GitHub Pages Projekt-URL: /Contentify/
export default defineConfig({
  base: '/Contentify/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
