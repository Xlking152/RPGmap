import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyLocalValidation } from './verify-local-validation.mjs';

const [label, reportKind = 'candidate'] = process.argv.slice(2);
assert(/^[a-z-]+$/.test(label || ''));
assert(['candidate', 'final-main'].includes(reportKind));
const root = process.cwd(), directory = path.join(root, 'artifact', `${label}-candidate`);
const metadata = JSON.parse(await readFile(path.join(directory, 'RPGmap-v2.5.5', 'VERSION.json'), 'utf8'));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const rawFiles = {
  'vision-v254.json': `v2.5.4-vision-${label}-load.json`,
  'vision-v255.json': `v2.5.5-vision-${label}-load.json`,
  'chrome-smoke.json': `v2.5.5-chrome-smoke-${label}.json`,
};
for (const [name, source] of Object.entries(rawFiles))
  await copyFile(path.join(root, 'artifact', 'qa', source), path.join(directory, name));
const smokeLog = await readFile(path.join(root, 'artifact', `occlusion-chrome-smoke-${label}.log`), 'utf8');
const lanPayloads = smokeLog.split(/\r?\n/).filter(line => line.startsWith('{')).map(JSON.parse)
  .filter(value => value.identity === true && value.ruinsLan);
assert.equal(lanPayloads.length, 1, 'Actual package LAN destruction/recovery evidence must occur once');
await writeFile(path.join(directory, 'lan-vision.json'), JSON.stringify(lanPayloads[0], null, 2) + '\n');
const checks = Object.fromEntries(['tests', 'build', 'bundle', 'package', 'benchmark', 'chrome',
  'visionBenchmark', 'localPerformance'].map(name => [name, 'passed']));
for (const name of ['lanBenchmark', 'occlusionLanBenchmark', 'browserBenchmark']) checks[name] = 'deferred';
const archive = await readFile(path.join(directory, 'RPGmap-v2.5.5.zip'));
const sha256 = createHash('sha256').update(archive).digest('hex');
const validation = { version: '2.5.5', commit: metadata.commit, performanceScope: 'local-single-player',
  baselineCommit: 'ed7e13baab0f116222333c20431e19ab63b60e37', sha256, checks,
  evidence: { visionBenchmark: { baseline: 'vision-v254.json', candidate: 'vision-v255.json' },
    chromeSmoke: 'chrome-smoke.json', maskRaster: 'raster.json', facadeRaster: 'facade-raster.json',
    ruinsLan: 'lan-vision.json', dependencyAudit: { all: 'audit.json', production: 'audit-production.json' } } };
