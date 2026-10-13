import { inspectMapArchive } from '../../src/packages/map-archive.js';
import { inspectRulesetArchive } from './ruleset-store.mjs';

// Inspection validates static contents only. A ruleset entry must not execute
// until the user accepts the installation of its trusted contract package.
export function inspectContentPackage(kind, bytes) {
  const inspected = kind === 'map' ? inspectMapArchive(bytes) : inspectRulesetArchive(bytes);
  const { manifest, files, fingerprint } = inspected;
  return {
    kind, title: String(manifest.title || manifest.name || manifest.id).slice(0, 200),
    id: manifest.id, version: manifest.version, format: manifest.format,
    compatibility: { formatVersion: manifest.formatVersion,
      ...(kind === 'map' ? { mapPackageApiVersion: manifest.mapPackageApiVersion } : { rulesetApiVersion: manifest.apiVersion }),
      ...(manifest.compatibility === undefined ? {} : { authorDeclaration: manifest.compatibility }),
    },
    filesCount: files.size, archiveBytes: bytes.length, fingerprint,
  };
}
