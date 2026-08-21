# Changelog

RPGmap 使用语义化版本号。这里记录版本级的重要变化；更细的开发过程见 `文档/工作日志.md`。

## 1.4.3 — Candidate · 2026-08-22

V1.4.3 在 V1.4.2 的 `app / world / maps` 便携结构上加入统一 **Web Launcher / GM Control Center**，并把原来多个本地/LAN/Internet 启动脚本整合成一个 Windows BAT 入口。

### Single BAT Launcher

- Windows 发布包根目录只保留一个 `启动 RPGmap.bat`。
- BAT 仅负责查找 Node.js 并启动 `launcher/launcher.mjs`。
- 启动时依次尝试 `tools/node/node.exe`、根目录 `node.exe`、系统 PATH 中的 `node.exe`。
- Launcher runtime 输出写入 `launcher-startup.log`，便于实机诊断。
- 当前 Node.js 要求仍为 `^20.19.0 || >=22.12.0`。
- 发布包根目录不再包含 Native Launcher EXE。

### Native EXE Candidate 撤回

V1.4.3 开发过程中曾尝试轻量 Windows 原生 `RPGmap Launcher.exe`。该方案可以编译并通过自动化 Windows Smoke Test，但在部分真实 Windows 环境出现启动反馈不直观、后台错误不易诊断的问题。

因此 Candidate 最终选择更简单、可维护、可诊断的：

```text
启动 RPGmap.bat → Web Launcher
```

原生 EXE 源码与 MinGW 打包步骤已移除。

### Unified Web Launcher

- 一个网页统一启动 / 停止本机、LAN 和 Internet Multiplayer。
- 显示 Local URL、LAN URL、Cloudflare Public URL、Join Code、GM Secret、World / Maps 路径与运行日志。
- 自动生成“玩家邀请”文本，只包含地址 + Join Code，不包含 GM Secret。
- GM Secret 单独置于安全区，默认隐藏，可显示 / 复制。
- Windows Internet 模式缺少 cloudflared 时，Launcher 可自动下载官方 Windows 64-bit 可执行文件到 RPGmap 包内 `tools/`。
- Cloudflare 继续使用 HTTP/2 over TCP。

### Dynamic Launcher Port

- Launcher 只绑定 `127.0.0.1`。
- 首选端口为 `29999`。
- 被占用时自动尝试 `29998 → 29997 → 29996 → 29995`。
- 如果这些端口仍不可用，则让 Windows 自动分配当前空闲 loopback 端口。
- 浏览器自动打开实际端口，用户无需手动修改或强制关闭其他程序。

### Launcher Admin Console

- 查看 pending / 正式 Player User 与在线状态。
- 批准首次加入 Player。
- 预创建 User 并生成 Player Key。
- 设置默认 Actor。
- 配置 `NONE / OBSERVER / OWNER`。
- 重发 Player Key。
- 删除 User。
- 读取 Actor catalog。

Launcher **不直接修改 `world/users.json`**。它建立隐藏的本机 GM WebSocket Session，复用 Multiplayer Server 已有 `access.*` 协议，因此 Launcher 与游戏内“联机 / Users”始终共享同一套权限、内存状态和持久化逻辑。

### Future Manager Slots

Launcher 首页预留三个未来管理入口，当前按钮保持禁用：

- `World Manager`：World 选择 / 创建 / 复制 / 归档 / 启动。
- `Scene Manager`：Map Registry / MapPackage / Scene 切换与管理。
- `Backup Center`：World Snapshot / 自动备份 / 恢复 / 导入导出。

`文档/未来规划.md` 使用“已实现 / 部分实现 / 计划中 / Launcher 已预留”状态标记现有路线。

### Security Boundary

- Launcher 只绑定本机 loopback。
- Cloudflare Tunnel 只转发 RPGmap Game Server，不转发 Launcher。
- Launcher 本机 API 使用随机 Browser Token。
- Player Invite 永不包含 GM Secret。
- Server 仍是 User / Ownership / Combat 权限的最终裁决者。

### Package Layout

```text
RPGmap-v1.4.3/
├─ 启动 RPGmap.bat
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

- 根目录 BAT 数量必须为 1。
- 根目录 EXE 数量必须为 0。
- `VERSION.json.launcherMode = single-bat-web-admin-console`。
- `VERSION.json.launcherPortMode = dynamic-loopback`。
- `docs/FUTURE-ROADMAP.md` 随发布包一起提供。

### Validation

- `LauncherAdminClient` 与真实 Node Server 联调测试。
- 自动测试 User create/update/delete、Player Key rotation、pending Player approve。
- JavaScript syntax check 覆盖 `deployment/launcher/`。
- Windows CI 真实运行最终 `启动 RPGmap.bat`。
- Windows CI 会故意占用 `29999`，验证 Launcher 能自动切换到 `29998` 并正常提供控制中心。

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

建立 Persistent Player Identity、Player Key、NONE / OBSERVER / OWNER、Server-authoritative Ownership、Combat Turn Lock 和 Token Movement Client Preflight。这些能力全部进入 V1.4.3。

## 1.4.0 — 2026-08-21

正式加入 Multiplayer V1：原生 WebSocket、World Snapshot、revision / baseRevision、GM / Player、Join Code / GM Secret、Cloudflare Quick Tunnel 与独立 Connection Info。

## 1.3.0 — 2026-08-21

SelectionSystem、FVTT 风格 Ruler、CombatSystem、Health / Damage / Healing、Chat / Game Log、XLSX Actor Sheet / Form 和本地 HTTP Server。

## 1.2.0 — 2026-08-21

Actor / Token / Form EntitySystem、XLSX 角色导入、Movement / Waypoint 重构和 AppShell / MapPackage 架构。

## 1.1.0 及更早

早期版本完成基础地图浏览、Marker / Token 原型与地图数据验证。
