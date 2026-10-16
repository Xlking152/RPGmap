'use strict';

const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');

function resolveDesktopPaths({ packaged, resourcesPath, projectRoot, env = process.env, electronUserData }) {
  const runtimeRoot = packaged ? resourcesPath : path.join(projectRoot, 'artifact', 'desktop-stage', 'resources');
  const localRoot = env.LOCALAPPDATA || path.dirname(electronUserData || path.join(env.USERPROFILE || projectRoot, 'AppData', 'Roaming', 'RPGmap'));
  const dataRoot = path.resolve(env.RPGMAP_DATA_DIR || path.join(localRoot, 'RPGmap', 'UserData'));
  const resolvedRuntime = path.resolve(runtimeRoot);
  const programRoot = packaged ? path.dirname(resolvedRuntime) : resolvedRuntime;
  if (dataRoot === programRoot || dataRoot.startsWith(`${programRoot}${path.sep}`)) {
    throw new Error('用户数据目录不能位于程序资源目录中。');
  }
  return {
    runtimeRoot: resolvedRuntime,
    serverDir: path.join(resolvedRuntime, 'server'),
    serverEntry: path.join(resolvedRuntime, 'server', 'server.mjs'),
    staticDir: path.join(resolvedRuntime, 'app'),
    dataRoot,
    logsDir: path.join(dataRoot, 'logs'),
    configurationDir: path.join(dataRoot, 'config'),
  };
}

function isLocalApplicationUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function redactLogLine(line, secrets = []) {
  let result = String(line);
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/(GMSecret\s*:\s*|JoinCode\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
}

async function verifyInstalledPayload({ manifestPath, runtimeRoot, applicationRoot, version }) {
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== 1 || manifest.appId !== 'org.rpgmap.desktop' || manifest.version !== version || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('程序安装清单无效或版本不匹配，请重新运行相同版本的安装器。');
  }
  for (const [relative, record] of Object.entries(manifest.files)) {
    let target;
    let boundary;
    if (relative.startsWith('resources/')) { boundary = path.resolve(runtimeRoot); target = path.resolve(boundary, relative.slice('resources/'.length)); }
    else if (relative.startsWith('application/')) { boundary = path.resolve(applicationRoot); target = path.resolve(boundary, relative.slice('application/'.length)); }
    else throw new Error('程序安装清单包含未知文件范围。');
    if (!target.startsWith(`${boundary}${path.sep}`)) throw new Error('程序安装清单包含越界文件。');
    const bytes = await readFile(target);
    if (record.bytes !== bytes.length || !/^[a-f0-9]{64}$/.test(record.sha256 || '') || createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
      throw new Error(`程序文件校验失败：${relative}。用户数据已保留，请重新安装或使用旧程序恢复副本。`);
    }
  }
  return { version: manifest.version, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), files: Object.keys(manifest.files).length };
}

async function stopUtilityProcess(child, { timeoutMs = 15000, onTimeout = () => {} } = {}) {
  if (!child || child.pid === undefined) return { stopped: true, forced: false };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve({ stopped: true, forced: false });
    };
    const onExit = code => finish(code === 0 ? null : new Error(`本地服务未正常退出（退出码 ${code}），已停止升级或重启。请查看运行日志。`));
    const timer = setTimeout(() => {
      onTimeout();
      finish(new Error('本地服务尚未完成保存，已停止退出、升级或重启。请稍候重试，并检查运行日志。'));
    }, timeoutMs);
    child.once('exit', onExit);
    try { child.postMessage({ type: 'rpgmap:shutdown' }); }
    catch (error) { finish(new Error(`无法请求本地服务正常停服，已停止升级或重启：${error.message}`)); }
  });
}

module.exports = { resolveDesktopPaths, isLocalApplicationUrl, redactLogLine, stopUtilityProcess, verifyInstalledPayload };
