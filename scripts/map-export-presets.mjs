export const LANZHOU_EXPORT_PRESETS = Object.freeze({
  '1.1.0': Object.freeze({
    version: '1.1.0', published: true, snapshot: '1.1.0',
    fingerprint: '9a8de38844f6b6f5e528d507bf38bd134045d27f24c948f1e82ad1c0ea87c947',
  }),
  '1.1.1': Object.freeze({
    version: '1.1.1', published: false, snapshot: '1.1.1',
    fingerprint: '053bfb332654867f7134565d06ae8035b4397b34e2caa14c78a4eebe23063795',
  }),
  '1.1.2': Object.freeze({
    version: '1.1.2', published: false, snapshot: null,
    fingerprint: '9679e39503f2ae13ba27e726ef10b1d45db860eb545929829cb2586841f87610',
  }),
});

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function resolveLanzhouExportPreset(version = '1.1.0') {
  if (!Object.hasOwn(LANZHOU_EXPORT_PRESETS, version)) fail('map_export_version_unknown', `Unsupported Lanzhou export version: ${version}`);
  return LANZHOU_EXPORT_PRESETS[version];
}

export function verifyLanzhouExportReceipt(inspected, preset) {
  if (inspected.manifest.id !== 'northern-song-lanzhou-1104' || inspected.manifest.version !== preset.version) {
    fail('map_export_identity_mismatch', 'The map content does not match the selected export version');
  }
  if (inspected.fingerprint !== preset.fingerprint) {
    fail(preset.published ? 'map_release_fingerprint_mismatch' : 'map_candidate_fingerprint_mismatch',
      `Lanzhou ${preset.version} content differs from its frozen receipt (${inspected.fingerprint}); refusing to redefine this version`);
  }
  return inspected;
}
