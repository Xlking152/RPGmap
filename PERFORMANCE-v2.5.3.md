# v2.5.3 视野性能与结构审计

## 测量方法

同一台 Windows 主机、同一份兰州地图（81 个遮挡体）、同一输入，顺序测量 v2.5.2 基线和 v2.5.3 当前工作树；各预热一次，再测五轮并记录中位数。视野中心为 `(2940, 2500, 0)`；425 米探索从该位置到 `(3365, 2500, 0)`，视野半径 1,000 米。脚本还记录 JSON 结果的 SHA-256，以比对可见区域与探索并集。以下是**候选分支的同机测量**；最终安装包的浏览器和联机验收另列，不能据此判定正式发布全部通过。

| 场景 | v2.5.2 中位 | v2.5.3 候选中位 | 降幅 | 结果校验 |
| --- | ---: | ---: | ---: | --- |
| 120 米视野 | 2.05 ms | 1.31 ms | 36.1% | SHA-256 一致 |
| 500 米视野 | 7.43 ms | 2.30 ms | 69.0% | SHA-256 一致 |
| 1,000 米视野 | 30.55 ms | 7.91 ms | 74.1% | SHA-256 一致 |
| 10,000 米全图视野 | 105.25 ms | 22.88 ms | 78.3% | SHA-256 一致 |
| 500 米暗光、三光源视野 | 82.79 ms | 9.73 ms | 88.2% | SHA-256 一致 |
| 425 米完整沿途探索 | 2,451.40 ms | 940.22 ms | 61.6% | SHA-256 一致 |

本组原始记录：`artifact/vision-baseline-release.json` 与 `artifact/vision-candidate-release.json`。两次更早的候选测量因代码版本或系统负载不同未用于上表。几何准备约 0.19→0.18 ms，`structuredClone` 约 0.39→0.35 ms；绝对耗时很短，差异不作为收益判断。这些数字测量同步几何算法的 CPU 时间；Worker、Canvas、浏览器主线程和 LAN 的效果须用下列独立门槛判断。

结果哈希：120 米视野 `eb0d7b9441eca011afa416fcb69c15500a62bcb7bf10757618a590ddd9451967`；500、1,000 米和全图视野 `e38107b1bc3ef4ae71b68de062b2269fffe53fda7817f9c98f9c0e258971a815`；三光源视野 `adce9dc13df48e2d51c38c134eb76350ee34fe235497ad9e461f33c36d91edc3`；完整沿途探索 `1a149fc9d5199006112531db83cab17e4e65ed4468f7b7ab86449c4ee8430618`。每项基线与候选值一致。

## 结构和开销审计

- 将过去精确、模糊视野各自计算的建筑遮挡合为一次，按范围裁剪结果；场景上下文集中预处理遮挡体、光源及版本，空间索引保持原始命中顺序。
- 阴影逐行维护当前有效的边；Fog 只处理未探索格子，新增行区间批量合并。渲染层统一复用 `mergeSpans`，删除第二份同义实现。
- 探索输入准备从完整 World 归约中提取；后台计算完成后才由权威操作提交。服务端异步探索继续串行事务和 WAL 后 ACK，避免为预检重复复制、归约 World。
- Worker 对同一场景版本复用几何和灯光输入；热路径的状态读取与历史探索处理按版本复用，缓存有容量上限并在场景切换、销毁时释放。缓存不保存跨用户私有可见性结果。
- 保留存档迁移与兼容接口。本轮删除经确认的重复实现，未以文件体积作为删除仍被外部调用代码的依据。

## 发布前验收记录

| 门槛 | 状态与证据 |
| --- | --- |
| 精度、退化几何、高度、孔洞、门、破坏、照明、权限 | 842 项候选全量测试通过；500 组随机视野、20 条扫掠路径及 12 组兰州场景与 v2.5.2 一致；待最终 main 复核 |
| 1,000 米视野中位耗时降低至少 30% | 同机五轮中位降低 74.1%；待最终 main 复核 |
| 425 米探索中位耗时降低至少 50% | 同机五轮中位降低 61.6%；待最终 main 复核 |
| 425 米移动的浏览器主线程长任务总时长降低至少 50% | Edge 安装包交替五轮：219→57 ms（中位降低 74.0%）；最终包仍需复核 |
| 普通范围帧率、输入响应及 500 Token、GM＋6 Player LAN 门槛 | LAN 断言通过（移动 p95 20.85 ms）；Chrome 前台 7 会话两段各 60 秒断言通过，最低平均 FPS 162.9、最慢帧 p95 6.2 ms、最慢输入 p95 6.2 ms |
| 队列排空、缓存上限、内存与传输量 | 20 次场景上下文切换测试中缓存始终 ≤2；Chrome 120 秒压测完成后队列无积压，视野队列峰值 1；首个几何消息约 25.7 KB，同场景移动消息 p95 467 B；未取得跨设备长期内存曲线 |
| audit、语法、测试、bundle、ZIP、Edge/Chrome | 候选双浏览器完整安装包测试、842 项测试、依赖审计和构建预算通过；待最终 main 提交重打包复验 |

复现几何测量（在仓库根目录；`artifact/vision-baseline` 为 v2.5.2 的独立检出目录）：

```powershell
node scripts/vision-performance-benchmark.mjs --repo=artifact/vision-baseline > artifact/vision-baseline-repeat.json
node scripts/vision-performance-benchmark.mjs > artifact/vision-v2.5.3-final.json
npm test
npm run benchmark:lan -- --assert
npm run build
npm run check:bundle
npm run package:local-server
npm run check:package
./scripts/windows-smoke.ps1 -Root artifact/RPGmap-v2.5.3 -Browser edge
./scripts/windows-smoke.ps1 -Root artifact/RPGmap-v2.5.3 -Browser chrome
```

浏览器长任务比较使用**同一版** `scripts/browser-smoke.mjs` 对 v2.5.2/v2.5.3 包交替运行五轮 Edge headless；关闭 API profiler 和诊断，观察区间从 425 米用例计时开始，过滤观察器启用前已开始的任务。旧包五轮 `longTaskMs` 为 231/176/214/219/228，新包为 50/105/61/51/57，原始数据位于 `artifact/longtask-five-rounds.json`。最长帧间隔中位 183.4→83.3 ms，Token 放置中位 217.7→98.2 ms；五轮结果均低于现有 250/500 ms 门槛。加入 Worker 故障回退的最终候选包另测 Edge 57 ms、Chrome 0 ms，正常 Worker 路径未见回退带来的长任务增加。

Chrome 前台压测使用 500 Token、GM＋6 Player，普通范围和遮挡/多光源场景各运行 60 秒，脚本原有帧率、输入、网络确认与单次长任务断言均通过。第一次断线重连耗时 13.087 秒，超过 13 秒门槛 87 毫秒；同设置重跑后 12.953 秒通过。重连余量较小，可能受系统调度影响，升级后的多人测试应特别观察。最后在合并后的 `main` 提交重新打包、验证 ZIP SHA-256 和 `VERSION.json`，再发布正式 Release。
