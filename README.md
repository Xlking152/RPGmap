# RPGmap

RPGmap 是一个面向桌面跑团的自托管 Web 战术地图工具。当前版本为 **2.3.1**，提供 World/Scene 管理、Actor 模板与 Token 实例、分段移动与测距、生命/伤势、Status V4、战斗、折叠聊天、四级权限投影、精确/模糊侦测、隐身与战争迷雾，以及 Windows 本机/局域网多人运行包。

内置的“北宋兰州城”是复杂 Reference MapPackage，用于验证建筑、城墙、城门、桥梁、水体、破坏、洪水、导航和 29 张 WebP 美术资源能够通过通用 Core 运行。

## 快速开始

正式 Windows Release：

1. 安装 Node.js `20.19+` 或 `22.12+`。
2. 下载并解压 `RPGmap-v2.3.1.zip`。
3. 双击 `start-rpgmap.bat`。
4. GM 使用启动窗口中的 Local URL 与 GM Secret；同一局域网的 Player 使用 LAN URL 与 Join Code。

RPGmap 仅面向本机和可信局域网，不应直接暴露到公网。World、用户和备份保存在解压目录的 `map/` 下；升级前应复制整个 `map/`。

完整步骤见 [操作指南](文档/操作指南.md)。

## 核心能力

