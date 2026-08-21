# Changelog

RPGmap 使用语义化版本号。这里只记录已经形成版本节点的重要变化；更细的开发过程见 `文档/工作日志.md`。

## 1.4.1 — Candidate · 2026-08-21

V1.4.1 在 V1.4 Multiplayer V1 的共享 World 基础上加入持久 Player Identity、Actor Ownership、Server-authoritative Combat Turn Lock，并将发布包整理为便携的 `app/ + map/` 数据结构。当前在 Draft PR #8 进行实机验收，合并前 `main` 仍保持 V1.4.0。

### Portable Package / Map Root

- 发布包前端从 `public/` 整理为 `app/`。
- 所有默认可写跑团数据集中到 `map/`，不再使用多层 `data/worlds/default/` 作为新版本主存储。
- `map/world.json` 保存共享 World Snapshot 与 revision。
- `map/users.json` 保存持久 Player User、默认 Actor、Ownership 和凭证哈希。
- `map/uploads/` 与 `map/backups/` 跟随当前地图 / 跑团目录一起保存。
- 默认不需要 AppData、用户主目录或其他隐藏 User Data 位置来保存 RPGmap World / User。
- 新增 `portable-storage.mjs` 统一解析可写目录并管理兼容迁移。
- 如果新 `map/` 文件不存在，可从旧 `data/worlds/default/world.json` / `access.json` 自动复制迁移；旧文件保留不删除。
- 打包 CI 明确检查 `app/`、`map/`、`portable-storage.mjs`，并拒绝重新生成旧 `public/` / `data/` 发布布局。

### Player Identity / Users

- Player 首次使用 Join Code 进入时先成为 pending Session，不直接取得 World 写权限。
- GM 在“联机 / Users”面板批准玩家后，Server 创建当前 World 的持久 Player User。
- GM 可以提前预创建 User，并生成长期 Player Key 给指定玩家。
- Quick Tunnel 域名变化时，Player 可使用 Player Key 在新网址恢复原 User。
- 同一网址内浏览器保存 `userId + authToken` 以自动重连。
- Server 只保存 Browser Token 与 Player Key 的 SHA-256 哈希，不保存明文凭证。
- GM 可重新签发 Player Key；新 Key 会使旧 Key 和旧浏览器 Token 失效。

### Actor Ownership

- Actor 权限增加 `NONE / OBSERVER / OWNER`。
- GM 对全部 Actor 隐式拥有完整权限。
- 每个 Player 可以有一个默认角色，并可拥有多个 OWNER / OBSERVER Actor。
- 默认角色必须为 OWNER。
- Player 不能创建、删除或重新绑定 Actor / Token。
- Player 只能修改 OWNER Actor；越权 `world.push` 由 Server 返回 `world.denied` 并恢复最新 World。
- 客户端增加相同规则的 preflight；Server 仍是最终权限裁决者。

### Combat Turn Lock

- Combatant 加入 / 移除、先攻、拖动排序、开始 / 结束战斗、Round / Turn 推进均为 GM-only。
- Player 端 Combat Tracker 保持可查看，但管理控件直接禁用。
- `Combat.state === active` 时，Player 只能修改当前 Turn 对应且自己拥有 OWNER 的 Actor。
- 即使同一 Player 同时拥有多个角色，未轮到的其他 OWNER Actor 也会被锁定。
- Token Movement 在开始拖动和最终提交前都会检查 Ownership / Turn。

### Multiplayer UI

- 顶栏“联机”由简单登录状态升级为 Users / Players 面板。
- 显示在线 GM / Player、默认角色和 pending 玩家。
- GM 可批准首次加入、预创建 User、设置默认角色、配置 NONE / OBSERVER / OWNER、重发 Player Key、删除 User。
- Player 可查看自己的默认角色和 Ownership，并可在自己的 OWNER Actor 中修改默认角色。

### Validation

