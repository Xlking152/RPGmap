# Changelog

## v2.3.2

- 新增轻量 Document Operation Protocol 3：Actor、Token、Scene、ChatMessage、Combat、Status 与 Fog 通过带 Document 地址、白名单 intent、precondition 和原子 batch 的统一入口提交。普通交互只返回 Audience-safe create/update/delete/move/append 差量，不再导入完整 World；旧 `performOperations()` 仅作为迁移中的兼容包装器。
- Local/LAN 会话携带协议版本、resume revision 与 Audience 指纹。服务端保留最近 256 次或 5 分钟安全提交，断线后优先补发缺失 Document commit，历史不足或权限身份改变时才回退 snapshot；未确认请求沿用 `operationId`，重复移动、聊天、伤害和状态不会再次执行。
- 服务端 AudienceProjection 使用写时复制投影与受影响 Document 快速路径。移动、普通聊天和非视野源的安全状态变更只更新相关 Token/Actor/Chat；权限、视野源、隐身、跨 Scene 等安全边界变化仍执行完整投影。500 Token、GM+6 Player 的本机回环基准综合 p95 从首轮约 `291 ms` 降至 `60 ms` 以下，普通请求/响应保持差量。
- Local Server 增加 `world.operations.ndjson` WAL：每条记录包含连续 revision、operationId、权威 patch、时间与 SHA-256 checksum，刷盘成功后才 ACK；尾部不完整记录可安全截断，中间损坏会停止加载并进入恢复流程。每 100 revision、60 秒或 8 MB 压缩为原子 `world.json`。
- Token 移动改为一次性 `token.movePath` Document 事务。单个和群组 Token 的所有 waypoint 由服务端逐段复验控制权、锁定、战斗回合、状态能力、边界与内置 MapPackage 碰撞；全局 revision 变化但目标起点未变时可安全 rebase，目标已移动则返回 `entity_conflict`。WASD 以 50 ms/最多 8 步合并且保留逐步路径。
- 恢复 FVTT 风格路径操作：普通拖放直线移动；Ctrl/Cmd 拖放进入规划但不把释放点误记为 waypoint；Ctrl/Cmd+点击或 `F` 添加点，右键或 `Alt+F` 撤销，普通点击或 `Enter` 提交，`Esc` 取消。拖动、WASD 与路径规划立即显示本地 visual state，确认后无跳变衔接，拒绝或断线时平滑回滚。
- Token 图片、幽灵和摘要头像禁用浏览器原生拖图，Pointer 生命周期覆盖 pointerup、pointercancel、窗口失焦与销毁。Token Renderer、状态徽章、选择摘要和 Actor Sheet Part 在同一 RAF 内按 ID 合并更新，普通 Document 变更不替换整张角色卡或整场 Token DOM。
- Fog 拆分为静态探索层和动态感知层。模糊范围取消灰度和重度压暗，仅叠加 `rgba(218,226,228,0.20)` 冷灰透明薄雾；未探索区域仍接近纯黑，历史探索保持极暗。预测位置可以驱动临时视野，但永久探索只接受服务器确认路径，匿名轮廓与零泄漏规则不变。
- Windows 发布 smoke 同时覆盖 Microsoft Edge 与 Google Chrome，并使用隔离临时浏览器配置。README 增加 Radmin VPN 的 `26.x.x.x:30000`、Direct/Relay、可信网卡、防火墙放行、Ping 和同版本要求。
- 应用版本升至 `2.3.2`。World schema 保持 `3`，operation schema 升至 `3`，Status schema 与 Access schema 保持 `4`，Infinite Horror Ruleset `1.0.0` 和 Lanzhou MapPackage `1.0.5` 不变。

## v2.3.1

- 收口 v2.3.0 发布后的角色/怪物卡权限修复（起点 `15cda37`）：Actor Sheet V3 正式接入运行时组合入口，移除 `<pre>` 占位 renderer 与 V2 DOM decorator；角色卡继续支持多窗口、Scene+Token 独立身份、拖动缩放、焦点顺序、本地几何记忆和窄屏单列布局。
- 卡片上下文显式使用 NONE/LIMITED/OBSERVER/OWNER/GM 权限。OWNER/GM 的 Play 模式只处理 HP、资源、检定、战斗与状态等运行数据，Edit 模式才编辑名称、头像、类型、队伍、形态等结构；OBSERVER 完整只读，LIMITED 只进入专用最小卡，Token 控制权仍单独按实例规则判定。
- Actor 增加向后兼容的 `publicProfile`：GM 可维护公共简介、外观、最多 20 条已知情报和允许公开的状态定义，并在模板卡预览 LIMITED 结果。`actor.publicProfile.update` 由服务器权威标准化、校验状态白名单并通过 Actor changeSet 增量同步；旧 Actor 默认为空，不会隐式公开 Ruleset 私有简介。
- LIMITED AudienceProjection 只下发最小 Actor、规范化公共档案和当前 Token 的安全 `publicStatuses`。状态摘要仅包含名称、图标、颜色、分类和层数；不包含真实状态 ID、实例 ID、备注、持续时间、来源、能力、changes、生命、资源或权限。Linked 状态正常同步，Unlinked 怪物实例按各自 Synthetic Actor 隔离。
- Actor 权限编辑改用 `api.multiplayer.updateActorOwnership()` 原子批量请求，服务端验证 GM、Actor、User、Access revision 与默认角色 OWNER 约束，并返回逐项结果；移除通过隐藏旧管理表单模拟提交的路径。
- 应用版本升至 `2.3.1`。World schema 保持 `3`，operation schema 保持 `2`，Status schema 与 Access schema 保持 `4`，Infinite Horror Ruleset `1.0.0` 和 Lanzhou MapPackage `1.0.5` 不变。