- World Manager：先选择或创建 World，再按其 Ruleset 与 Active Scene 加载地图。
- Scene/MapPackage：同一地图可建立多个 Scene，Feature State 与 Token 相互隔离。
- Actor/Token：Actor 是可复用模板；PC 可使用 Linked Token，怪物、NPC 与召唤物强制使用 Unlinked Token，并在各自 `actorDelta` 中独立保存生命、伤势、状态、资源和当前形态。
- 角色与怪物卡：Actor Sheet V3 支持多窗口、拖动缩放与 Play/Edit 边界；GM 可维护公共简介、外观、已知情报和可公开状态。LIMITED 玩家只获得服务器裁剪后的公共卡，Unlinked 怪物状态按具体 Token 实例隔离。
- 地图工具：选择、框选、直接拖动、碰撞、测距和高度。普通拖放提交直线路线；`Ctrl`/`Cmd` 进入分段规划，支持点击或 `F` 添加路径点、右键或 `Alt+F` 撤销、`Enter` 确认和 `Esc` 取消。连续 WASD 合并为有界事务，群组拖动保持相对队形并原子提交。
- 规则系统：Infinite Horror Actor、Health、B/L/A 伤势、Status/Effect、Damage/Healing；侦测分为精确与模糊范围，并结合明暗环境、暗视等感官能力计算。
- 生命与批量操作：生命展示与可编辑字段由当前 Ruleset 的 Health Presentation 决定。Infinite Horror 在实例抽屉显示完好/B/L/A 伤势与对应编辑字段；普通 HP 或 DND 类规则可只显示 `current/max`。批量伤害/恢复也从 Ruleset 提供的伤害类型、恢复类型和标签生成。地图右下角保持紧凑的 Primary Token 大头像、名称、实例类型和 Ruleset 生命摘要，不再用大尺寸多选编辑 HUD 遮挡地图。
- 战斗与聊天：先攻、回合权限、共享聊天与系统日志；当前战斗者离开本回合起点后，会保留不可交互的回合起点幻影直到下一回合。普通 Player 在战斗中只能移动当前回合的 Token 实例，不能通过同 Actor 模板的其他 Token 绕过 Combat Turn Lock；GM 可按需要调整多个 Token。
- Local/LAN：Operation Protocol V2 统一 Token、Actor、Status、Chat、Health、Combat、Feature 与 Fog 写入，使用 revision、幂等、原子写盘和 Audience-safe patch/changeSet。权限区分 NONE、LIMITED、OBSERVER、OWNER 与 Token 控制权；怪物/NPC/召唤物实例使用 `controllerUserIds` 的 Token-first 控制权。
- 视野与迷雾：玩家选择自己控制的 Token 作为唯一实时视野来源；视野圆心始终跟随该 Token 的最新权威坐标，精确与模糊范围实际看过的 5 米网格区域按 Scene 与队伍持久化共享，GM 可重置或重新隐藏。显式导入或实例覆盖的侦测距离按 Ruleset 原值运行，不再被 Fog 的 120 m 实现上限截断；Fog operation 接受更大半径，并仅把栅格计算裁剪到当前地图实际可覆盖范围。未配置侦测时的自动默认范围仍遵循 Infinite Horror 自身的 `20–120m` fallback 规则。
- 隐身与可见性：Token 支持公开、队伍、仅 GM 和指定用户；隐身 Token 仅向 GM、控制者、队友及明确授权用户以半透明形式投影。
- 其他指示物：陷阱、目标点、区域和注释使用轻量 Marker；指示物库分别提供怪物、NPC 与其他模板区域，怪物/NPC 可从各自 XLSX 入口导入，并可在当前 Scene 实例抽屉中逐个检查 Ruleset 生命字段与状态，并执行批量状态、批量伤害和批量恢复。怪物、NPC 与召唤物的 Actor 状态写入其 Synthetic Actor Token 的 `actorDelta.effects`，不会修改模板或同模板的其他实例。
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
├─ fog
├─ featureStates
├─ sceneEvents
└─ markers / attackAreas / settings
```

- Core 提供通用能力，不理解 Infinite Horror 私有字段或兰州分类。
- Ruleset 拥有 `Actor.system`、派生、展示与规则操作。
- MapPackage 描述地图尺寸、SVG/资产、Feature、Capability 与 Navigation，不保存 Campaign 状态。
- World schema 3 是持久化权威；Entity/UI/compatibility projection 与玩家 AudienceProjection 只能只读生成，不能覆盖服务器 World。
- 普通多人写入使用 operation schema 2；完整 World 只用于初始化、显式恢复/导入、revision 缺口、Audience 身份变化和跨 MapPackage Scene。

v2.3.1 将角色与怪物卡收口到 Actor Sheet V3：卡片权限由统一 Sheet Context 决定，OWNER/GM 的 Play 与 Edit 分离，OBSERVER 只读，LIMITED 只显示 GM 显式公开的资料和当前 Token 可公开状态。Actor 权限改为带 Access revision 的原子批量提交，不再借用隐藏管理表单。

v2.3.0 将联机写入统一到 Operation Protocol V2，并用细粒度 Audience-safe patch/changeSet 更新 Token、状态、聊天和 Fog；Status schema 与 Access schema 升至 4。新增四区 Token 实例配置、LIMITED 公开摘要、右键快捷状态 HUD、服务器权威持续时间、折叠聊天 composer、恢复完整的 Ctrl/Cmd 分段移动，以及 normal/dim/dark 下的精确/模糊感知。兰州地图的数据和 SVG 改为选择地图后才加载的编译资源；相对 v2.2.6，World reducer 三项中位数均降低超过 25%，三会话 LAN p95 降低超过 30%，总 JS gzip 降低至少 2%。

v2.2.6 将实例生命管理完全收敛到 Ruleset Health Presentation：怪物/NPC/召唤物实例抽屉动态读取 Ruleset 的生命摘要、可编辑字段、伤害类型和恢复类型，Core 不再识别 B/L/A 或其他私有生命体系。地图多选时恢复紧凑的 Primary Token 大头像摘要；Infinite Horror 可显示完好/B/L/A，而普通 HP/DND 类规则可自然显示 `20/20` 一类数值生命。

v2.2.5 修复怪物/NPC/召唤物实例移动权限：客户端不再用 Actor OWNER 覆盖已经存在的 Token-first `canControlToken`，Local/LAN 服务端也接受被 `controllerUserIds` 授权的非 PC 实例移动，并在战斗中按当前 `tokenId` 而不是仅按 Actor 模板锁定行动实例。移动层新增单次校验 fast path、Movement V5 RAF 拖拽预览、WASD 同方向合并与共享导航缓存；Health Bar 改为按 Token 增量刷新。

v2.2.4 解除大范围视野/Fog 的 120 m 实现层硬限制，并把 Fog 计算与存储裁剪到地图边界；超大侦测距离不再按半径无限扩大 Fog 工作量。

v2.2.3 修复三个直接影响桌面跑团的回归：Token 鼠标拖动改为 document 级 Pointer 生命周期并松开即移动，WASD 改为连续队列；导入角色的有效视野在进入 Fog operation 前统一到 120 m 运行时上限；怪物/NPC/召唤物批量状态不再把 Synthetic Actor 重新当作 Actor 模板写入，而是直接更新各自 Token 的 `actorDelta.effects`。

v2.2.0 将 Actor 明确为模板，将 NPC/召唤物 Token 明确为独立运行实例；所有伤害、Health、Status、Effect 与 Combat 操作都按 `tokenId` 结算。Local/LAN 服务端针对每个会话生成 AudienceProjection，隐藏实体不会通过快照、补丁、战斗、聊天或查询旁路泄漏。首期视野为无墙体遮挡的圆形范围；原始地图资产仍会下载到客户端，因此战争迷雾不是地图底图 DRM。

v2.1.2 恢复 v1.6.3 的 Token 拖动、范围手柄和地图地物检查体验，但不恢复旧 Character Runtime；详细结构审计与修改过程见 [v2.1.2 Interaction Restoration](reference/V2.1.2-INTERACTION-RESTORATION.md)。

v2.1.3 修复 Local/LAN 聊天发送者看不到自己消息、合并“选择/检查地物”重复入口，并修复 Token 绑定范围无法预览/应用的问题；这些修复仍保持 Scene Token、World V2 和服务器权威边界不变。详细说明见 [v2.1.3 UI / AoE Fixes](reference/V2.1.3-UI-AOE-FIXES.md)。

v2.1.4 恢复更接近 v1.6.3 的移动观感：规划时显示随终点移动的 Token 幽灵，权威移动提交后只在渲染层平滑插值，不产生中间 World 写入；Token 高度移到名称左侧，血条继续位于 Token 下方。详细说明见 [v2.1.4 Movement Visuals](reference/V2.1.4-MOVEMENT-VISUALS.md)。

v2.1.5 增加 FVTT 风格的 Combat Turn Origin Ghost：每个回合开始时在共享 Combat State 捕获当前 Scene Token 的起始坐标和高度；Token 真正离开起点后，Renderer 在原位显示半透明“起点”幻影，下一回合或战斗结束自动替换/清除。幻影不是第二个 Token，不参与选择、碰撞、范围、伤害或任何 World 写入。详细说明见 [v2.1.5 Combat Turn Origin](reference/V2.1.5-COMBAT-TURN-ORIGIN.md)。

v2.1.6 增加 Group Token Movement：多选 Token 只作为一次临时移动上下文，不创建 `TokenGroup` 或 Formation 文档。拖动已选 Token 时由该 Token 作为 leader，其他成员保持固定 `dx/dy`；路线只显示 leader，但每个成员沿平移后的同一 waypoint 路径独立校验，全部通过后才以一次 World commit 原子写入最终位置。Renderer 使用预置的只读视觉 waypoint 队列同步播放每个 Token 的平滑移动，并在规划阶段显示整组终点幻影。详细说明见 [v2.1.6 Group Token Movement](reference/V2.1.6-GROUP-TOKEN-MOVEMENT.md)。

启动入口 `src/main.js` 只包含 World Manager bootstrap。选择 World/Scene 后才动态导入 `src/runtime/map-runtime.js`、Leaflet、地图 CSS、兰州逻辑与资源。

## 本地开发

```bash
npm ci --no-audit --no-fund
npm test
npm run benchmark
npm run benchmark:lan
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
