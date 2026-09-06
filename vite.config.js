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
    manifest: true,
    target: 'esnext',
    modulePreload: { polyfill: false },
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      treeshake: {
        moduleSideEffects(id) {
          const moduleId = id.replaceAll('\\', '/');
          return moduleId.endsWith('.css') || moduleId.includes('/node_modules/leaflet/');
        },
      },
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        codeSplitting: {
          groups: [
            {
              name: 'lazy-runtime-tools',
              test: /[\\/]src[\\/](?:ui[\\/]lazy-runtime-tools|library[\\/]ui|journal[\\/](?:ui|markdown)|content[\\/]archive|entities[\\/](?:xlsx-importer|avatar|actor-operations|canonical-delete|token-controller|sheet-manager|sheet-renderer|sheet-policy|ui-live)|entities[\\/]sheet[\\/].+|token[\\/](?:placement|naming)|status[\\/](?:definition-editor|quick-hud))\.js$/,
              includeDependenciesRecursively: false,
            },
            {
              name: 'world-bootstrap',
              test: /[\\/]src[\\/]world[\\/](?:bootstrap|constants|package-upgrades)\.js$/,
              includeDependenciesRecursively: false,
            },
            {
              name: 'map-runtime-core',
              test(id) {
                const moduleId = id.replaceAll('\\', '/');
                if (/\/node_modules\/(?:leaflet|lucide|polygon-clipping)\//.test(moduleId)) return true;
                if (!moduleId.includes('/src/')) return false;
                if (/\/src\/(?:ui\/lazy-runtime-tools|library\/ui|journal\/(?:ui|markdown)|app\/world-upgrade|map-package\/default-map|multiplayer\/server-bootstrap|world\/(?:bootstrap|constants|package-upgrades))\.js$/.test(moduleId)) return false;
                if (/\/src\/entities\/(?:xlsx-importer|avatar|actor-operations|canonical-delete|token-controller|sheet-manager|sheet-renderer|sheet-policy|ui-live)\.js$/.test(moduleId)
                  || /\/src\/entities\/sheet\//.test(moduleId)
                  || /\/src\/token\/(?:placement|naming)\.js$/.test(moduleId)
                  || /\/src\/status\/(?:definition-editor|quick-hud)\.js$/.test(moduleId)) return false;
                return !/\/src\/(?:main|app\/storage-adapter|ruleset\/metadata|world\/(?:manager|setup)|map-package\/(?:constants|contract|registry|builtins))\.js$/.test(moduleId);
              },
              includeDependenciesRecursively: false,
            },
          ],
        }
      }
    }
  }
});
