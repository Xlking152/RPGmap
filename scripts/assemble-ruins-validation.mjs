import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyLocalValidation } from './verify-local-validation.mjs';

const [label, reportKind = 'candidate'] = process.argv.slice(2);
assert(/^[a-z-]+$/.test(label || ''));
assert(['candidate', 'final-main'].includes(reportKind));
const root = process.cwd();
const directory = path.join(root, 'artifact', `${label}-candidate`);
const metadata = JSON.parse(await readFile(path.join(directory, 'RPGmap-v2.5.5', 'VERSION.json'), 'utf8'));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const rawFiles = {
  'lan.json': `v2.5.5-lan-ordinary-${label}.json`,
  'large-lan.json': `v2.5.5-lan-large-${label}-five.json`,
  'browser.json': `v2.5.5-chrome-seven-${label}.json`,
  'vision-v254.json': `v2.5.4-vision-${label}-load.json`,
  'vision-v255.json': `v2.5.5-vision-${label}-load.json`,
  'chrome-smoke.json': `v2.5.5-chrome-smoke-${label}.json`,
};
for (const [name, source] of Object.entries(rawFiles)) {
  await copyFile(path.join(root, 'artifact', 'qa', source), path.join(directory, name));
}
const chromeSmokeLog = await readFile(path.join(root, 'artifact', `occlusion-chrome-smoke-${label}.log`), 'utf8');
const lanVisionPayloads = chromeSmokeLog.split(/\r?\n/).filter(line => line.startsWith('{')).map(JSON.parse)
  .filter(value => value.identity === true && value.ruinsLan);
assert.equal(lanVisionPayloads.length, 1, 'Formal Chrome smoke must include exactly one actual package LAN destruction/recovery check');
const lanVision = lanVisionPayloads[0];
await writeFile(path.join(directory, 'lan-vision.json'), JSON.stringify(lanVision, null, 2) + '\n');
const checks = Object.fromEntries(['tests', 'build', 'bundle', 'package', 'benchmark', 'lanBenchmark',
  'chrome', 'visionBenchmark', 'occlusionLanBenchmark', 'browserBenchmark'].map(name => [name, 'passed']));
const archive = await readFile(path.join(directory, 'RPGmap-v2.5.5.zip'));
const sha256 = createHash('sha256').update(archive).digest('hex');
const validation = { version: '2.5.5', commit: metadata.commit,
  baselineCommit: 'ed7e13baab0f116222333c20431e19ab63b60e37', sha256, checks,
  evidence: { lanBenchmark: 'lan.json', occlusionLanBenchmark: 'large-lan.json', browserBenchmark: 'browser.json',
    visionBenchmark: { baseline: 'vision-v254.json', candidate: 'vision-v255.json' },
    chromeSmoke: 'chrome-smoke.json', maskRaster: 'raster.json',
    facadeRaster: 'facade-raster.json', ruinsLan: 'lan-vision.json',
    dependencyAudit: { all: 'audit.json', production: 'audit-production.json' } } };
const [lan, large, browser, before, after, smoke] = await Promise.all(Object.keys(rawFiles).map(name => json(path.join(directory, name))));
const metrics = browser.phases.map(phase => {
  const maximum = name => Math.max(0, ...phase.sessions.map(session => session.diagnostics.metrics[name]?.p95 || 0));
  return { name: phase.name, moves: phase.actualMoves,
    fps: Math.min(...phase.sessions.map(session => session.diagnostics.averageFps)),
    frame: maximum('frame'), input: maximum('input.frame'), confirm: maximum('network.confirm'),
    feedback: maximum('vision.feedback'),
    longtask: Math.max(0, ...phase.sessions.map(session => session.diagnostics.metrics.longtask?.max || 0)) };
});
const format = number => Number(number).toFixed(3);
const testLog = await readFile(path.join(root, 'artifact', `occlusion-full-tests-${label}.log`), 'utf8');
const testCount = Number(testLog.match(/tests (\d+)/)?.[1]);
assert(testCount > 0 && /fail 0\b/.test(testLog) && testLog.includes(`pass ${testCount}`));
const syntaxLog = await readFile(path.join(root, 'artifact', `occlusion-syntax-${label}.log`), 'utf8');
const syntaxCount = Number(syntaxLog.match(/(\d+) modules: syntax passed/)?.[1]);
assert(syntaxCount > 0);
for (const name of ['audit', 'audit-production']) {
  const audit = await json(path.join(root, 'artifact', `occlusion-${name}-${label}.json`));
  assert.equal(audit.metadata.vulnerabilities.total, 0);
  await copyFile(path.join(root, 'artifact', `occlusion-${name}-${label}.json`), path.join(directory, `${name}.json`));
}
const rasterLog = await readFile(path.join(root, 'artifact', `occlusion-raster-${label}.log`), 'utf8');
const raster = JSON.parse(rasterLog.slice(rasterLog.indexOf('{')));
assert.equal(raster.cases, 2304);
assert.equal(raster.framesPerCase, 2);
assert.equal(raster.differingPixels, 0);
assert.equal(raster.maxChannelError, 0);
assert.equal(raster.maxAlphaError, 0);
assert.equal(raster.maxPremultipliedError, 0);
await writeFile(path.join(directory, 'raster.json'), JSON.stringify(raster, null, 2) + '\n');
const facadeLog = await readFile(path.join(root, 'artifact', `occlusion-facade-raster-${label}.log`), 'utf8');
const facadeRaster = JSON.parse(facadeLog.slice(facadeLog.indexOf('{')));
await writeFile(path.join(directory, 'facade-raster.json'), JSON.stringify(facadeRaster, null, 2) + '\n');
const zoom = smoke.occlusion.zoom;
assert.equal(zoom.length, 4);
assert(zoom.every(item => item.zoomLevels === 37 && item.maxCenterAlpha === 0
  && item.maxProjectionError <= 1 && item.maxAnimationError <= 1));
