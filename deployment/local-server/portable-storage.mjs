import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createPortableStorage({ root, worldId = 'default', env = process.env } = {}) {
  const runtimeRoot = path.resolve(root || '.');
  const packageRoot = path.resolve(env.RPGMAP_PACKAGE_ROOT || runtimeRoot);
  const appDir = path.resolve(env.RPGMAP_PUBLIC_DIR || path.join(packageRoot, 'app'));
  const mapDir = path.resolve(env.RPGMAP_MAP_DIR || path.join(packageRoot, 'map'));
  const legacyDataDir = path.resolve(env.RPGMAP_LEGACY_DATA_DIR || env.RPGMAP_DATA_DIR || path.join(packageRoot, 'data'));
  const safeWorldId = String(worldId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  const legacyWorldDir = path.join(legacyDataDir, 'worlds', safeWorldId);

  return {
    packageRoot,
    appDir,
    mapDir,
    worldFile: path.join(mapDir, 'world.json'),
    operationsFile: path.join(mapDir, 'world.operations.ndjson'),
    usersFile: path.join(mapDir, 'users.json'),
    uploadsDir: path.join(mapDir, 'uploads'),
    backupsDir: path.join(mapDir, 'backups'),
    legacyDataDir,
    legacyWorldFile: path.join(legacyWorldDir, 'world.json'),
    legacyUsersFile: path.join(legacyWorldDir, 'access.json'),
  };
}

export async function ensurePortableStorage(layout) {
  await Promise.all([
    mkdir(layout.mapDir, { recursive: true }),
    mkdir(layout.uploadsDir, { recursive: true }),
    mkdir(layout.backupsDir, { recursive: true }),
  ]);
}

export async function migrateLegacyStorage(layout) {
  await ensurePortableStorage(layout);
  const migrated = [];

  if (!(await exists(layout.worldFile)) && await exists(layout.legacyWorldFile)) {
    await copyFile(layout.legacyWorldFile, layout.worldFile);
    migrated.push({ from: layout.legacyWorldFile, to: layout.worldFile, type: 'world' });
  }

  if (!(await exists(layout.usersFile)) && await exists(layout.legacyUsersFile)) {
    await copyFile(layout.legacyUsersFile, layout.usersFile);
    migrated.push({ from: layout.legacyUsersFile, to: layout.usersFile, type: 'users' });
  }

  return migrated;
}
