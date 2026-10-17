import { defineConfig, parseSync } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

const modulePath = relative => fileURLToPath(new URL(relative, import.meta.url)).replaceAll('\\', '/');

export function developmentWatchIgnored(root = modulePath('./')) {
  const base = String(root).replaceAll('\\', '/').replace(/\/$/, '');
  // Windows directory watchers can prevent the atomic staging rename used by
  // local package installs. Ignore only this project's generated directories.
  return ['output', 'artifact', 'release', 'releases', 'release-check', 'coverage',
    'test-results', 'playwright-report', '.playwright-cli', 'dist'].map(name => `${base}/${name}/**`);
}

function sharedRuntimeWorkers() {
  const entries = new Map([
    [modulePath('./src/app/world-validation-work.js'), {
      expression: "new URL('./world-validation-worker.js', import.meta.url)",
      id: modulePath('./src/app/world-validation-worker.js'), name: 'world-validation-worker',
    }],
    [modulePath('./src/vision/background.js'), {
      expression: "new URL('./worker.js', import.meta.url)",
      id: modulePath('./src/vision/worker.js'), name: 'worker',
    }],
  ]);
  const workerEntries = new Set([...entries.values()].map(entry => entry.id));
  const workerDependencies = new Set(), bootDependencies = new Set();
  return {
    workerEntries, workerDependencies, bootDependencies,
    plugin: {
      name: 'shared-runtime-workers',
      apply: 'build',
      enforce: 'pre',
      transform(code, id) {
        const entry = entries.get(id.replaceAll('\\', '/'));
        if (!entry) return;
        if (!code.includes(entry.expression)) throw new Error(`Missing Worker URL in ${id}`);
        // Emit module Workers in the application graph. Each Worker still has
        // its own realm; only the downloaded pure module files are shared.
        const reference = this.emitFile({ type: 'chunk', id: entry.id, name: entry.name });
        return { code: code.replace(entry.expression, `import.meta.ROLLUP_FILE_URL_${reference}`), map: null };
      },
      buildEnd(error) {
        if (error) return;
        const visit = (id, collection) => {
          if (collection.has(id)) return;
          collection.add(id);
          for (const dependency of this.getModuleInfo(id)?.importedIds || []) visit(dependency, collection);
        };
        visit(modulePath('./src/hosted-main.js'), bootDependencies);
        bootDependencies.delete(modulePath('./src/hosted-main.js'));
        for (const entry of workerEntries) visit(entry, workerDependencies);
        for (const entry of workerEntries) workerDependencies.delete(entry);
        for (const dependency of bootDependencies) workerDependencies.delete(dependency);
        for (const dependency of workerDependencies) {
          if (/\.css$|\/node_modules\/leaflet\//.test(dependency)) {
            throw new Error(`Worker computation must not import browser presentation: ${dependency}`);
          }
        }
      },
    },
  };
}

const runtimeWorkers = sharedRuntimeWorkers();