## v2.3.0

- Operation Protocol 升至 schema `2`：Token、Actor、Status、Chat、Health、Combat、Feature 与 Fog 统一使用 `world.operation`，提交消息包含连续 revision、Audience-safe patch、细粒度 `changeSet` 和裁剪后的 results。完整 snapshot 仅用于启动、显式恢复/导入、revision 缺口、Audience 身份变化和跨 MapPackage Scene。
- Access schema 升至 `4`，Actor 权限明确区分 NONE、LIMITED、OBSERVER 与 OWNER；Token 可见性、Actor 查看/编辑、实例控制权和视野授权分别判断。公开怪物使用合法 LIMITED 投影，模糊敌影使用每 Session opaque ID，不泄漏真实 ID、精确坐标或私有 Actor/Token 数据。
- Status schema 升至 `4`：定义增加 buff/debuff/neutral 分类与默认持续时间，实例保存 turns/rounds 剩余时间；服务器权威 `combat.advance` 原子推进战斗和状态计时，到期状态自动停用。右键 Token 或点击徽章可打开快捷 HUD，自定义状态导入采用全量校验和冲突拒绝。
- Token 实例页改为基础、视野、权限、高级四区，支持精确/模糊范围分别继承 Ruleset、按显示名选择控制者/授权用户、字段级 pending/confirmed/error 和危险操作确认；390px 布局无横向溢出。
- 恢复完整分段移动：普通拖放保持直线，`Ctrl`/`Cmd` 进入 waypoint 规划，支持点击、`F`、`Alt+F`、右键、`Enter` 与 `Esc`；服务器逐段复验碰撞、控制权、Token lock、Combat 回合和群组原子性。
- 聊天 composer 默认折叠为消息、伤害、恢复三种模式，切换不重建日志；失败保留输入，未激活标签显示未读角标。普通 Player 只能提交文本，消息 ID、时间与发送者由服务器生成。
- Fog 使用独立去饱和与暗度 Canvas：normal/dim/dark 按感官能力区分精确、模糊、历史探索和未探索区域。dirty bounds 与 RAF 合并避免 Chat、普通 Status 和非视觉属性更新触发全量 Fog 重绘。
- Reducer 改为 batch 单次克隆和细粒度 copy-on-write，Token/状态/聊天/生命 UI 使用 keyed 更新；每个 LAN Session 缓存 AudienceProjection，普通提交从裁剪后的 patch 生成安全 changeSet。Node 22.12 固定 fixture 的三类 operation 中位数均降低超过 25%，三会话 LAN 聚合 p95 降低 31.5%。
- World Manager 首屏继续保持不增长；兰州地图 SVG 与数据改为选择地图后才请求的编译资源，重型角色卡与状态工具首次打开才加载。相对 v2.2.6，总 JS gzip 从 `256,689 B` 降至不超过 `251,555 B`。
- 应用版本升至 `2.3.0`。World schema 保持 `3`，Infinite Horror Ruleset 保持 `1.0.0`，Lanzhou MapPackage 数据版本保持 `1.0.5`；正式包记录 operation `2`、status `4` 和 access `4`。

## v2.2.2

