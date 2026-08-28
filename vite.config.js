import { defineConfig } from 'vite';

function stripUnusedLeafletRasterCss() {
  return {
    name: 'strip-unused-leaflet-raster-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      Object.values(bundle).forEach(asset => {
        if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) return;
        asset.source = String(asset.source).replace(/url\(data:image\/png;base64,[^)]+\)/g, 'none');
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [stripUnusedLeafletRasterCss()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        manualChunks(id) {
          const moduleId = id.replaceAll('\\', '/');
          if (moduleId.includes('/node_modules/leaflet/')) return 'vendor-leaflet';
          if (moduleId.includes('/node_modules/lucide/')) return 'vendor-icons';
          if (moduleId.includes('/node_modules/polygon-clipping/')) return 'vendor-geometry';
          return undefined;
        }
      }
    }
  }
});
