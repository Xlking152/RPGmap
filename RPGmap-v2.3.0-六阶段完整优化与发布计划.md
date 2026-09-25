# RPGmap v2.3.0 六阶段完整优化与发布计划（联机、权限、移动与视野整合版）

## 文档交付说明

- 最终只创建或覆盖 `RPGmap-v2.3.0-六阶段完整优化与发布计划.md`。
- 本次任务不修改源代码、不创建发布分支、不提交、不打 Tag、不执行 Release。
- 本文档作为完整替换版，朋友的 Codex 无需再读取旧计划。
- 实际开发以 `v2.2.6 / f8d1440` 为基线，六阶段全部完成后正式发布 `v2.3.0`。

## 总体目标与已确认问题

v2.3.0 优先解决：

1. 玩家端拖动、选择、状态、聊天和角色卡交互不流畅。
2. LAN 普通操作仍可能触发完整 World 导入、全量渲染和重复 AudienceProjection。
3. 公开但不可控制的怪物 Token 经 `AudienceProjection` 裁剪后不符合 World Schema：
   - 缺少 `controllerUserIds`、`visibility`、`vision`。
   - 错误硬编码 `actorLink: true`，与 monster/npc/summon 的独立实例规则冲突。
4. 权限仍混杂“能看、能打开角色卡、能编辑、能控制 Token”四种概念。
5. Movement V5 只保留直线拖动，`addWaypoint()` 和 `removeWaypoint()` 固定返回 `false`，Ctrl 分段移动发生功能退化。
6. 模糊视野遮罩过重，当前约 `0.62` 的暗色覆盖影响可辨识度。
7. 聊天记录需要常驻，但底部消息/伤害/恢复表单不应一直展开。