- 实时视野改为保存服务器确认的视野源 Token ID，并在每次渲染与 World commit 后从当前 Scene 解析最新权威坐标；Token 移动、重连、Scene 切换、删除、进入 Feature 或失去控制权时不再残留旧位置视野。
- 离线与 Local/LAN 迷雾探索统一使用模糊侦测范围，移动按起终点连续 sweep；精确范围外但模糊范围内的实际可见区域也会永久写入 Scene Fog，离开后继续显示淡色记忆迷雾，只有 GM 的重新隐藏或重置探索会清除。
- Actor 正式增加 `monster` 类型。怪物、NPC 与召唤物均强制使用独立 Token/`actorDelta`；旧 `npc` 不迁移，仍保持 NPC，`summon/other` 继续保留。
- 指示物库将模板拆分为“怪物”“NPC”“其他模板”三块；怪物与 NPC 各有独立 XLSX 导入入口，新建模板自动分类，同名追加形态不会改写现有 Actor 类型。
- 应用版本升至 `2.2.2`；World schema 保持 `3`，operation schema 保持 `1`，Infinite Horror Ruleset 与 Lanzhou MapPackage 数据版本不变。

## v2.2.1

- Token 移动预览与提交共用结构化校验，并增加 WASD 单格移动；Local/LAN 仍由服务器复验控制权、战斗回合、状态和碰撞。未配置的简单 Health `0/0` 不再被误判为耗尽或死亡。
- Infinite Horror 增加精确/模糊侦测范围、感官能力、环境亮度降级与 Token 实例覆盖；AudienceProjection 只向模糊范围内的敌对 Token 下发量化位置的匿名轮廓，不泄露 Actor/Token ID、名称、图片、Health、Effect 或其他私有数据。
- XLSX 导入器按规则表标签读取侦测数值与布尔感官，支持缓存公式值、中英单位、多种勾选形式、工作表容错和结构化警告；新增 `npm run test:xlsx` 生产导入校验命令。
- 角色库只显示 PC，“其他指示物”管理 NPC/召唤物/其他模板与当前 Scene 实例；每个实例使用稳定编号名称，GM 可在抽屉中批量施加/移除状态。
- GM 专属与隐身 Token 在 GM 视角显示独立半透明徽章；选中摘要固定在地图容器右下角。移除旧“图层”面板并始终显示网格，侧栏收敛为四个等宽主标签。
- 应用版本升至 `2.2.1`；World schema 保持 `3`，operation schema 保持 `1`，Infinite Horror Ruleset 与 Lanzhou MapPackage 数据版本不变。

## v2.2.0

- World schema 升级到 `3`，旧 schema 2 World 在写回前备份并幂等迁移；Actor 增加 `pc / npc / summon / other` 分类与队伍，Token 增加控制者、可见性和视野配置，Scene 增加 5 米网格迷雾数据。operation schema 保持 `1`。
- Actor 成为可复用模板；NPC 与召唤物 Token 强制使用独立实例，当前生命、B/L/A 伤势、状态、资源和形态只写入该 Token 的 `actorDelta`。模板的静态属性与生命上限仍动态继承，降低上限时仅截断超出的实例当前生命。
- 新增实例化放置、运行时操作、旧共享 Token 原子拆分、Token 访问控制、Marker 和 Fog operation；Health、Status、Effect、聊天伤害、Combat 与批量结算统一传递 `tokenId`，拒绝含义不明的 NPC/召唤物 `actorId` 运行时写入。
- Local/LAN 新增逐会话 `AudienceProjection`。服务器保留完整权威 World，并按 GM、控制权、队伍、指定用户、可见性、隐身和当前实时视野裁剪快照、补丁、Combat、Chat、Effect、Status、Access 目录及查询结果；隐藏目标的拒绝或冲突不会携带 canonical World。
- Infinite Horror 新增通用隐身能力和视野描述：默认范围为 `30 + 感知 × 10m`，缺失感知时 `40m`，限制在 `20–120m`。玩家每次只使用一个受控 Token 的实时圆形视野，已探索区域按 `sceneId + partyId` 持久化共享，GM 可重置或重新隐藏。
- 新增轻量“其他指示物”、模板卡/实例卡标识、Token 控制与可见性编辑、迷雾控制、GM 全图/Token 视角切换，以及右下角稳定尺寸的圆形 Token 摘要；桌面和 390px 移动端均通过无溢出验证。
- World Manager 改用轻量 Ruleset 元数据，选择 World 后才加载完整 Ruleset 与地图 Runtime。相对正式 v2.1.6 基线，首屏 JS gzip 降低约 `75%`，总 JS gzip 增长约 `6.6%`，CSS gzip 不变，均通过 v2.2.0 bundle budget。
- Windows packaged-server smoke 现在覆盖 GM/Player 身份授权、逐用户投影、视野来源、迷雾持久化、隐藏目标拒绝零泄漏、动态地图与真实 Canvas 遮罩；正式包 `VERSION.json` 明确校验应用版本、完整 commit、World schema `3` 与 operation schema `1`。

## v2.1.6