export function stripUnusedLeafletRasterCss({ sourceDirectory = modulePath('./src') } = {}) {
  let unused = [];
  const optionalControls = [
    { selector: /\.leaflet-popup(?:\b|-)/, used: /\.(?:bindPopup|openPopup|togglePopup|setPopupContent)\s*\(|\b(?:L\.)?(?:popup\s*\(|Popup\b)/ },
    { selector: /\.leaflet-control-layers(?:\b|-)/, used: /\bcontrol\.layers\s*\(|\bControl\.Layers\b/ },
    { selector: /\.leaflet-control-scale(?:\b|-)/, used: /\bcontrol\.scale\s*\(|\bControl\.Scale\b/ },
    { selector: /\.leaflet-control-attribution(?:\b|-)/, used: /\battributionControl\s*:\s*true\b|\bcontrol\.attribution\s*\(|\bControl\.Attribution\b/ },
  ];
  const applicationSource = directory => readdirSync(directory, { withFileTypes: true }).map(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? applicationSource(file) : entry.name.endsWith('.js') ? readFileSync(file, 'utf8') : '';
  }).join('\n');
  function hasDefaultMarker(source) {
    // Keep the upstream default icon heuristic when a future marker does not
    // provide its own icon. Current RPGmap markers all use application icons.
    let used = false;
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (['CallExpression', 'NewExpression'].includes(node.type)
        && node.callee?.type === 'MemberExpression'
        && ['L', 'leaflet'].includes(node.callee.object?.name)
        && ['marker', 'Marker'].includes(node.callee.property?.name)) {
        const options = node.arguments[1];
        if (options?.type !== 'ObjectExpression' || !options.properties.some(property => property.key?.name === 'icon')) used = true;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    // Independent modules cannot be concatenated into one valid program.
    // The scanner reads each module separately below.
    visit(parseSync('application.js', source).program);
    return used;
  }
  const hasDefaultMarkerIn = directory => readdirSync(directory, { withFileTypes: true }).some(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? hasDefaultMarkerIn(file) : entry.name.endsWith('.js') && hasDefaultMarker(readFileSync(file, 'utf8'));
  });
  return {
    name: 'strip-unused-leaflet-raster-css',
    apply: 'build',
    enforce: 'post',
    buildStart() {
      const source = applicationSource(sourceDirectory);
      unused = optionalControls.filter(control => !control.used.test(source));
      if (!hasDefaultMarkerIn(sourceDirectory)) unused.push({ selector: /\.leaflet-default-icon-path\b/ });
    },
    transform: {
      order: 'pre',
      handler(code, id) {
        if (!/\/node_modules\/leaflet\/dist\/leaflet\.css$/.test(id.replaceAll('\\', '/'))) return;
        // Work before CSS minification/hashing, so enabling a control also
        // changes the asset URL and cannot reuse an obsolete browser cache.
        return { code: code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^{}]+)\{([^{}]*)\}/g, (rule, selector, declarations) => {
          const retained = selector.split(',').filter(value => !unused.some(control => control.selector.test(value)));
          // Shared rules retain their Tooltip/base selectors. This only
          // removes controls that the application does not instantiate.
          return retained.length ? `${retained.join(',')}{${declarations}}` : '';
        }), map: null };
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  base: './',
  server: { watch: { ignored: developmentWatchIgnored() } },
  resolve: {
    alias: [
      { find: /^leaflet$/, replacement: modulePath(command === 'build'
        ? './src/adapters/leaflet-hosted-browser.js' : './src/adapters/leaflet-browser.js') },
      { find: /^polygon-clipping$/, replacement: modulePath('./node_modules/polygon-clipping/dist/polygon-clipping.esm.js') },
    ],
  },
  plugins: [runtimeWorkers.plugin, stripUnusedLeafletRasterCss()],
  worker: {
    format: 'es',
    rollupOptions: { treeshake: { moduleSideEffects: false } },
  },
  build: {
    manifest: true,
    target: 'esnext',
    modulePreload: false,
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      treeshake: {
        moduleSideEffects(id) {
          const moduleId = id.replaceAll('\\', '/');
          return moduleId.endsWith('.css') || moduleId.includes('/node_modules/leaflet/')
            || /\/src\/adapters\/leaflet-(?:hosted-browser|svg-renderer)\.js$/.test(moduleId);
        },
      },
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        codeSplitting: {
          groups: [
            {
              name: 'runtime-contracts',
              test: id => runtimeWorkers.bootDependencies.has(id.replaceAll('\\', '/')),
              includeDependenciesRecursively: false,
            },
            {
              name: 'worker-runtime-core',
              test: id => runtimeWorkers.workerDependencies.has(id.replaceAll('\\', '/')),
              includeDependenciesRecursively: false,
            },
            {
              name: 'desktop-setup',
              test: /[\\/]src[\\/]app[\\/]desktop-setup\.(?:js|css)$/,
              includeDependenciesRecursively: false,
            },
            {
              name: 'ui-icons',
              test: /[\\/]node_modules[\\/]lucide[\\/]|[\\/]src[\\/]ui[\\/]icons\.js$/,
              includeDependenciesRecursively: false,
            },
            {
              name: 'lazy-runtime-tools',
              test: /[\\/]src[\\/](?:ui[\\/]lazy-runtime-tools|library[\\/]ui|journal[\\/](?:ui|markdown)|content[\\/]archive|entities[\\/](?:xlsx-importer|avatar|actor-operations|canonical-delete|token-controller|sheet-manager|sheet-renderer|sheet-policy|ui-live)|entities[\\/]sheet[\\/].+|token[\\/](?:placement|naming)|status[\\/](?:definition-editor|quick-hud))\.js$/,
              includeDependenciesRecursively: false,
            },
            {
              name: 'map-runtime-core',
              test(id) {
                const moduleId = id.replaceAll('\\', '/');
                if (runtimeWorkers.workerEntries.has(moduleId)
                  || runtimeWorkers.workerDependencies.has(moduleId)
                  || runtimeWorkers.bootDependencies.has(moduleId)) return false;
                if (/\/node_modules\/lucide\//.test(moduleId) || /\/src\/ui\/icons\.js$/.test(moduleId)) return false;
                if (/\/node_modules\/(?:leaflet|polygon-clipping)\//.test(moduleId)) return true;
                if (!moduleId.includes('/src/')) return false;
                if (/\/src\/adapters\/installed-packages\.js$/.test(moduleId) || /\/src\/app\/desktop-setup\.(?:js|css)$/.test(moduleId)) return false;
                if (/\/src\/(?:ui\/lazy-runtime-tools|library\/ui|journal\/(?:ui|markdown)|map-package\/default-map|multiplayer\/server-bootstrap|world\/(?:bootstrap|constants|package-upgrades))\.js$/.test(moduleId)) return false;
                if (/\/src\/entities\/(?:xlsx-importer|avatar|actor-operations|canonical-delete|token-controller|sheet-manager|sheet-renderer|sheet-policy|ui-live)\.js$/.test(moduleId)
                  || /\/src\/entities\/sheet\//.test(moduleId)
                  || /\/src\/token\/(?:placement|naming)\.js$/.test(moduleId)
                  || /\/src\/status\/(?:definition-editor|quick-hud)\.js$/.test(moduleId)) return false;
                // Registry validation also runs on the management page. Keeping its pure
                // helpers outside this lazy group avoids a static edge into the game runtime.
                return !/\/src\/(?:main|hosted-main|app\/storage-adapter|ruleset\/metadata|world\/(?:manager|setup)|vision\/occlusion-model|map-package\/(?:constants|contract|registry|builtins|ruins-assets))\.js$/.test(moduleId);
              },
              includeDependenciesRecursively: false,
            },
          ],
        }
      }
    }
  }
}));