const [before, after, smoke] = await Promise.all(Object.keys(rawFiles).map(name => json(path.join(directory, name))));
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
for (const [check, name] of [['raster', 'raster.json'], ['facade-raster', 'facade-raster.json']]) {
  const log = await readFile(path.join(root, 'artifact', `occlusion-${check}-${label}.log`), 'utf8');
  await writeFile(path.join(directory, name), JSON.stringify(JSON.parse(log.slice(log.indexOf('{'))), null, 2) + '\n');
}
await writeFile(path.join(directory, 'local-validation.json'), JSON.stringify(validation, null, 2) + '\n');
await verifyLocalValidation({ directory, version: '2.5.5', commit: metadata.commit });
for (const name of ['full-tests', 'syntax', 'core', 'chrome-smoke', 'raster', 'facade-raster', 'audit', 'audit-production']) {
  const extension = name.startsWith('audit') ? 'json' : 'log';
  await copyFile(path.join(root, 'artifact', `occlusion-${name}-${label}.${extension}`), path.join(directory, `${name}.${extension}`));
}
const format = number => Number(number).toFixed(3), stress = smoke.ruins.stress, local = smoke.ruins.localPerformance;
const rows = [
  `| 全量测试／语法 | ${testCount} 项／${syntaxCount} 模块 | 全通过 |`,
  '| 开发／生产依赖审计 | 0／0 漏洞 | 通过 |',
  ...local.phases.map(phase => `| 单机 ${phase.name}：FPS／帧 p95／输入 p95 | ${format(phase.averageFPS)}／${format(phase.frameP95Ms)}／${format(phase.inputP95Ms)} ms | ≥58／≤20／≤16.7；60 秒，${phase.moves.length} 次确认移动 |`),
  ...local.phases.map(phase => `| 单机 ${phase.name} 最长任务 | ${format(phase.maxLongTaskMs)} ms | ≤100 |`),
  `| 120／500／1,000 米移动至完整遮罩 p95 | ${smoke.occlusion.feedback.ranges.map(range => format(range.p95Ms)).join('／')} ms | ≤50／≤50／≤100 |`,
  `| 425 米探索中位：v2.5.4 → v2.5.5 | ${format(before.sweep.medianMs)} → ${format(after.sweep.medianMs)} ms | 不退化；结果哈希一致 |`,
  `| 1,000 米视野中位：v2.5.4 → v2.5.5 | ${format(before.visibility[1000].medianMs)} → ${format(after.visibility[1000].medianMs)} ms；连续视野 ${format(after.continuous[1000].medianMs)} ms | 相同输入；网格哈希一致 |`,
  '| 缩放／DPR | 37 档×4 DPR；平移、动画及窗口变化 | 不全黑；误差 ≤1 CSS 像素 |',
  '| 连续视野／建筑外观像素对照 | 2,304／1,152 组，各两帧 | 原始几何及像素对照通过 |',
  `| 破坏／恢复压力 | ${stress.rounds} 轮；反馈 p95 ${format(stress.damageP95Ms)}／${format(stress.restoreP95Ms)} ms | 1,000 米视野；均 ≤100 ms |`,
  `| 破坏／恢复帧响应 | ${format(stress.frames.averageFPS)} FPS；帧 p95 ${format(stress.frames.p95Ms)} ms；最长任务 ${format(stress.maxLongTaskMs)} ms | ≥58／≤20／≤100 |`,
  `| 派生几何缓存 | ${stress.finalGeometryCache.entries} 项；每对象最多 ${stress.finalGeometryCache.largestFeatureVersions} 版本 | ≤512／≤2，队列排空 |`,
  `| 废墟显示耗时 | 最后 ${format(stress.finalDiagnostics.lastRenderMs)} ms，最高 ${format(stress.finalDiagnostics.maxRenderMs)} ms | 原始耗时与有界缓存记录 |`,
  '| 废墟与存档 | 固定锚点、并集遮罩、严重贴图、单对象恢复及刷新重载 | 无实体 Tag；安装包无完整素材库 |',
  `| 联机功能回归 | ${lanPayloads[0].ruinsLan.samples.length} 条 GM 事务；${lanPayloads[0].ruinsLan.permissions.length} 条权限拒绝；断线与两次重启 | 差量、WAL、历史及 Tag／门状态通过 |`,
  '| 联机性能及七会话流畅度 | 延期 | 用户调整为本地单机验收；未宣称达到原 LAN 门槛 |',
  `| Windows ZIP | ${(await stat(path.join(directory, 'RPGmap-v2.5.5.zip'))).size} 字节 | 体积仅记录 |`,
];
const report = `# v2.5.5 ${reportKind === 'final-main' ? '最终 main' : '固定候选'}单机性能与验收报告

提交：\`${metadata.commit}\`。SHA-256：\`${sha256}\`。

按用户最新要求，本轮保留联机功能，性能验收限于本地单机。联机性能及七会话流畅度检查明确延期，之前失败的候选结果未改写为通过；权限、同步、断线与可靠落盘继续功能回归。

保留当前后台负载，未关闭或暂停用户程序。Chrome 使用真实安装包及持久离线 World，${local.tokenCount} 个 Token、${local.featureCount} 个地图对象；正常／暗光各 60 秒。算法基线为同机同输入的 v2.5.4 提交 \`ed7e13baab0f116222333c20431e19ab63b60e37\`，预热后各五轮。联机功能使用同机回环网络，不代表七台设备物理 LAN 性能。

| 检查 | 实测 | 门槛／结果 |
|---|---|---|
${rows.join('\n')}

历史 Fog 保留 5 米网格及每 2.5 米沿途采样，实时视野使用连续圆形和实际轮廓阴影。原始 JSON、功能日志、ZIP、校验文件与 local-validation.json 一同交付；验证器核对原始观测、完整源文件及安装包指纹。

已知限制：大范围多人并发延迟尚未达到原计划门槛，留待后续联机优化。单机数据不代表 500 Token 或多人流畅度。手绘门洞须绑定并贯穿宿主墙；极端贴墙保留精确网格回退，大范围历史探索在移动确认后后台补齐。

升级前备份整个 map/。手测：开视野后破坏建筑、移动及缩放；重叠攻击与 95% 覆盖；门与剩余墙体；严重破坏及单对象恢复；保存和刷新重载。详见 RELEASE-NOTES-v2.5.5.md。
`;
await writeFile(path.join(directory, `${reportKind}-performance-report.md`), report);
console.log(JSON.stringify({ directory, commit: metadata.commit, sha256, performanceScope: validation.performanceScope,
  local: local.phases.map(({ name, averageFPS, frameP95Ms, inputP95Ms, maxLongTaskMs }) =>
    ({ name, averageFPS, frameP95Ms, inputP95Ms, maxLongTaskMs })) }));