- 新增 FVTT 风格的 Group Token Movement：拖动多选集合中的任意已选 Token 时保留 selection，并将被拖 Token 作为 leader；其他成员按开始规划时的相对 `dx/dy` 保持队形。
- 群组规划只绘制 leader 路线，但终点为每个成员显示独立 Token 幻影；确认后 Renderer 为每个成员使用平移后的 waypoint 队列进行同步平滑移动，不产生中间 World 坐标写入。
- 每个成员都使用自己的直径、高度和 Status collision context 独立校验整条路线；任意成员受阻、越界、被锁定或失去移动能力时，整个 formation 都视为无效。
- 最终提交前重新读取 canonical Scene Token 并重新校验全部成员；全部通过后只执行一次 `movement:group` canonical World commit，同时更新全部最终 `x/y` 和 Token-bound AoE anchor，保证全有或全无。
- Group Movement 只是一次 transient movement context，不新增 `TokenGroup` / Formation 文档或第二套持久化权威；World schema 仍为 `2`，operation schema 仍为 `1`。
- 非战斗 Player 可群移自己拥有 OWNER 权限的 Token；Active Combat 中普通 Player 一次只能移动一个 Scene Token，即使多个 Token 共享当前 Actor 也不能借群移绕过 Combat Turn Lock；GM 保持完整权限。
- bundle budget 基线滚动到正式 v2.1.5 release commit `d31840247fba4d850f6f47054588686d747c60dd`：已达成的首屏 JS 体积不允许回退，总 JS/CSS 相对正式基线最多增长 5%。
- 应用版本提升到 `2.1.6`；Infinite Horror Ruleset 继续为 `1.0.0`，Lanzhou MapPackage 数据版本继续为 `1.0.5`，Character Runtime 继续保持退役。

## v2.1.5

- 新增 Combat Turn Origin Ghost：每回合开始时把当前 combatant 的 canonical Scene Token `x/y/elevationFt` 存入共享 Combat State；Token 离开起点后 Renderer 在原位显示半透明不可交互的起点幻影。
- 起点幻影不是第二个 Scene Token，不进入 Selection、碰撞、AoE、伤害或 World 写入；刷新和 Local/LAN 重连后可由共享 Combat State 重建。
- 下一回合会替换旧起点，结束战斗会清除；Token 回到完全相同的起点时幻影隐藏，再次离开仍使用本回合同一 origin。
- Combat preference schema 从 `1` 提升到 `2` 并自动向前归一化；World schema `2`、operation schema `1`、Ruleset 和 MapPackage 数据版本不变。

## v2.1.4

- 恢复更接近 v1.6.3 的 Token 移动观感：规划时显示终点 Token 幻影，确认后 canonical World 仍只提交最终位置，Renderer 再沿已确认路径执行平滑插值。
- 多 waypoint 会按路径段顺序显示，视觉动画不会产生中间 World 写入；`prefers-reduced-motion` 继续受支持。
- Token 移动期间临时隐藏独立 Health/Status overlay，避免覆盖层先跳到服务器终点，动画结束后恢复。
- Token 上方标签改为“高度 → 名称”，生命条继续位于 Token 下方。

## v2.1.3

- 修复 Local/LAN 普通聊天发送者看不到自己消息的问题：`chat.append` / `chat.clear` 属于服务器独占写入，即使快照来自当前 Session 也会重新载入权威 World；普通自己发出的 World operation 仍避免重复 import。
- 聊天发送请求被 WebSocket 接受后才清空输入并重新 focus；连接不可用时保留原输入并给出错误提示。
- 删除顶部重复的“检查地物”按钮；“选择”模式继续同时负责 Token 选择和建筑、城墙、城门、桥梁等 Feature 的直接检查，Feature Interaction / 门开关逻辑保持不变。
- 修复 Scene Token 绑定范围无法“预览影响 / 应用破坏”：实时 Scene Area 继续保存 canonical Token anchor，破坏计算只接收当前已解析坐标的一次性 free geometry snapshot，历史 damage event 不会随着 Token 后续移动而漂移。
- 修复切换范围绑定对象时 fallback origin 仍按旧 anchor 计算的问题，新 Token/Marker 绑定会立即使用新对象当前位置。
- 新增 v2.1.3 聊天、选择/检查和 Token-bound AoE 回归测试；World schema 2、operation schema 1、Infinite Horror Ruleset `1.0.0` 与 Lanzhou MapPackage 数据版本 `1.0.5` 均保持不变。

## v2.1.2

- 在保留 World V2 / Scene Token / Ruleset 架构的前提下恢复 v1.6.3 的 Token 实时拖动路线、waypoint、滚轮吸附和阻挡反馈。
- 恢复圆形、扇形、矩形范围的地图拖拽手柄，同时保持 drag 过程本地预览、dragend 后才提交 World。
- Token 名称固定到 Token 上方，HP bar 保持下方，避免尺寸变化后重叠。
- 恢复选择/浏览状态下直接点击 inspectable Feature 打开地物详情；门继续使用现有通用 FeatureControlLayer 直接开关。
- 扩展 Character Runtime retirement 测试覆盖新的 movement / inspector / area adapter；不重新引入旧 Character Runtime。

