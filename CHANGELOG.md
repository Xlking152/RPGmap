# Changelog

RPGmap 使用语义化版本号。更细的开发过程见 `文档/工作日志.md`。

## 1.4.3 — Candidate · 2026-08-22

V1.4.3 在 V1.4.2 的 `app / world / maps` 便携结构上加入统一 **PowerShell Runtime + Web Launcher / GM Control Center**，并把 `maps/` 从“预留目录”正式升级为运行时 Map Library。

### Final Windows startup

- 发布包根目录唯一入口：`RPGmap.bat`。
- BAT 只负责启动 `launcher/rpgmap-runtime.ps1`。
- PowerShell Runtime 查找 Node.js 并运行 `launcher/launcher.mjs`。
- Runtime 窗口保持打开，可最小化。
- Server 启动后同一窗口直接显示 Local / LAN / Public URL、Join Code、GM Secret、World / Maps、Build、READY 和后续日志。
- 所有交互按钮仍在浏览器 Web Launcher 中。
- 根目录 EXE 数量固定为 0。

### External Runtime MapPackages

修正早期 V1.4.3 Candidate 中“根 `maps/` 已建立，但默认兰州地图仍被 Vite 编译进 `app/`”的问题。

现在发布包真正生成：

```text
maps/
├─ index.json
└─ northern-song-lanzhou-1104/
   ├─ map.json
   ├─ README.txt
   └─ assets/*.webp
```

- `maps/index.json` 成为 Runtime Map Registry；
- `map.json` 保存地图 metadata、SVG、features、navigation、破坏规则等 MapPackage 数据；
- 地图 WebP 资源保存在同一地图目录的 `assets/`；
- `src/main.js` 不再静态 import 兰州地图和地图 WebP；
- Production 前端启动时从 `/maps/index.json` 与对应 `map.json` 加载地图；
- Vite dev 模式保留源码地图 fallback，避免开发服务器必须先生成 Runtime MapPackage；
- PowerShell Runtime 在 Windows 建立 `app/maps -> ../maps` Junction，Game Server 通过现有静态目录读取根 `maps/`，不复制地图数据；
- CI 会检查兰州特定地图 markup 不再烘焙进 `app/`。

### World 空目录语义

新发行包不会预填一场假的 Campaign，因此 `world/` 初次解压时只有 README、`uploads/`、`backups/` 属于正常情况。`state.json` / `users.json` 在运行状态首次持久化或旧数据迁移时产生。

### Native EXE Candidate 撤回

开发过程中曾实现轻量 `RPGmap Launcher.exe`。虽然可编译并通过自动化 Smoke Test，但部分真实 Windows 环境出现启动反馈和诊断体验不理想的问题，因此最终撤回。

- 不再发布 Native EXE；
- 删除 `windows-launcher.c`；
- 删除 MinGW EXE 构建步骤；
- 当前优先稳定、透明、可诊断的 BAT + PowerShell + Web Launcher。

### Dynamic Launcher Port

- Launcher 只绑定 `127.0.0.1`；
- 首选 `29999`；
- 占用时自动尝试 `29998 → 29997 → 29996 → 29995`；
- 仍不可用时由 Windows 自动分配空闲 loopback 端口；
- 不强制结束未知占用进程。

### Unified Web Launcher

- Local / LAN / Internet Multiplayer 从一个页面启停；
- 显示 Local / LAN / Public URL、Join Code、GM Secret、Player Invite、World / Maps 路径和日志；
- Player Invite 永不包含 GM Secret；
- Internet 模式可自动把官方 `cloudflared.exe` 下载到 `tools/`；
- Cloudflare 继续使用 HTTP/2 over TCP。

### Launcher Admin Console

- pending Player approve；
- User create / update / delete；
- Default Actor；
- NONE / OBSERVER / OWNER；
- Player Key rotation；
- presence / Actor catalog。

Launcher 不直接修改 `world/users.json`，而是通过隐藏 GM WebSocket Session 复用 Server `access.*` 权限协议。

### Future Manager Slots

Launcher 首页预留：

- World Manager；
- Scene Manager；
- Backup Center。

### Package Layout

```text
RPGmap-v1.4.3/
├─ RPGmap.bat
├─ 操作说明.md
├─ app/
├─ launcher/
│  ├─ rpgmap-runtime.ps1
│  └─ ...
├─ server/
├─ world/
├─ maps/
│  ├─ index.json
│  └─ northern-song-lanzhou-1104/
├─ tools/
├─ docs/
└─ VERSION.json
```

`VERSION.json.launcherMode = single-bat-powershell-web-admin-console`。  
`VERSION.json.mapPackageMode = external-runtime-maps`。

### Validation

- npm tests / JS syntax / Vite build；
- MapPackage serialization test；
- LauncherAdminClient + 真实 Server 联调；
- ZIP 解压后二次结构检查；
- Windows Smoke Test 直接运行最终 `RPGmap.bat`；
- Smoke Test 故意占用 29999，要求 Launcher 自动回退到 29998；
- Windows Smoke Test 验证 `app/maps` Junction 与 `/maps/index.json` 实际可读。

## 1.4.2 — Candidate · Superseded by 1.4.3

建立 `app/ + world/ + maps/` 三层便携结构、`world/state.json`、`world/users.json` 和旧 `map/` / `data/` 自动迁移。

## 1.4.1 — Candidate · Superseded

建立 Persistent Player Identity、Player Key、NONE / OBSERVER / OWNER、Server-authoritative Ownership、Combat Turn Lock 和 Token Movement Client Preflight。

## 1.4.0 — 2026-08-21

正式加入 Multiplayer V1：原生 WebSocket、World Snapshot、revision / baseRevision、GM / Player、Join Code / GM Secret 和 Cloudflare Quick Tunnel。
