import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

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
  plugins: [stripUnusedLeafletRasterCss(), viteSingleFile()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000
  }
});