- 新增 Access Control 纯函数测试：凭证哈希、Player Key、Key rotation、Ownership 与 Turn Lock。
- 新增 Client Ownership preflight 测试。
- 新增 Portable Storage 测试：`map/` 路径、旧结构迁移、已有新数据优先。
- 真实 Node Server + WebSocket 测试验证 `map/world.json` / `map/users.json` 持久化。
- CI 执行 `npm test`、全部 JavaScript syntax check、Vite production build 和 V1.4.1 ZIP 组装。

## 1.4.0 — 2026-08-21

V1.4.0 正式加入 Multiplayer V1，使 RPGmap 从单机 / 局域网地图工具扩展为可通过 WebSocket 共享 World 的自托管 VTT，并提供 Windows 一键远程联机入口。

### Multiplayer Server / World Store

- `server.mjs` 新增原生 WebSocket `/ws`，不引入额外服务端运行依赖。
- 新增 `data/worlds/<world-id>/world.json`，保存共享 World Snapshot、revision 和更新时间。
- World 写入使用临时文件 + rename，Server 重启后可以恢复共享状态。
- 新增 `hello / welcome / presence / world.push / world.snapshot / world.conflict / world.request` 等协议消息。
- 客户端提交携带 `baseRevision`；版本冲突时返回 Server 最新 Snapshot，避免旧状态无条件覆盖新状态。
- `/api/health` 与 `/api/multiplayer` 提供当前 Multiplayer 状态；公网启动时包含 `publicUrl`。

### GM / Player

- 联机身份分为 `GM` 与 `Player`。
- 支持 `Join Code` 控制玩家加入，以及 `GM Secret` 授予 GM 身份。
- 修复公网模式下 GM Secret 已验证但仍被 Player Join Code 阻挡的问题。
- GM 与 Player 登录成功后统一退出联机遮罩层。
- V1.4 默认允许 Player 写共享 World，为 V1.4.1 的 Actor Ownership 奠定联机基础。

### Client World Sync

- 新增 `src/multiplayer/`，浏览器使用原生 WebSocket 连接当前 Host 的 `/ws`。
- HTTP 自动使用 `ws://`，HTTPS 自动使用 `wss://`。
- 第一阶段使用完整 World Snapshot 同步 Actor、Token、Health、Damage、Healing、Combat、Chat / Game Log 与 Scene 状态。
- Selection、Ruler、地图视角和其他瞬时 UI 状态不进入共享 World。

### Remote Internet Multiplayer

- 新增 `start-rpgmap-internet.bat` 一键公网联机入口。
- 自动检测本地或系统 PATH 中的 `cloudflared`；缺失时尝试官方 GitHub Release 下载或 `winget` 安装。
- 使用 Cloudflare Quick Tunnel 暴露 `http://127.0.0.1:30000`。
- Tunnel 强制使用 HTTP/2 over TCP。
- 自动解析 `https://*.trycloudflare.com` 地址并注入 Server。
- 自动生成 Player Join Code 与 GM Secret。

## 1.3.0 — 2026-08-21

- 完成 SelectionSystem 多选 / 框选。
- 完成 FVTT 风格 Ruler 与角色测距。
- 完成 CombatSystem、先攻表、轮次与回合推进。
- 完成 SimpleHP / WoundTrack、DamageSystem、HealingSystem 和 Token 生命条。
- 完成 Chat / Game Log，并整合战斗、伤害和恢复记录。
- 完善 XLSX Actor Sheet、Form 与不良状态。
- 提供真实本地 HTTP Server 和发布包启动脚本。

## 1.2.0 — 2026-08-21

- 建立 Actor / Token / Form EntitySystem。
- 完成 XLSX 角色导入。
- 重构 MovementSystem、Waypoint 与移动成本。
- 重构 AppShell UI 与 MapPackage 架构。

## 1.1.0 及更早

早期版本主要完成基础地图浏览、Marker / Token 原型、坐标与地图数据验证，为后续 VTT 架构重构提供基础。