## v2.1.1

- 修复地图 Runtime 在 Leaflet 设置中心和缩放前注册 Feature 控件，导致启动抛出 `Set map center and zoom first.` 并显示空白地图的问题。
- Feature 控件现在只在地图 ready 后计算屏幕坐标；Runtime 在注册任何工具前先建立初始视野。
- Windows packaged-server smoke 现在要求地图已有中心/缩放、兰州基础 SVG 已挂载且具有非零尺寸和地图图片，并捕获浏览器 `console.error`。
- 新增地图初始化顺序与 Feature 控件 ready 边界测试；World schema 2、operation schema 1、Infinite Horror Ruleset `1.0.0` 与 MapPackage 数据版本 `1.0.5` 均保持不变。

## v2.1.0

- `Scene.featureStates` 成为门、机关、阻挡高度与扩展状态的唯一持久化权威；旧全局 Feature State 只在迁移入口读取，冲突会停止迁移而不覆盖原存档。
- World Manager 首屏与地图 Runtime 分离；Leaflet、地图 CSS、兰州逻辑和 29 张 WebP 在选择 World/Scene 后动态加载，首屏静态 JS gzip 相对 PR #21 基线降低 78.75%。
- Built-in Registry 在地图未加载时即可列出兰州城的 id、version 与 title；MapPackage 数据版本仍为 `1.0.5`。
- Windows 发布包改为严格白名单，不再复制 raw `reference/`，统一 verifier 校验目录、版本、commit、Vite manifest、兰州资源、ZIP SHA-256 与 30% 体积门槛。
- Windows smoke 现在验证 BAT、`/api/health`、World Manager、创建 World、动态 Runtime 与全部兰州 WebP；candidate/release 统一运行 audit、tracked syntax、bundle budget 和 package verifier。
- 应用版本提升到 `2.1.0`；World schema 2、operation schema 1、Infinite Horror Ruleset `1.0.0` 和现有存档语义保持不变。

## v2.0.0

- World schema 2 成为唯一持久化权威，Actor、Scene、Token、Combat、Effect 与状态通过通用 World operation schema 1 原子提交；完整 World 只保留在初始化、显式导入和恢复边界。
- Actor 使用稳定通用外壳，规则数据统一进入 `actor.system`；Ruleset Contract 负责默认值、旧存档迁移、规范化、验证、派生、展示、属性路径和运行时操作。
- Infinite Horror 的 Health、B/L/A、状态与角色形态语义已移入规则包，同时兼容旧 SaveV1/V2、旧 Actor 字段和 Synthetic Actor Delta，不丢失角色、Token、伤势、状态或自定义定义。
- Runtime、角色卡、Token、聊天、导入器、Effect 与多人服务器改为使用显式 Ruleset 上下文和通用 Actor/Ruleset 接口；最小假 Ruleset 与源码边界测试防止 Core 注入 Infinite Horror 语义。
- Local/LAN 使用服务器权威、带 revision 与幂等 operation ID 的通用操作协议；Player ownership、Combat 回合锁和 GM-only 状态权限继续由服务器验证。
- 应用发行版本提升到 `2.0.0`；World schema 保持 2、operation schema 保持 1、`world.ruleset.id` 保持 `infinite-horror`，Infinite Horror Ruleset 版本保持 `1.0.0`。

## v1.7.0

- Entity System 升级为 schema v3：World 保存自定义状态定义，Actor 状态跨形态和 Token 生效，Token 状态只影响单个地图实例；旧 effects 会确定性迁移。
- 角色卡增加独立“状态”页、标题状态带和 Token 地图徽章；GM 可创建定义、施加、移除、调层、启停和批量操作，OWNER / OBSERVER 保持只读。
- 首批机械状态包含“灵体”“定身”“失能”；昏迷、死亡和 B/L/A 伤势徽章由生命系统只读派生，恢复后立即解除对应限制。
- “灵体”只绕过 `structure` 碰撞组，仍受水域、弹坑、地图边界、Token 尺寸和高度规则约束；定身、失能、昏迷和死亡会在规划与提交两个阶段阻止移动或交互。
- Feature Capability 支持结构化状态前置条件和成功副作用；Feature 状态、角色位置与状态变化在同一次 World 提交中原子完成，失败或取消不会留下部分结果。
- 局域网新增服务器权威 `status.apply/remove/setStacks/batch/definition.*` 操作；使用 `operationId` 去重，批量操作全成全败，并在 schema 校验、备份和原子写盘成功后才确认及广播。
- Player 无法通过伪造状态消息或 `world.push` 改写状态定义及 Actor / Token effects；断线、权限下降或写盘失败会清理待提交状态和移动预览，并以服务器 World 恢复界面。

