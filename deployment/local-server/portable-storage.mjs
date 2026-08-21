import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function mergeDirIfPresent(from, to) {
  if (!(await exists(from))) return false;
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true, errorOnExist: false, force: false });
  return true;
}

export function createPortableStorage({ root, worldId = 'default', env = process.env } = {}) {
  const runtimeRoot = path.resolve(root || '.');
  const packageRoot = path.resolve(env.RPGMAP_PACKAGE_ROOT || runtimeRoot);
  const appDir = path.resolve(env.RPGMAP_PUBLIC_DIR || path.join(packageRoot, 'app'));
  const worldDir = path.resolve(env.RPGMAP_WORLD_DIR || env.RPGMAP_MAP_DIR || path.join(packageRoot, 'world'));
  const mapsDir = path.resolve(env.RPGMAP_MAPS_DIR || path.join(packageRoot, 'maps'));
  const legacyPortableMapDir = path.resolve(env.RPGMAP_LEGACY_MAP_DIR || path.join(packageRoot, 'map'));
  const legacyDataDir = path.resolve(env.RPGMAP_LEGACY_DATA_DIR || env.RPGMAP_DATA_DIR || path.join(packageRoot, 'data'));
  const safeWorldId = String(worldId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  const legacyWorldDir = path.join(legacyDataDir, 'worlds', safeWorldId);

  return {
    packageRoot,
    appDir,
    worldDir,
    mapsDir,
    // Compatibility alias for V1.4.1 callers. New code should use worldDir.
    mapDir: worldDir,
    worldFile: path.join(worldDir, 'state.json'),
    usersFile: path.join(worldDir, 'users.json'),
    uploadsDir: path.join(worldDir, 'uploads'),
    backupsDir: path.join(worldDir, 'backups'),
    legacyPortableMapDir,
    legacyPortableWorldFile: path.join(legacyPortableMapDir, 'world.json'),
    legacyPortableUsersFile: path.join(legacyPortableMapDir, 'users.json'),
    legacyPortableUploadsDir: path.join(legacyPortableMapDir, 'uploads'),
    legacyPortableBackupsDir: path.join(legacyPortableMapDir, 'backups'),
    legacyDataDir,
    legacyWorldFile: path.join(legacyWorldDir, 'world.json'),
    legacyUsersFile: path.join(legacyWorldDir, 'access.json'),
    legacyUploadsDir: path.join(legacyDataDir, 'uploads'),
    legacyBackupsDir: path.join(legacyDataDir, 'backups'),
  };
}

export async function ensurePortableStorage(layout) {
  await Promise.all([
    mkdir(layout.worldDir, { recursive: true }),
    mkdir(layout.mapsDir, { recursive: true }),
    mkdir(layout.uploadsDir, { recursive: true }),
    mkdir(layout.backupsDir, { recursive: true }),
  ]);
}

export async function migrateLegacyStorage(layout) {
  await ensurePortableStorage(layout);
  const migrated = [];

  if (!(await exists(layout.worldFile))) {
    if (await exists(layout.legacyPortableWorldFile)) {
      await copyFile(layout.legacyPortableWorldFile, layout.worldFile);
      migrated.push({ from: layout.legacyPortableWorldFile, to: layout.worldFile, type: 'world-v1.4.1' });
    } else if (await exists(layout.legacyWorldFile)) {
      await copyFile(layout.legacyWorldFile, layout.worldFile);
      migrated.push({ from: layout.legacyWorldFile, to: layout.worldFile, type: 'world-legacy-data' });
    }
  }

  if (!(await exists(layout.usersFile))) {
    if (await exists(layout.legacyPortableUsersFile)) {
      await copyFile(layout.legacyPortableUsersFile, layout.usersFile);
      migrated.push({ from: layout.legacyPortableUsersFile, to: layout.usersFile, type: 'users-v1.4.1' });
    } else if (await exists(layout.legacyUsersFile)) {
      await copyFile(layout.legacyUsersFile, layout.usersFile);
      migrated.push({ from: layout.legacyUsersFile, to: layout.usersFile, type: 'users-legacy-data' });
    }
  }

  if (await mergeDirIfPresent(layout.legacyPortableUploadsDir, layout.uploadsDir)) {
    migrated.push({ from: layout.legacyPortableUploadsDir, to: layout.uploadsDir, type: 'uploads-v1.4.1' });
  } else if (await mergeDirIfPresent(layout.legacyUploadsDir, layout.uploadsDir)) {
    migrated.push({ from: layout.legacyUploadsDir, to: layout.uploadsDir, type: 'uploads-legacy-data' });
  }

  if (await mergeDirIfPresent(layout.legacyPortableBackupsDir, layout.backupsDir)) {
    migrated.push({ from: layout.legacyPortableBackupsDir, to: layout.backupsDir, type: 'backups-v1.4.1' });
  } else if (await mergeDirIfPresent(layout.legacyBackupsDir, layout.backupsDir)) {
    migrated.push({ from: layout.legacyBackupsDir, to: layout.backupsDir, type: 'backups-legacy-data' });
  }

  return migrated;
}
