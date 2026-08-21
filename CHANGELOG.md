# Changelog

RPGmap 使用语义化版本号。这里记录版本级的重要变化；更细的开发过程见 `文档/工作日志.md`。

## 1.4.3 — Candidate · 2026-08-22

V1.4.3 在 V1.4.2 的 `app / world / maps` 便携结构上加入统一 **Web Launcher / GM Control Center**，并把 Windows 启动入口最终收口为一个纯 ASCII 的 `RPGmap.bat`。

### Single BAT Launcher

- Windows 发布包根目录只保留一个 `RPGmap.bat`。
- BAT 直接运行 `launcher/launcher.mjs`，不再套 PowerShell、隐藏 CMD 或 Native EXE。
- Node 查找顺序：`tools/node/node.exe` → 根目录 `node.exe` → 系统 PATH。
- BAT 窗口作为 Launcher Runtime，可最小化；所有 GM 操作放在网页 Launcher 中。
- 启动基本信息写入 `launcher-startup.log`；启动错误直接显示在 BAT 窗口。
- 当前 Node.js 要求：`^20.19.0 || >=22.12.0`。

### Native EXE Candidate 撤回

V1.4.3 开发过程中曾实现轻量 Windows `RPGmap Launcher.exe`。该方案可以编译并通过自动化 Windows Smoke Test，但真实 Windows 设备出现启动反馈和诊断体验不稳定的问题，因此最终撤回。

- Native EXE 不进入发布包；
- `windows-launcher.c` 已移除；
- MinGW EXE 构建步骤已移除；
- 当前优先稳定、透明、可诊断的 BAT + Web Launcher。

### Dynamic Launcher Port

- Launcher 只绑定 `127.0.0.1`；
- 首选 `29999`；
- 占用时自动尝试 `29998 → 29997 → 29996 → 29995`；
- 仍不可用时让 Windows 自动分配空闲 loopback 端口；
- 浏览器自动打开实际地址，不强制结束其他进程。

### Unified Web Launcher

- Local / LAN / Internet Multiplayer 从一个界面启停；
- 显示 Local / LAN / Public URL、Join Code、GM Secret、Player Invite、World / Maps 路径和日志；
- Player Invite 永不包含 GM Secret；
- Internet 模式可把官方 `cloudflared.exe` 自动下载到 `tools/`；
- Cloudflare 继续使用 HTTP/2 over TCP。

### Launcher Admin Console

- pending Player approve；
- User create / update / delete；
- Default Actor；
- NONE / OBSERVER / OWNER；
- Player Key rotation；
- online / presence / Actor catalog。

Launcher 不直接修改 `world/users.json`，而是通过隐藏 GM WebSocket Session 复用 Server 的 `access.*` 权限协议。

### Future Manager Slots

Launcher 首页预留：

- World Manager；
- Scene Manager；
- Backup Center。

`文档/未来规划.md` 已标记“已实现 / 部分实现 / 计划中 / Launcher 已预留 / 已撤回方案”。

### Package Layout

```text
RPGmap-v1.4.3/
├─ RPGmap.bat
├─ 操作说明.md
├─ app/
├─ launcher/
├─ server/
├─ world/
├─ maps/
├─ tools/
├─ docs/
└─ VERSION.json
```

打包约束：

- 根目录 BAT = 1；
- 根目录 EXE = 0；
- `VERSION.json.launcherMode = single-bat-web-admin-console`；
- `VERSION.json.launcherPortMode = dynamic-loopback`。

### Validation

- npm tests / JS syntax / Vite production build；
- LauncherAdminClient + 真实 Node Server 联调；
- User create/update/delete、Player Key rotation、pending Player approve；
- ZIP 解压后二次结构检查；
- Windows Smoke Test 直接运行最终 `RPGmap.bat`；
- Smoke Test 故意占用 `29999`，验证 Launcher 自动回退到 `29998`。

## 1.4.2 — Candidate · Superseded by 1.4.3

建立 `app/ + world/ + maps/` 三层便携结构、`world/state.json`、`world/users.json` 和旧 `map/` / `data/` 自动迁移。

## 1.4.1 — Candidate · Superseded

建立 Persistent Player Identity、Player Key、NONE / OBSERVER / OWNER、Server-authoritative Ownership、Combat Turn Lock 和 Token Movement Client Preflight。

## 1.4.0 — 2026-08-21

正式加入 Multiplayer V1：原生 WebSocket、World Snapshot、revision / baseRevision、GM / Player、Join Code / GM Secret 和 Cloudflare Quick Tunnel。

## 1.3.0 — 2026-08-21

SelectionSystem、Ruler、CombatSystem、Health / Damage / Healing、Chat / Game Log、XLSX Actor Sheet / Form 和本地 HTTP Server。

## 1.2.0 — 2026-08-21

Actor / Token / Form EntitySystem、XLSX 角色导入、Movement / Waypoint 重构和 AppShell / MapPackage 架构。