## v1.6.3

- 修复“放置 Token”时角色卡遮罩拦截地图的问题，提供可取消的放置 HUD。
- 联机服务端现在验证 World 结构和重复 ID、要求 GM Secret、拒绝跨站 WebSocket，并在写盘成功后才广播 revision。
- World/User 写入保留滚动备份；损坏存档会隔离并停止启动，不再静默清空。
- Windows 发布仅支持 Local/LAN；移除 Quick Tunnel、cloudflared 和 shell 启动说明。
- Token 移动改为 1m 稀疏分块直线碰撞检测：受阻立即标红，不再自动绕行或运行 A*。
- Token 支持 GM 专用的 1 / 5 / 10 / 20m 直径；尺寸、血条、预览与路线宽度同步缩放。
- 加入 Worker 硬时限回归，覆盖旧浮点遍历卡死坐标、长线、障碍和角点；连续拖拽复用分块占用缓存。
- 修复局域网中“进入战斗后先攻表立即消失”：战斗状态在战斗日志前同步提交给服务器，不再触发整份 World 导入。
- 修复角色血量/伤势变更的即时保存与同步：生命值、资源调整会立即写入本地状态并推送到局域网服务器，同时刷新角色卡与地图生命条。
- 战斗流程会等待关联 World 写入确认后再追加日志，修复连续点击“下一回合”时 Player 回合被回滚，以及“结束战斗”无法清空先攻表的问题。
- 当前回合以 Token 的实时 Actor 绑定为准，兼容旧先攻记录缺失或过期 actorId 的 Player 控制权。
- 清空共享聊天只删除聊天日志；当前战斗、B/L/A 伤势和恢复结果保持不变。
- 角色卡伤势生命槽新增 B / L / A 直接编辑；Player 仅可在自己当前回合编辑自己的角色，恢复会明确提示没有对应伤势或目标已死亡。
- 收敛用户文档为 README、操作指南、开发说明、未来规划和变更日志；移除过期工作日志与重复联机测试/使用说明。
- 发布包随附 `docs/OPERATION-GUIDE.md`，覆盖 Local/LAN 启动、Player 审批、权限、Token、移动、战斗、B/L/A、备份与排障。

RPGmap 使用语义化版本号；详细提交历史请通过 Git 查看。历史条目可能记录已移除的 Internet/Public 功能，不代表当前支持范围。

## 1.5.5 — Candidate · 2026-08-23

V1.5.5 将服务器 World 设为本地启动时的唯一状态来源，并完成了角色卡规范化模块的接入。

### Token / Startup Stability

- 在本地 RPGmap Server 模式下，浏览器启动时不再读取历史 `localStorage` World；客户端会在检测到 `/api/health` 后使用内存存储，随后以 `map/world.json` 的服务器快照为准。
- 自动 GM 连接前会让地图完成首帧绘制，避免连接与完整 World 导入抢占启动渲染。
- 空白、缺字段或结构异常的角色卡会在创建 Actor 前补齐安全默认值，防止 `undefined` 进入 Token 绑定与渲染链路。
- 新增空角色卡回归测试，覆盖 Actor / Form / Token 所需的默认数据。

## 1.5.4 — Candidate · 2026-08-22

V1.5.4 继续收口单入口 Launcher 的主机体验，不改变 MapPackage / Feature / Elevation / Navigation 数据模型。

### Startup / Multiplayer UX

- Local/LAN 与 Internet/Public 两种模式都会生成并显示 Join Code（房间号）与 GM Secret（GM 密码）。
- READY 信息集中显示本机地址、可用 LAN 地址、Internet 模式的 Cloudflare Public URL、Join Code 与 GM Secret。
- Internet 模式下主机不再通过 Public URL 访问自己的地图，而是直接打开 `127.0.0.1`，减少 Tunnel 往返和公网波动对主机加载的影响。
- Launcher 打开的 localhost URL 使用 hash 携带一次性 GM bootstrap；Client 读取后立即清除 hash，并自动以 GM 身份连接。
- GM bootstrap 只允许 localhost / 127.0.0.1 消费，不把 GM Secret 放进玩家使用的 Public URL 或普通 HTTP 查询参数。
- LAN Player 现在同样使用 Join Code 进入房间，使 Local/LAN 与 Internet/Public 的加入流程保持一致。

### CI

- Candidate workflow 名称改为版本无关的 `Build RPGmap Candidate`，实际 ZIP / VERSION.json 继续从 `package.json` 动态读取版本。
- Windows BAT smoke 额外验证 Local/LAN Server 已启用 Join Code。

