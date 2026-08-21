# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器端自托管跑团平台，目标是逐步发展为类似 Foundry VTT 的可扩展地图、角色、战斗与多人联机系统。

当前开发版本：**V1.4.3 Candidate**。稳定 `main` 在该 Candidate 合并前仍保持 V1.4.0；V1.4.1 的 Player Identity / Ownership 与 V1.4.2 的 `app / world / maps` 结构均继续继承。

> 本 README 只作为**项目整体说明**。发布 ZIP 内面向 GM / Player 的实际操作文档为根目录 `操作说明.md`。

## 当前总体架构

```text
RPGmap.bat
   ↓
Node.js
   ↓
Unified Web Launcher / GM Control Center
   ├─ Local / LAN / Internet
   ├─ Join Code / GM Secret / Player Invite
   ├─ Users / Ownership
   ├─ Server / Tunnel Logs
   └─ Future Managers
      ├─ World Manager
      ├─ Scene Manager
      └─ Backup Center

Game Server
├─ Web App
├─ World Store
├─ WebSocket
├─ Player Identity / Ownership
└─ Combat Turn Authority

Portable Data
├─ app/       程序
├─ world/     当前 Campaign 运行状态
└─ maps/      Map / Scene 资源
```

## V1.4.3：单 BAT + Web Launcher

Windows 发布包只保留一个启动入口：

```text
RPGmap.bat
```

BAT 不承担任何业务逻辑，只负责：

1. 查找 Node.js；
2. 直接运行 `launcher/launcher.mjs`；
3. Web Launcher 自动打开浏览器。

当前 Node.js 要求：

```text
^20.19.0 || >=22.12.0
```

查找顺序：

```text
tools/node/node.exe
→ 根目录 node.exe
→ 系统 PATH node.exe
```

BAT 窗口作为 Launcher Runtime 保持运行，可以最小化；实际 GM 操作全部在网页中完成。点击网页“关闭 Launcher”后 Runtime 结束。

### 为什么不用 EXE

V1.4.3 Candidate 曾实现并测试轻量 Windows 原生 `RPGmap Launcher.exe`。虽然自动化环境可运行，但部分真实 Windows 环境出现启动失败反馈不直观、端口冲突诊断成本偏高的问题。

因此该方案已撤回。当前明确优先：

```text
简单、透明、可诊断的 RPGmap.bat + Web Launcher
```

Native EXE 不进入发布包，原生启动壳源码和 MinGW 打包步骤已移除。

## Launcher 动态本机端口

Launcher 只绑定 `127.0.0.1`。

首选：

```text
29999
```

冲突时自动尝试：

```text
29998 → 29997 → 29996 → 29995
```

仍不可用时，让 Windows 自动分配一个空闲 loopback 端口。浏览器自动打开实际地址，因此用户不需要结束占用端口的其他程序，也不需要记 Launcher 端口。

Game Server 默认仍为：

```text
0.0.0.0:30000
```

Cloudflare Tunnel 只转发 Game Server，不转发 Launcher 管理端口。

## Launcher / GM Control Center

网页 Launcher 统一负责：

- Server 启动 / 停止；
- 本机 / LAN；
- Cloudflare Quick Tunnel Internet；
- Local / LAN / Public URL；
- Join Code / 房间号；
- GM Secret；
- Player Invite；
- Server / Tunnel 日志；
- World / Maps 路径；
- pending Player；
- User / Ownership 管理。

Launcher 本机 API 使用随机 Browser Token。

Launcher **不直接修改 `world/users.json`**。它建立隐藏 GM WebSocket Session，通过 Server 既有 `access.*` 协议执行 approve、User create/update/delete、Default Actor、NONE / OBSERVER / OWNER、Player Key rotation。

## 未来管理中心

V1.4.3 已在 Launcher 首页预留三个禁用模块：

- **World Manager**：World 选择 / 创建 / 复制 / 归档 / 启动；
- **Scene Manager**：Map Registry / MapPackage / Scene 切换；
- **Backup Center**：Snapshot / 自动备份 / 恢复 / 导入导出。

完整状态见 `文档/未来规划.md`。

## 发布包结构

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

发布包根目录 BAT 数量固定为 1，EXE 数量固定为 0。

## app / world / maps

长期语义：

- **`app/`：程序是什么。**
- **`maps/`：地图 / Scene 本身是什么。**
- **`world/`：这一场游戏里发生了什么。**

### world/

```text
world/
├─ state.json
├─ users.json
├─ uploads/
└─ backups/
```

- `state.json`：World Snapshot、Actor / Token、Combat、Chat、Scene 实例状态；
- `users.json`：Persistent User、Default Actor、Ownership、凭证哈希；
- `uploads/`：当前 World 上传资源；
- `backups/`：本地备份。

默认不依赖 AppData 或其他隐藏目录。

### maps/

`maps/` 留给真实 Map / Scene 资源，包括背景、建筑 / 墙体、可破坏对象、Collision / Navigation、环境特效、Damage / Destroyed Variant 和地图专属 Assets。

地图模板描述“地图是什么”，而建筑当前 HP、燃烧、坍塌等 Campaign 实例状态属于 `world/state.json`。

## Player Identity / Ownership

```text
Session → Persistent User → Default Actor / Ownership
```

Player 首次加入进入 pending；GM 在 Launcher 或游戏内 Users 面板批准后创建 Persistent User。Player Key 用于 Quick Tunnel 域名变化后恢复同一身份。

Actor 权限：

| 权限 | 含义 |
| --- | --- |
| `NONE` | 无控制权 |
| `OBSERVER` | 观察 / 查看 |
| `OWNER` | 可操控 Actor |

GM 对全部 Actor 隐式拥有完整权限。Combat active 时，Player 只能修改当前 Turn 对应的 OWNER Actor。

## Multiplayer

当前 Multiplayer 包括：

- 原生 WebSocket `/ws`；
- World Snapshot；
- `revision / baseRevision`；
- Presence；
- Persistent User；
- Actor Ownership；
- Combat Turn Lock；
- Cloudflare Quick Tunnel；
- Launcher GM Admin Session。

当前 Ownership 是控制权限，不等同于数据隐私。未来 GM-only / 隐藏 NPC 数据需要 per-user filtered snapshot 或 document-level visibility。

## 旧数据迁移

```text
V1.4.1 Candidate
map/world.json  → world/state.json
map/users.json  → world/users.json

更旧版本
data/worlds/default/world.json  → world/state.json
data/worlds/default/access.json → world/users.json
```

旧文件保留，新 `world/` 优先。

## 文档职责

- `README.md`：项目整体架构；
- `CHANGELOG.md`：版本级变化；
- `文档/工作日志.md`：开发记录；
- `文档/未来规划.md`：路线和完成状态；
- `文档/联机使用说明.md`：Multiplayer / Identity / Ownership；
- `deployment/local-server/操作说明.md`：发布 ZIP 实际操作说明。

V1.4.3 当前保持 Candidate / Draft，完成实际设备验证后再进入 `main`。
