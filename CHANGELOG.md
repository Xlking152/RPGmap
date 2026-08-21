# Changelog

RPGmap 使用语义化版本号。这里只记录已经形成版本节点的重要变化；更细的开发过程见 `文档/工作日志.md`。

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
- GM 与 Player 登录成功后统一退出联机遮罩层，修复“已显示在线但仍卡在登录界面”的问题。
- 当前 V1.4 默认允许 Player 写共享 World，优先满足共同移动 Token、战斗和状态更新；Actor Ownership 后续扩展。

### Client World Sync

- 新增 `src/multiplayer/`，浏览器使用原生 WebSocket 连接当前 Host 的 `/ws`。
- HTTP 自动使用 `ws://`，HTTPS 自动使用 `wss://`。
- 第一阶段使用完整 World Snapshot 同步 Actor、Token、Health、Damage、Healing、Combat、Chat / Game Log 与 Scene 状态。
- Selection、Ruler、地图视角和其他瞬时 UI 状态不进入共享 World。
- 新玩家加入时直接取得 Server 当前 World；断线后可重新连接并重新取得最新 Snapshot。

### Remote Internet Multiplayer

- 新增 `start-rpgmap-internet.bat` 一键公网联机入口。
- 自动检测本地或系统 PATH 中的 `cloudflared`；缺失时尝试官方 GitHub Release 下载或 `winget` 安装。
- 使用 Cloudflare Quick Tunnel 暴露 `http://127.0.0.1:30000`。
- Tunnel 强制使用 HTTP/2 over TCP，提高 VPN / TUN、校园网和限制 UDP 环境下的兼容性。
- 自动解析 `https://*.trycloudflare.com` 地址并注入 Server 的 `RPGMAP_PUBLIC_URL`。
- 自动生成 6 位 Player Join Code 与随机 16 位十六进制 GM Secret。
- Windows 公网启动时额外打开独立 `RPGmap Multiplayer Info` 信息窗口，集中显示 Public URL、Join Code、GM Secret 和本机地址，便于复制和观察。
- 远程玩家只需要收到 Public URL + Join Code；GM Secret 只供 GM 使用。

### WebSocket Robustness

- 拒绝未支持的 RSV / extension frame。
- 对控制帧长度、分片总大小、异常 continuation 和嵌套 fragment 进行校验。
- 对最大 WebSocket payload 进行限制，降低异常帧导致的风险。

### Packaging / Documentation

- 应用版本提升到 `1.4.0`。
- 正式 Release 包加入 Internet Launcher、Cloudflare 启动 / 安装脚本和 Multiplayer 使用说明。
- 根 `README.md` 更新为 V1.4 功能、局域网 / 公网联机、GM / Player 与 World Store 说明。
- 新增 `文档/联机使用说明.md`。
- Release Notes 更新为 V1.4 Multiplayer 内容。

### Validation

- Multiplayer protocol helper 自动测试。
- 真实 Node Server + 多个 WebSocket Client 的共享 World 测试。
- 公网身份验证测试：GM Secret 可独立授权 GM，Player 仍要求正确 Join Code。
- Quick Tunnel URL 解析、Join Code / GM Secret 格式和独立连接信息内容测试。
- GitHub Actions 执行 `npm test`、JavaScript syntax check、production build 和 Release/ZIP 组装验证。

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