## 1.5.3 — Candidate · 2026-08-22

V1.5.3 在 V1.5.2 端口互斥修复基础上进一步收口启动架构，不改变 MapPackage、Feature Interaction、Elevation 或 Navigation 数据模型。

### Single-entry launcher

- Windows 发布包只保留一个 `start-rpgmap.bat`。
- 双击后选择 `Local / LAN` 或 `Internet / Public`；也支持 `start-rpgmap.bat local|internet`。
- 新增统一 `launcher.mjs`，集中负责端口检查、Server 启动、`/api/health` READY 等待、浏览器打开、Internet Tunnel 和凭据生成。
- 删除 `local-launcher.mjs`、`internet-launcher.mjs`、`launcher-guard.mjs`，避免多套启动逻辑分叉。
- 删除 `start-rpgmap-internet.bat`、`setup-cloudflared.bat`、`run-rpgmap-public-server.bat`。
- Internet 模式自动查找 `cloudflared`；Windows 缺少时自动尝试官方下载，失败后尝试 Winget。
- Internet 模式不再额外打开 Multiplayer Info 命令行窗口，Local / Network / Public / Join Code / GM Secret 统一打印在当前 Launcher 窗口。

### Packaging / CI

- Candidate ZIP 根目录强制只能存在一个 Windows BAT：`start-rpgmap.bat`。
- CI 明确禁止旧 Split Launcher / Setup / Public Server BAT 重新进入源码和安装包。
- Windows smoke 改为执行 `start-rpgmap.bat local`，验证单入口 Launcher 能启动 `publicMode=false` Runtime。
- Linux no-reference Runtime、source separation、Node tests、syntax 与 Vite build 验证继续保留。

## 1.5.2 — Candidate · 2026-08-22

V1.5.2 修复 V1.5.1 人工验收中发现的 Local/LAN 与 Internet 启动生命周期冲突风险，不改变 MapPackage、Feature Interaction 或 Elevation 数据模型。

### Local / LAN startup

- 新增 `local-launcher.mjs`，本地入口不再先打开浏览器再启动 Server。
- 本地启动顺序改为：端口检查 → 启动 Server → `/api/health` READY → 打开 `127.0.0.1`。
- 本地启动显式清除 Public URL / Join Code / GM Secret，并强制 `RPGMAP_PUBLIC=0`，避免继承公网模式环境。
- `start-rpgmap.bat` 与 `start-rpgmap.sh` 统一通过 guarded local launcher 启动。

### Local / Internet mutual exclusion

- 新增 `launcher-guard.mjs` 检查 30000 端口占用。
- 若已有 RPGmap Local/LAN 或 Internet/Public Server，占用信息会被识别并直接报错，不再继续创建第二个 Server。
- 若端口被其他程序占用，也会给出明确错误。
- Internet launcher 在创建 Quick Tunnel 前先检查本地 origin 端口，避免等到 Tunnel 创建后才发现 Server 无法绑定。
- Local/LAN 与 Internet 是两种互斥启动方式；Internet 模式本身仍同时提供 Local、Network 与 Public URL，不需要再额外启动本地 Server。

### Validation

- 新增 launcher port-guard 自动测试。
- Windows package smoke 额外确认 `start-rpgmap.bat` 启动的是 `publicMode=false` 的 Local/LAN Server。
- Package 继续执行 Node、syntax、source separation、Vite build、Linux no-reference Runtime 与 Windows BAT no-reference Runtime 验证。

## 1.5.1 — Candidate · 2026-08-22

V1.5.1 是 V1.5.0 MapPackage / Feature Interaction / Elevation Candidate 的人工验收修订版，保持 V1.5 架构边界不变。

### Token UI / Elevation

- Token 名称固定在正上方。
- HealthSystem 保持唯一 HP 条并放在 Token 下方。
- `elevationFt` 标签移到 Token 右上角，避免与名称 / 血条冲突。
- Character Marker 直接绑定 `contextmenu`，同时保留 DOM capture 与 Map fallback；右键高度 HUD 不再依赖某一次 DOM 扫描时序。
- 高度 HUD 保持直接输入与 `-5 / +5 ft` 调整。

### Packaging / Validation

- Package version 更新为 `1.5.1`。
- Windows package smoke 使用 Linux package job 输出的实际版本，不再写死 `1.5.0`。
- `VERSION.json`、归档目录、ZIP 与 Artifact 的版本一致性继续由 CI 验证。
- 继续执行 Node、JavaScript syntax、源码独立性、Vite build、Linux no-reference Runtime、Windows BAT no-reference Runtime 全链路验证。

## 1.5.0 — Candidate · 2026-08-22