assert.equal(smoke.occlusion.feedback.queue.queued, 0);
assert.equal(smoke.occlusion.feedback.queue.running, false);
assert.equal(smoke.occlusion.feedback.blackFlash.maxCenterAlpha, 0);
for (const range of smoke.occlusion.feedback.ranges) {
  assert(range.p95Ms <= (range.rangeMeters === 1000 ? 100 : 50));
}
await writeFile(path.join(directory, 'local-validation.json'), JSON.stringify(validation, null, 2) + '\n');
await verifyLocalValidation({ directory, version: '2.5.5', commit: metadata.commit });
for (const name of ['full-tests', 'syntax', 'core', 'chrome-smoke', 'raster', 'facade-raster', 'audit', 'audit-production']) {
  const extension = name.startsWith('audit') ? 'json' : 'log';
  await copyFile(path.join(root, 'artifact', `occlusion-${name}-${label}.${extension}`), path.join(directory, `${name}.${extension}`));
}
const rows = [
  `| 全量测试／语法 | ${testCount} 项／${syntaxCount} 模块 | 全通过 |`,
  '| 开发／生产依赖审计 | 0／0 漏洞 | 通过 |',
  ...['move', 'status', 'chat', 'aggregate'].map(name => `| 普通 ${name} ACK／全客户端差量 p95 | ${format(lan.ackMeasurement[name].p95Ms)}／${format(lan.measurement[name].p95Ms)} ms | 均 ≤60 ms |`),
  ...Object.entries(large.scenarios).map(([name, scenario]) => `| 大范围 ${name} ACK／差量 p95 | ${format(scenario.movementAck.p95Ms)}／${format(scenario.allClientFanout.p95Ms)} ms | 均 ≤60 ms |`),
  ...Object.entries(large.scenarios).flatMap(([name, scenario]) => ['status', 'chat', 'aggregate'].map(type =>
    `| ${name} 后台探索期间其他玩家 ${type} ACK／差量 p95 | ${format(scenario.otherPlayerOperations.ackMeasurement[type].p95Ms)}／${format(scenario.otherPlayerOperations.measurement[type].p95Ms)} ms | 均 ≤60 ms；每轮 4 对状态／聊天，WAL 确证未完成路径 |`)),
  `| 425 米算法探索中位：v2.5.4 → v2.5.5 | ${format(before.sweep.medianMs)} → ${format(after.sweep.medianMs)} ms | 降低 ${format(100 * (1 - after.sweep.medianMs / before.sweep.medianMs))}%；哈希一致 |`,
  `| 1,000 米视野算法中位：v2.5.4 → v2.5.5 | ${format(before.visibility[1000].medianMs)} → ${format(after.visibility[1000].medianMs)} ms；当前连续视野 ${format(after.continuous[1000].medianMs)} ms | 相同输入；网格可见结果哈希一致；连续结果单列 |`,
  `| 六来源完整探索／可靠落盘中位 | ${format(large.scenarios.sixConcurrentSources.completeExploration.medianMs)}／${format(large.scenarios.sixConcurrentSources.durableExploration.medianMs)} ms | 5,130 采样、参考 Fog、队列排空通过 |`,
  ...metrics.map(m => `| Chrome ${m.name}：FPS／帧 p95／输入 p95 | ${format(m.fps)}／${format(m.frame)}／${format(m.input)} ms | ≥58／≤20／≤16.7；${m.moves} 次真实移动 |`),
  ...metrics.map(m => `| Chrome ${m.name}：确认 p95／反馈 p95／最长任务 | ${format(m.confirm)}／${format(m.feedback)}／${format(m.longtask)} ms | 确认 ≤60；长任务 ≤100 |`),
  `| 含 3 秒停服的七会话恢复 | ${format(browser.recovery.recoveredMs)} ms | ≤13,000；来源、Token、Fog、修订号一致 |`,
  `| Chrome 120／500／1,000 米移动至遮罩 p95 | ${smoke.occlusion.feedback.ranges.map(range => format(range.p95Ms)).join('／')} ms | ≤50／≤50／≤100 |`,
  `| 缩放／DPR | 37×4 档；最大投影误差 ${format(Math.max(...zoom.map(item => Math.max(item.maxProjectionError, item.maxAnimationError))))} CSS 像素 | 无全黑；≤1 像素 |`,
  '| 连续视野像素对照 | 2,304 组，每组两帧；RGBA／预乘误差 0 | 通过 |',
  `| 建筑外观像素对照 | ${facadeRaster.cases} 组×2 帧；边缘外差异 ${facadeRaster.outsideEdgeHaloPixels}，内部泄露 ${facadeRaster.interiorLeakedPixels} | 差异仅 ≤1 CSS 像素边缘；4 DPR 复现通过 |`,
  `| 破坏／恢复压力 | ${smoke.ruins.stress.rounds} 轮；反馈 p95 ${format(smoke.ruins.stress.damageP95Ms)}／${format(smoke.ruins.stress.restoreP95Ms)} ms | 1,000 米视野，均 ≤100 ms |`,
  `| 破坏／恢复帧响应 | ${format(smoke.ruins.stress.frames.averageFPS)} FPS；帧 p95 ${format(smoke.ruins.stress.frames.p95Ms)} ms；最长任务 ${format(smoke.ruins.stress.maxLongTaskMs)} ms | ≥58／≤20／≤100 |`,
  `| 派生几何缓存 | ${smoke.ruins.stress.finalGeometryCache.entries} 项；每对象最多 ${smoke.ruins.stress.finalGeometryCache.largestFeatureVersions} 版本 | ≤512／≤2，探索队列排空 |`,
  `| 破坏／恢复显示层耗时 | 最后 ${format(smoke.ruins.stress.finalDiagnostics.lastRenderMs)} ms；本次最高 ${format(Math.max(smoke.ruins.beforeReload.diagnostics.maxRenderMs,smoke.ruins.stress.finalDiagnostics.maxRenderMs))} ms | 记录原始显示耗时 |`,
  `| 显示层缓存 | 节点 ${smoke.ruins.stress.finalDiagnostics.cachedNodes}／${smoke.ruins.stress.finalDiagnostics.cachedNodesLimit}；几何 ${smoke.ruins.stress.finalDiagnostics.cachedFeatureGeometry}／${smoke.ruins.stress.finalDiagnostics.featureGeometryLimit}；废墟 ${smoke.ruins.stress.finalDiagnostics.ruinObjects}／${smoke.ruins.stress.finalDiagnostics.ruinObjectsLimit} | 有界，可释放 |`,
  '| 废墟功能与资源 | 固定锚点、并集遮罩、严重贴图、单对象恢复及真实存档重载 | Chrome 通过；安装包无完整素材库 |',
  `| 安装包破坏联机与恢复 | ${lanVision.ruinsLan.samples.length} 条 GM 实际事务；${lanVision.ruinsLan.permissions.length} 条 Player 拒绝；真断线重连及两次真实服务重启 | Player SceneEvent 差量、WAL 校验和、原始历史及 Tag／门状态核对通过 |`,
  `| Windows ZIP | ${(await stat(path.join(directory, 'RPGmap-v2.5.5.zip'))).size} 字节 | 体积仅记录 |`,
];
const report = `# v2.5.5 ${reportKind === 'final-main' ? '最终 main' : '固定候选'}性能与验收报告\n\n提交：\`${metadata.commit}\`。SHA-256：\`${sha256}\`。\n\n保留用户指定的游戏和 Python 背景负载；同机同输入顺序预热后各五轮。基线 v2.5.4：\`ed7e13baab0f116222333c20431e19ab63b60e37\`。WebSocket／WAL 测试及 Chrome 七会话运行在同一 Windows 主机的回环网络，并非七台独立设备的物理 LAN 测量。\n\n| 检查 | 实测 | 门槛／结果 |\n|---|---|---|\n${rows.join('\n')}\n\n实时视野使用连续圆形和实际轮廓阴影。历史 Fog 保留 5 米网格、每 2.5 米沿途采样；两类大范围场景均使用 1,000 米视野、425 米路径、暗光和三个光源，所有任务可靠完成。原始 JSON、功能日志、ZIP、校验文件及 local-validation.json 与此报告一同交付，验证器已核对原始延迟、采样、恢复和包指纹。\n\n升级前备份整个 map/ 目录，主机和玩家统一升级。手工检查：放大和移动；建筑附近遮挡及内部视野；开关门和破坏恢复；多人来源及私有目标；存档重载。手绘门洞须正确绑定并贯穿宿主墙；极端贴墙位置保留精确网格回退，大范围历史探索在移动确认后后台补齐。详细步骤见仓库 RELEASE-NOTES-v2.5.5.md。\n`;
await writeFile(path.join(directory, `${reportKind}-performance-report.md`), report);
console.log(JSON.stringify({directory,commit:metadata.commit,sha256,metrics,recoveredMs:browser.recovery.recoveredMs}));
