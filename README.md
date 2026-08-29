# RPGmap

RPGmap 是一个面向桌面跑团的自托管 Web 战术地图工具。当前版本为 **2.1.3**，提供 World/Scene 管理、Actor/Token、地图移动与测距、生命/伤势、状态、战斗、聊天，以及 Windows 本机/局域网多人运行包。

内置的“北宋兰州城”是复杂 Reference MapPackage，用于验证建筑、城墙、城门、桥梁、水体、破坏、洪水、导航和 29 张 WebP 美术资源能够通过通用 Core 运行。

## 快速开始

正式 Windows Release：

1. 安装 Node.js `20.19+` 或 `22.12+`。
2. 下载并解压 `RPGmap-v2.1.3.zip`。
3. 双击 `start-rpgmap.bat`。
4. GM 使用启动窗口中的 Local URL 与 GM Secret；同一局域网的 Player 使用 LAN URL 与 Join Code。

RPGmap 仅面向本机和可信局域网，不应直接暴露到公网。World、用户和备份保存在解压目录的 `map/` 下；升级前应复制整个 `map/`。

完整步骤见 [操作指南](文档/操作指南.md)。

## 核心能力

- World Manager：先选择或创建 World，再按其 Ruleset 与 Active Scene 加载地图。
- Scene/MapPackage：同一地图可建立多个 Scene，Feature State 与 Token 相互隔离。
- Actor/Token：Linked Token 使用 Base Actor；Unlinked Token 通过 `actorDelta` 保存独立状态。
- 地图工具：选择、拖动、直线 waypoint、碰撞、测距、高度，以及选择模式下的 Feature 检查/开关。
- 规则系统：Infinite Horror Actor、Health、B/L/A 伤势、Status/Effect、Damage/Healing。
- 战斗与聊天：先攻、回合权限、共享聊天与系统日志。
- Local/LAN：服务器权威 operation、revision、幂等、Actor Ownership、Combat Turn Lock 与滚动备份。
- 发布验证：audit、全量测试、tracked syntax、bundle budget、严格包清单、SHA-256 和 Windows Edge smoke。

## 架构边界

```text
World
├─ ruleset
├─ actors
├─ statusDefinitions
├─ scenes
└─ activeSceneId

Scene
├─ mapPackage
├─ tokens
├─ featureStates
├─ sceneEvents
└─ markers / attackAreas / settings
```

- Core 提供通用能力，不理解 Infinite Horror 私有字段或兰州分类。
- Ruleset 拥有 `Actor.system`、派生、展示与规则操作。
- MapPackage 描述地图尺寸、SVG/资产、Feature、Capability 与 Navigation，不保存 Campaign 状态。
- World V2 是持久化权威；Entity/UI/compatibility projection 只能只读生成。
- 普通多人写入使用 operation schema 1；完整 World 只用于初始化、快照、显式导入和恢复。

v2.1.2 恢复 v1.6.3 的 Token 拖动、范围手柄和地图地物检查体验，但不恢复旧 Character Runtime；详细结构审计与修改过程见 [v2.1.2 Interaction Restoration](reference/V2.1.2-INTERACTION-RESTORATION.md)。

v2.1.3 修复 Local/LAN 聊天发送者看不到自己消息、合并“选择/检查地物”重复入口，并修复 Token 绑定范围无法预览/应用的问题；这些修复仍保持 Scene Token、World V2 和服务器权威边界不变。详细说明见 [v2.1.3 UI / AoE Fixes](reference/V2.1.3-UI-AOE-FIXES.md)。

启动入口 `src/main.js` 只包含 World Manager bootstrap。选择 World/Scene 后才动态导入 `src/runtime/map-runtime.js`、Leaflet、地图 CSS、兰州逻辑与资源。

## 本地开发

```bash
npm ci --no-audit --no-fund
npm test
npm run build
npm run check:bundle
npm run package:local-server
```

开发服务器：

```bash
npm run dev
```

项目要求 Node.js `^20.19.0 || >=22.12.0`。测试使用 Node 内置 `node:test`，生产构建使用 Vite 8。

## 发布

- Candidate workflow 在 PR 与 `main` push 上执行完整测试、构建、包验证和 Windows smoke。
- 正式版本最终使用指向 `main` release commit 的 `vX.Y.Z` tag；release workflow 也支持受校验的 `release-vX.Y.Z` 自动化入口，由发布任务创建同名正式 tag/release。
- Release 只发布 ZIP 与 `.sha256`，ZIP 不包含 raw `reference/`、源码、测试或过程文档。
- `VERSION.json` 必须记录与正式 release target 一致的版本和完整 source commit。