V1.5.0 从 V1.4.1 已验证的 Multiplayer / User / Ownership / Portable Runtime 基线上重新建立地图框架，目标是让“换地图”只替换 MapPackage，不复制 Damage / Movement / Scene / Multiplayer 逻辑。

### MapPackage Framework

- 新增 `src/map-package/contract.js`。
- MapPackage 进入 Engine 前统一验证 ID、Version、尺寸、SVG Renderer、Feature ID、Layer Plan。
- 增加 MapPackage API V1 与逻辑 Layer Role：`base / terrain / liquid / structure / special / destructible / labels`。
- Feature 归一出 `inspectable / interactive / enterable / destructible` Capability。
- 主入口 `src/main.js` 不再直接 import 兰州城代码与 Generated Art，只依赖 `createDefaultMapPackage()`。

### Lanzhou Reference Map

兰州城实现从 Core 目录实际迁移到：

```text
reference/maps/lanzhou/
├─ manifest.js
├─ package.js
├─ capabilities.js
├─ assets.js
├─ presentation.js
├─ assets/
├─ index.js
└─ README.md
```

职责：

- `manifest.js`：Map ID / Layer Plan；
- `package.js`：兰州专属 Feature / Navigation / SVG；
- `assets.js`：素材绑定；
- `presentation.js`：兰州专属展示处理；
- `index.js`：MapPackage 组装。

旧 `src/maps/lanzhou.js` 与 `src/maps/presentation-cleanup.js` 仅保留兼容 re-export，实际地图源码不再属于 Core。

### Minimal Reference Map

- 新增 `reference/maps/minimal/`。
- 仅包含 Base / Terrain / Liquid / Special / Destructible / Labels、一栋木屋和一堵墙。
- 自动测试将 Minimal 地图交给与兰州相同的 `createDamagePreview / commitDamageEvent / deriveSceneState`。
- 测试要求 `demo-house` 正常进入 destroyed Scene State，证明可破坏逻辑属于通用 Core。

### DIY Map Documentation

新增 `reference/README.md`，记录：

- MapPackage / Core / Scene Instance / World 四层职责；
- Reference Map 目录样式；
- Layer Plan；
- Feature + Capability；
- 可破坏地图边界；
- 新地图 DIY 流程；
- 禁止重新引入外部 `maps/` 双 Source of Truth、Launcher 文件解析、Junction 等 V1.4.2/V1.4.3 实验模式。

### Runtime Model

V1.5.0 **不改变** V1.4.1 已验证的稳定 Runtime：

```text
Reference MapPackage source
        ↓ Vite build
app/index.html
        ↓
server.mjs
        ↓
Browser
```

- 当前默认兰州地图在 build 时被打入 `app/index.html`。
- `reference/` 是开发 / DIY 参考，不是 Server Runtime 数据源。
- Server 不扫描 `reference/`，不创建根 `maps/`，不创建 Junction。
- World/User 仍沿用 `map/world.json` 与 `map/users.json`；此次故意不同时做 Storage Migration。

### CI Validation

V1.5.0 CI 增加：

- 兰州源码与素材必须真实位于 `reference/maps/lanzhou/`；
- `src/assets/generated` 必须不存在；
- `src/main.js` 不允许直接出现 Lanzhou / generated asset 引用；
- production build 必须包含默认兰州 Map ID；
- 打包后完整复制 Runtime 并删除测试副本中的整个 `reference/`；
- 删除后重新启动 `server.mjs`，`/api/health` 和 `/` 仍必须成功；
- 最终 ZIP 同时包含完整 `app/` Runtime 和 `reference/` DIY 参考。

## 1.4.1 — Candidate · 2026-08-21

- Persistent Player User / Player Key；
- Actor Ownership：NONE / OBSERVER / OWNER；
- Default Actor；
- Server-authoritative Ownership 校验；
- Combat Turn Lock；
- Client Ownership preflight；
- `app/ + map/` 便携 Runtime；
- `map/world.json` / `map/users.json`；
- Quick Tunnel 身份恢复与旧 `data/worlds/default/` 兼容迁移。

## 1.4.0 — 2026-08-21

- Multiplayer V1；
- 原生 WebSocket `/ws`；
- World Snapshot + revision / baseRevision；
- GM / Player；
- Join Code / GM Secret；
- Cloudflare Quick Tunnel。

## 1.3.0 — 2026-08-21

- Selection / Measurement；
- Combat；
- Health / Damage / Healing；
- Chat / Game Log；
- Actor XLSX / Form；
- 本地 HTTP Server。

## 1.2.0 — 2026-08-21

- Actor / Token / Form EntitySystem；
- XLSX 角色导入；
- Movement / Waypoint / A*；
- AppShell；
- 初版 MapPackage。

## 1.1.0 及更早

早期版本完成基础地图浏览、Marker / Token 原型和地图数据验证。