参考 Foundry 的 [Actor 权限分层](https://foundryvtt.com/article/actors/)、[Token HUD](https://foundryvtt.com/article/tokens/)、[Active Effects](https://foundryvtt.com/article/active-effects/) 和 [分段路径移动](https://foundryvtt.com/article/measurement/)，但保留 RPGmap 已有的服务器权威、Operation、Revision、AudienceProjection 和 Synthetic Actor 语义。

---

## 第一阶段：基线、结构收敛与旧实现清理

### 1.1 开发基线

- 检查工作区、远程 `main`、现有 Tag 和 Release。
- 同步 `origin/main` 后创建 `codex/v2.3.0`。
- 重新记录：
  - 测试数量和通过情况。
  - World operation 中位数与 p95。
  - 单机和 LAN 的操作可见延迟。
  - Runtime 主包及总 JS gzip。
  - 500 Token 场景首次渲染、单 Token 移动和状态切换耗时。
- 保留旧计划记录的参考基线：525 项测试、operation 中位数约 8.7–9.4 ms、总 JS gzip 256,689 B；如当前实测不同，以新测量结果为正式基线。

### 1.2 模块职责收敛

拆分职责过大的模块：

- 多人客户端：transport、session、operation queue、revision/patch、transient preview、管理 UI。
- Local Server：HTTP、WebSocket、身份与权限、command handler、AudienceProjection、持久化。
- Entity UI：Actor 目录、完整角色卡、LIMITED 角色卡、Token 配置和事件协调。
- Status UI：快捷 HUD、完整管理页、定义编辑器、Token 徽章。
- Movement：输入状态机、路径规划、预览渲染、碰撞验证、权威提交。

### 1.3 清理原则

- Movement V5 恢复分段路径并达到完整测试覆盖后，删除 V2/V3/V4 运行时实现。
- 正式实现改为无版本后缀的稳定文件名。
- 迁移与兼容代码只允许存在于 Legacy、Schema Migration 和导入边界。
- 公共入口只导出正式 API。
- 重型角色卡、状态定义编辑器首次打开时动态加载。
- 测试不得继续依赖旧源码文件名，应验证行为、公开接口和架构边界。

### 阶段验收

- 退休实现不再被 Runtime、构建入口或测试引用。
- 全量测试通过。
- Bundle 不增长。
- 不允许为了清理旧文件提前删除仍包含有效路径移动逻辑的代码。

---

## 第二阶段：统一权限层与 AudienceProjection 修复

### 2.1 权限模型

Access Schema 从 3 升级为 4，Actor 权限增加：

```text
none
limited
observer
owner
```

语义固定为：

| 权限 | 目录可见 | 角色卡 | 编辑 Actor | 控制 Token |
|---|---:|---|---:|---:|
| none | 否 | 不可打开 | 否 | 否 |
| limited | 是 | 仅公开摘要 | 否 | 否 |
| observer | 是 | 完整只读 | 否 | 否 |
| owner | 是 | 完整可编辑 | 是 | 仅按 Token 规则判定 |
| GM | 是 | 完整可编辑 | 是 | 是 |

权限维度必须分开：

- Token visibility：决定地图上是否存在。
- Actor ownership：决定能否打开以及角色卡内容。
- `controllerUserIds`：决定能否移动或操作具体 Token。
- Vision authorization：决定能否将 Token 作为视野来源。
- Combat、locked、status capability：作为具体操作的附加限制。

PC 的 OWNER 可以控制其 Linked Token；monster、npc、summon 继续采用 Token-first 规则，不能因为拥有模板 Actor 就自动控制所有实例。

### 2.2 统一权限 API

建立单一入口：

```js
api.permissions.can(action, context)
```

至少支持：

```text
actor.list
actor.viewLimited
actor.view
actor.edit
actor.delete
token.view
token.control
token.move
token.editHealth
token.editStatus
token.editAccess
token.useVision
```

要求：

- 客户端用同一接口控制按钮和交互状态。
- 服务端重新执行权威判断，不能依赖客户端禁用按钮。
- 移除 UI、Movement、Elevation、Health、Status 中各自实现的权限分支。
- 拒绝结果统一包含 `code`、用户可读 `message` 和相关实体 ID。

### 2.3 修复公开怪物 Token 投影

精确可见但无私有权限的 Token 必须仍是合法 World Token：

- 保留用于连续 patch 的真实 Token/Actor ID。
- `controllerUserIds` 固定投影为空数组。
- `visibility` 投影为合法只读公开结构。
- `vision.enabled` 为 `false`，范围和授权字段保持合法类型。
- effects、生命、状态、控制者和视野授权全部裁剪。
- monster/npc/summon 保持 `actorLink:false`；其他类型按 Schema 生成合法值。
- 投影后的 Token、Actor、引用关系必须再次通过 World Schema 验证。

模糊轮廓：

- 使用每个 session 独立的稳定 opaque ID 映射。
- 禁止通过 `audience-vague-token-${真实ID}` 一类格式泄漏真实 ID。
- 只保留匿名轮廓、直径级别、5 米量化坐标和模糊可见标记。
- 不下发名称、头像、生命、状态、Actor system、控制者、真实坐标和真实 ID。
- session 身份或 Audience 权限改变时重建 opaque 映射。

### 2.4 LIMITED 角色卡

- 单独实现最小只读卡，不复用“完整卡加 disabled”。
- 只显示名称、头像、类型和明确允许公开的简介。
- 不渲染 HP、状态、属性、所有权、Token 控制者、ActorDelta 和 Ruleset 私有数据。
- 公开怪物卡默认获得有效 LIMITED 展示能力，不自动获得 OBSERVER 或 OWNER。

### 阶段验收

- 公开怪物 Token 对玩家投影后通过完整 Schema 校验。
- 玩家打开 LIMITED 卡和继续进行地图操作时不再触发 `controllerUserIds must be an array`。
- LIMITED/OBSERVER 用户不能移动 Token。
- Token controller 可以移动指定实例，但不能编辑怪物模板 Actor。
- Audience 零泄漏测试通过。

---

## 第三阶段：Operation Protocol V2、LAN 与前端性能

### 3.1 Operation Protocol V2

- `WORLD_OPERATION_SCHEMA_VERSION` 和发布包 `operationSchema` 从 1 升至 2。
- 握手携带协议版本；不一致时拒绝连接并提示升级，禁止静默降级。
- 状态、聊天、Token、Health、Combat、Feature 和 Fog 全部通过 `world.operation`。
- 删除独立状态写入队列和普通聊天完整快照路径。
- 完整 snapshot 仅用于：
  - 首次连接。
  - 显式恢复。
  - revision 缺口。
  - Audience 身份/权限变化。
  - 跨 MapPackage Scene。
  - 无法安全恢复的 patch 校验失败。

### 3.2 Reducer 与权威 Patch

`applyWorldOperations()`：

- 每个 batch 只克隆一次输入。
- batch 结束时只生成一次 Runtime projection。
- 返回 `changeSet`，至少标记 Actor、Token、Scene、Feature、Fog、Combat、Chat 和状态定义。

新增客户端权威入口：

```js
applyAuthoritativePatch({ baseRevision, revision, patch, changeSet })
```

流程固定为：

1. 校验 revision 连续。
2. 将 patch 应用到 canonical World。
3. 校验最终引用与 Audience 安全边界。
4. 更新 revision。
5. 发出细粒度事件。
6. 只更新 changeSet 涉及的 UI。

普通 patch 禁止再经过：

```text
applyRemoteState
→ importState
→ 旧存档迁移
→ 整场景重建
```

### 3.3 增量渲染

- Token Renderer 使用 keyed DOM 更新。
- 移动一个 Token 不得重建全部 Token。
- 生命条、状态徽章、角色摘要、打开中的角色卡和聊天记录独立增量更新。
- Selection 变化只更新被选中和取消选中的节点。
- Fog 只响应视野来源、Fog、Scene、位置或视觉能力变化。
- Status/Chat operation 不得触发全 Fog 重算。
- 高频 pointermove、drag preview 和 resize 统一用 RAF 合并。
- 检查重复事件监听器、未释放订阅和重复 MutationObserver。

### 3.4 AudienceProjection 与持久化

- 每个 session 缓存上一次 AudienceProjection。
- 普通 operation 只计算新的投影并与缓存比较，不再重复生成 before/after 两份完整投影。
- 权限、可见性、视野来源和跨 Scene 改变时仍执行完整投影。
- 当前 World 文件继续在 ACK 前原子写盘。
- 滚动备份改为每 25 revision 或 60 秒一次。
- 导入、迁移和恢复前立即备份。

### 3.5 性能指标

记录：

```text
queue
authorization
reducer
disk write
projection
broadcast
client patch
render
visible latency
```

验收目标：

- 普通移动、聊天和状态更新不发送完整 World。
- 固定 fixture 的 operation 中位数降低至少 25%。
- 同机 LAN p95 可见延迟降低至少 30%。
- 总 JS gzip 相对基线下降至少 2%。
- 500 Token 场景移动一个 Token 时不得全量重建 Token DOM。
- revision 缺口、重复 operationId、断线重试和写盘失败均可恢复且不重复执行。

---

## 第四阶段：移动、Token、状态和聊天交互

### 4.1 FVTT 风格分段移动

参考 Foundry 的拖动路径交互，但适配 RPGmap 当前输入模型：

#### 普通移动

- 左键拖动并释放：直线移动。
- 拖动过程只发送 transient preview。
- canonical 坐标只在服务器 ACK 后更新。
- pending 时阻止对同一 Token 重复提交。
- 失败后恢复服务器坐标并显示具体原因。

#### Ctrl/Cmd 分段路径

1. 拖动 Token 时按住 Ctrl；macOS 使用 Cmd。
2. 松开鼠标进入路径规划，当前释放点仅作为预览，不自动保存为第一个路径点。
3. 保持 Ctrl/Cmd 时，左键点击添加路径点。
4. 释放 Ctrl/Cmd 后，下一次左键点击设置终点并提交。
5. 右键移除最后一个路径点；没有路径点时右键取消。
6. `F` 添加路径点，`Alt+F` 删除最后一个路径点。
7. `Enter` 确认当前终点，`Esc` 取消整个移动。
8. 路径线显示每段距离、累计距离、合法/非法状态和 LAN pending 状态。

服务端逐段验证：

- 控制权限。
- Token lock。
- Combat 当前回合。
- Scene 边界和碰撞。
- 群组成员的每一段路径。

群组移动作为一次有界 operation batch；任一成员失败则整批拒绝，防止客户端分叉。

#### WASD

- 本地立即预览。
- 50 ms 内或最多 8 个连续步合并为一次有界 batch。
- 保留移动顺序，不能只提交最终坐标绕过路径碰撞。
- 输入框、角色卡、聊天框聚焦时不得触发 WASD 移动。

### 4.2 Token 配置界面

- 标题改为头像、名称、Linked/Unlinked、Scene、位置和高度摘要。
- 内部 UUID 放在高级信息，不作为主标题。
- 从 Token 打开时只配置当前实例；从 Actor 模板进入时先选择实例。
- 分区：
  - 基础：实例名称、直径、旋转、高度。
  - 视野：启用、继承 Ruleset、精确范围、模糊范围、感官能力。
  - 权限：可见性、控制者、指定用户、视野授权。
  - 高级：重新放置、实例覆盖、删除。
- 默认只展开基础配置。
- 用户 ID 输入改为按显示名选择的多选组件。
- 显示 Ruleset 默认值、Token 覆盖值和最终值，并支持恢复继承。
- 删除过期的 `120 m` 前端上限。
- 每个字段单独提交，显示 pending/confirmed/error。
- 提交失败恢复 canonical 值。
- 删除位于独立危险区并二次确认。
- 桌面端和 390px 窄屏均无横向溢出。

### 4.3 Buff/Debuff 状态 HUD

Status Schema 从 3 升至 4：

```text
StatusDefinition
  id, name, description, icon, color
  category: buff | debuff | neutral
  scopes, maxStacks
  changes, capabilities
  defaultDuration?
  builtIn

StatusInstance
  id, definitionId
  stacks, enabled, note
  duration?
  source, createdAt
```

快捷 HUD：

- 右键 Token 或点击状态徽章打开。
- Buff 与 Debuff 分区；neutral 和生命派生状态折叠。
- 未施加：单击添加一层。
- 已启用：单击停用但保留实例。
- 已停用：单击重新启用。
- 右键打开层数、备注、持续时间和彻底移除。
- pending 时禁止重复提交。
- 多选 Token 支持批量施加、停用和移除。
- Linked Token 修改 Actor effects；Unlinked Token 修改 `actorDelta.effects`。

安全要求：

- 自定义状态只允许白名单数据路径和 add/set/multiply/min/max。
- LAN 禁止执行任意 JavaScript。
- 自定义 ID 冲突必须拒绝并列出冲突项。
- Combat 回合推进由服务器扣除持续时间，到期自动停用。
- 内置预设至少包括隐身、灵体、定身、失能、强化、虚弱、中毒、燃烧、流血和目盲。

### 4.4 聊天框

- 聊天记录区域保持可见并正常滚动。
- 底部 composer 默认折叠，只显示“消息、伤害、恢复”三个模式按钮。
- 点击模式后才展开对应表单。
- 再次点击当前模式收起表单。
- 切换模式时只替换表单，不重建聊天记录。
- `Esc` 收起表单。
- 消息发送成功后清空输入但保持当前模式。
- 失败时保留输入并显示错误。
- 伤害/恢复显示当前选择数量；没有合法目标时禁用提交并解释原因。
- 收到新消息不得自动展开 composer。
- 聊天页未激活时只显示未读角标。
- composer 展开状态属于本地 UI 状态，不写入 World、不广播。

### 阶段验收

- 直线拖动、Ctrl/Cmd 分段、WASD 和群组移动均通过 Local/LAN 测试。
- 断线、拒绝和重复 ACK 不造成 Token 跳动或重复移动。
- Token、状态和聊天操作不触发整场景导入。
- 新 UI 在 390px 宽度可用。

---

## 第五阶段：黑暗、模糊感知与 Fog

### 5.1 感知矩阵

- `normal`：保留精确范围和模糊外圈。
- `dim` 且无低光视觉：精确范围归零，保留原模糊范围。
- `dark` 且无黑暗视觉：精确范围归零，保留原模糊范围。
- 低光/黑暗视觉按 Ruleset 返回精确和模糊范围。
- Token 明确范围允许超过 120 m。
- 历史探索不能把当前黑暗区域重新显示清楚。

### 5.2 模糊区域视觉

采用“较透明的低饱和滤镜”：

- 未探索：保持接近纯黑，初始遮罩约 `rgba(8,12,14,0.96)`。
- 已探索但当前不可感知：
  - 极暗地图记忆。
  - 饱和度目标约 20%。
  - 亮度目标约 30%。
- 当前模糊范围：
  - 遮罩透明度从当前约 `0.62` 降至初始目标 `0.34`。
  - 饱和度目标约 45%。
  - 亮度目标约 65%。
  - 玩家能辨认道路、房间和大型地形，但不能获得精确目标信息。
- 当前精确范围：100% 清晰。

滤镜参数集中为可调常量，并使用至少一张室内暗图和一张室外地图做视觉快照验收；不得散落硬编码。

### 5.3 模糊目标隐私

模糊范围中的敌方 Token 仅投影：

- 匿名轮廓。
- 大致体型。
- 5 米量化位置。
- session opaque ID。

禁止泄漏：

- 名称与头像。
- HP 和资源。
- Buff/Debuff。
- Actor system。
- controllerUserIds。
- 真实 ID。
- 精确坐标。
- 不可见/隐身状态的内部定义。

### 5.4 Fog 性能

- 使用视口裁剪、dirty region 和 RAF 合并。
- 地图平移/缩放只重绘当前视口。
- Token/Status/Chat operation 不得触发无关 Fog 全算。
- 保留 5 米探索存储和服务器探索权威。
- 不接受客户端直接上传探索格。
- 移动预览不永久写入探索；只在服务器确认的路径/位置后更新。

### 阶段验收

完成以下视觉矩阵：

```text
normal / dim / dark
× 无感官 / 低光 / 黑暗视觉
× 精确 / 模糊 / 不可见
× 未探索 / 已探索 / 当前可感知
```

同时验证：

- 黑暗无暗视角色只能获得模糊感知。
- 模糊区域可辨识地图结构但不清晰。
- AudienceProjection 零私密字段泄漏。
- 状态和聊天更新不重绘 Fog。

---

## 第六阶段：迁移、测试、文档与正式 Release

### 6.1 Schema 与迁移

- World Schema 保持 3。
- Operation Schema 升至 2。
- Status Schema 升至 4。
- Access Schema 升至 4。
- v3→v4 Status 迁移保留 Status ID、Effect ID、未知扩展字段和 Unlinked 实例隔离。
- Access 迁移保持原 none/observer/owner 不变，不自动提升权限。
- 迁移失败必须保留原文件、立即备份并给出可定位错误。

### 6.2 自动化测试

保留现有测试并新增：

- 公开怪物 Token 的合法投影回归测试。
- none/limited/observer/owner × Actor/Token 操作权限矩阵。
- precise/vague AudienceProjection 零泄漏。
- Protocol V2、changeSet、patch、revision、幂等、断线恢复。
- 普通 patch 不调用 `importState`。
- 直线拖动、Ctrl/Cmd 路径点、F/Alt+F、取消、群组移动。
- WASD 合并和逐段碰撞。
- Linked/Unlinked 状态隔离、批量 HUD 和持续时间。
- Token 配置权限、继承值、错误回滚和 390px 布局。
- 聊天 composer 折叠、模式切换、未读角标和失败保留输入。
- 完整感知矩阵和 Fog dirty-region。
- 500 Token LAN 性能基准。

执行：

```text
npm audit
npm audit --omit=dev
npm test
tracked JavaScript syntax check
npm run benchmark
npm run build
npm run check:bundle
npm run package:local-server
npm run check:package
Windows packaged Edge smoke
GM + 两个 Player 人工 LAN 验收
```

人工 LAN 必测：

1. GM 将怪物 Token 改为公开。
2. Player 打开 LIMITED 卡。
3. Player 尝试选择、查看、移动和修改该 Token。
4. GM 将 Player 加为 Token controller 后再次移动。
5. 两个 Player 同时移动各自 Token。
6. Ctrl 分段移动、状态切换、聊天和断线重连。
7. 暗图中分别验证普通视觉和黑暗视觉。

### 6.3 文档与版本

统一更新到 `2.3.0`：

- `package.json` 和 lockfile 顶层版本。
- HTML application-version 和启动标题。
- README 当前版本、包名、权限模型、移动操作和 LAN 架构。
- CHANGELOG 完整 v2.3.0 条目。
- 操作指南增加：
  - Token 新界面。
  - LIMITED/OBSERVER/OWNER。
  - Ctrl/Cmd 分段移动。
  - 状态 HUD 和自定义预设。
  - 聊天 composer。
  - 黑暗与模糊视野。
  - 升级和故障恢复。
- 开发说明增加 Operation 2、Status 4、Access 4、changeSet 和 AudienceProjection 契约。

### 6.4 Release

六阶段全部通过后：

1. 确认工作区干净、测试全绿、性能目标达成。
2. 合并 `codex/v2.3.0` 到 `main`。
3. 记录唯一 40 位 release commit。
4. 确认远程不存在冲突的 `v2.3.0` Tag 或 Release。
5. 从 release commit 创建并推送 `release-v2.3.0`。
6. 由发布工作流完成 Ubuntu 校验、Windows smoke、SHA-256 和正式 GitHub Release。
7. Release 只上传：
   - `RPGmap-v2.3.0.zip`
   - `RPGmap-v2.3.0.zip.sha256`
8. ZIP 内 `VERSION.json` 必须包含：
   - `version: 2.3.0`
   - `releaseTag: v2.3.0`
   - 完整 40 位 release commit
   - `worldSchema: 3`
   - `operationSchema: 2`
   - `statusSchema: 4`
   - `accessSchema: 4`
9. 重新下载资产，验证 checksum、包清单和 `/api/health`。
10. 确认 Release 不是 prerelease，Tag 指向 `main` 的 release commit。
11. 清理临时构建、解压、smoke 和性能探针产物。

---

## 明确不纳入 v2.3.0

- 完整 FVTT Document 系统复制。
- 独立 Audience DTO 协议重构；v2.3.0 先保证投影后的 World 结构合法。
- 可拖动多窗口角色卡和完整 Play/Edit 双模式。
- 完整墙体 LOS、门窗、动态光源和高度遮挡。
- Asset Manager、多 World、Compendium、外部包、骰子、Journal、声音和模块系统。
- 状态定义执行任意 JavaScript。

这些内容只进入 Future Roadmap，不创建空壳 API。

## 最终完成定义

只有同时满足以下条件才能发布 v2.3.0：

- 公开怪物 Token 投影合法，原联机报错彻底消失。
- 权限模型区分查看、有限查看、编辑和 Token 控制。
- 普通 LAN 操作不再传输或导入整份 World。
- 玩家端操作延迟和 500 Token 渲染达到性能目标。
- Ctrl/Cmd 分段移动恢复并通过服务端逐段验证。
- Token、状态和聊天界面达到新交互规范。
- 模糊区域更易辨识，同时保持敌方信息零泄漏。
- 所有迁移、权限、投影、断线和性能测试通过。
- 正式 `v2.3.0` Tag、GitHub Release、ZIP 和 SHA-256 均已实际创建并验证。
