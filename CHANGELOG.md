# Changelog

RPGmap 使用语义化版本号。这里记录版本级的重要变化；更细的开发过程见 `文档/工作日志.md`。

## 1.4.3 — Candidate · 2026-08-22

V1.4.3 在 V1.4.2 的 `app / world / maps` 便携结构上加入统一 **RPGmap Launcher / GM Control Center**，把过去分散的本机、LAN、Internet、cloudflared、连接信息和 User 管理入口整合为一个本机控制台。

### Unified Launcher

- Windows 发布包只保留一个启动入口：`启动 RPGmap.bat`。
- Launcher 本机地址：`http://127.0.0.1:29999`。
- 一个界面统一启动 / 停止本机、LAN 和 Internet Multiplayer。
- 显示 Local URL、LAN URL、Cloudflare Public URL、Join Code、GM Secret、World / Maps 路径与运行日志。
- 自动生成“玩家邀请”文本，只包含地址 + Join Code，不包含 GM Secret。
- GM Secret 单独置于安全区，默认隐藏，可显示 / 复制。
- Windows Internet 模式缺少 cloudflared 时，Launcher 可自动下载官方 Windows 64-bit 可执行文件到 RPGmap 包内 `tools/`。
- Cloudflare 继续使用 HTTP/2 over TCP。

### Launcher Admin Console

- Launcher 增加 Users / Actor Ownership 后台。
- 可查看 pending / 正式 Player User 与在线状态。
- 可批准首次加入 Player。
- 可预创建 User 并生成 Player Key。
- 可设置默认 Actor。
- 可配置 `NONE / OBSERVER / OWNER`。
- 可重发 Player Key。
- 可删除 User。
- 可读取 Actor catalog。

Launcher **不直接修改 `world/users.json`**。它建立隐藏的本机 GM WebSocket Session，复用 Multiplayer Server 已有 `access.*` 协议，因此 Launcher 与游戏内“联机 / Users”始终共享同一套权限、内存状态和持久化逻辑。

### Security Boundary

- Launcher HTTP Server 只绑定 `127.0.0.1`。
- Cloudflare Tunnel 只转发 RPGmap 游戏端口，不转发 Launcher 端口。
- Launcher 本机 API 使用随机 Browser Token。
- Player 无法通过公网地址访问 Launcher Admin Console。
- Server 仍为 User / Ownership / Combat 权限的最终裁决者。

### Package Layout

V1.4.3 发布包：

```text
RPGmap-v1.4.3/
├─ 启动 RPGmap.bat
├─ 操作说明.md
├─ app/
├─ launcher/
├─ server/
├─ world/
├─ maps/
├─ docs/
└─ VERSION.json
```

- `server.mjs / access-control.mjs / portable-storage.mjs` 收入内部 `server/`。
- Launcher 文件收入 `launcher/`。
- 根目录不再暴露 `start-rpgmap.bat`、`start-rpgmap-internet.bat`、`setup-cloudflared.bat`、`run-rpgmap-public-server.bat`。
- CI 强制检查发布包根目录 `.bat` 数量为 1。
- `VERSION.json.launcherMode = unified-admin-console`。

### Validation

- 新增 `LauncherAdminClient` 与真实 Node Server 联调测试。
- 自动测试 Launcher GM Session 创建 / 修改 / 删除 User、重发 Player Key、pending Player 批准。
- JavaScript syntax check 扩展到 `deployment/launcher/`。
- CI 对最终 ZIP 解压后二次验证单一 BAT、Launcher / Server 内部目录和 UTF-8 `操作说明.md`。

## 1.4.2 — Candidate · Superseded by 1.4.3

V1.4.2 建立 **`app/ + world/ + maps/`** 三层便携结构，并被 V1.4.3 完整继承。

- `app/`：RPGmap 前端程序。
- `world/`：当前 World / Campaign 可写运行数据。
- `maps/`：真正 Map / Scene 资源库。
- `world/state.json`：World Snapshot / revision。
- `world/users.json`：Persistent User / Ownership / Credential Hash。
- 自动迁移 V1.4.1 Candidate `map/` 和更早 `data/` 结构。
- GitHub `README.md` 与发布包 `操作说明.md` 职责分离。

## 1.4.1 — Candidate · Superseded

建立了 Persistent Player Identity、Player Key、NONE / OBSERVER / OWNER、Server-authoritative Ownership、Combat Turn Lock 和 Token Movement Client Preflight。这些能力全部进入 V1.4.3。

## 1.4.0 — 2026-08-21

正式加入 Multiplayer V1：原生 WebSocket、World Snapshot、revision / baseRevision、GM / Player、Join Code / GM Secret、Cloudflare Quick Tunnel 与独立 Connection Info。

## 1.3.0 — 2026-08-21

SelectionSystem、FVTT 风格 Ruler、CombatSystem、Health / Damage / Healing、Chat / Game Log、XLSX Actor Sheet / Form 和本地 HTTP Server。

## 1.2.0 — 2026-08-21

Actor / Token / Form EntitySystem、XLSX 角色导入、Movement / Waypoint 重构和 AppShell / MapPackage 架构。

## 1.1.0 及更早

早期版本完成基础地图浏览、Marker / Token 原型与地图数据验证。
