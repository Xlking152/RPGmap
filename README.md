# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器端自托管跑团平台，目标是逐步发展为类似 Foundry VTT 的可扩展地图、角色、战斗与多人联机系统。当前仓库中的北宋兰州地图用于主要开发和验证。

当前开发版本：**V1.4.3 Candidate**。稳定 `main` 在该 Candidate 合并前仍保持 V1.4.0；V1.4.1 的 Player Identity / Ownership 与 V1.4.2 的 `app / world / maps` 结构均继续继承。

> 本 README 只作为**项目整体说明**。发布 ZIP 内面向 GM / Player 的实际操作文档为根目录 `操作说明.md`。

## 项目目标

```text
RPGmap
├─ Unified Web Launcher / GM Control Center
├─ App / UI
├─ Map / Scene System
├─ Actor / Token / Form
├─ Selection / Movement / Measurement
├─ Health / Damage / Healing
├─ Combat / Initiative / Turn
├─ Chat / Game Log
├─ Multiplayer / Presence
├─ Player Identity / Ownership
├─ Portable World Storage
└─ Internet Multiplayer
```

## V1.4.3：单 BAT + Web Launcher

V1.4.3 将过去分散的本机、LAN、Internet、cloudflared、连接信息和 User 后台整合为一个浏览器 Launcher / GM Control Center。

Windows 发布包只保留一个启动入口：

```text
启动 RPGmap.bat
```

BAT 本身不承担任何业务逻辑，只负责：

```text
查找 Node.js
    ↓
启动 launcher/launcher.mjs
    ↓
Launcher 选择本机空闲端口
    ↓
自动打开浏览器 GM Control Center
```

当前 Node.js 运行要求：

```text
^20.19.0 || >=22.12.0
```

启动时依次尝试：

1. `tools/node/node.exe`；
2. RPGmap 根目录 `node.exe`；
3. 系统 PATH 中的 `node.exe`。

这为未来内置 Portable Node 保留了空间，但当前不要求把 Node 复制进项目目录。

### 为什么撤回 Native EXE

V1.4.3 Candidate 曾尝试轻量 Windows 原生 EXE 启动壳。该方案虽然可以编译并通过 CI，但在不同 Windows 实机环境中出现了启动失败不易诊断、端口冲突反馈不直观等问题。

因此当前 Candidate 明确回到更简单、可维护、可诊断的方案：

```text
启动 RPGmap.bat + Web Launcher
```

RPGmap 不为了“看起来像桌面软件”增加额外启动层。真正的产品能力集中在网页 Launcher 中。

## Launcher / GM Control Center

Launcher 统一负责：

- 启动 / 停止 RPGmap Server；
- 本机 / LAN 模式；
- Cloudflare Quick Tunnel Internet 模式；
- Local / LAN / Public URL；
- Join Code / 房间号；
- GM Secret；
- 玩家邀请文本；
- Server / Tunnel 日志；
- World / Maps 路径；
- pending Player；
- User / Ownership 后台管理。

### 动态 Launcher 端口

Launcher 只绑定本机 loopback：

```text
127.0.0.1
```

首选端口为：

```text
29999
```

如果被占用，会自动尝试：

```text
29998 → 29997 → 29996 → 29995
```

仍然不可用时，让 Windows 自动分配一个空闲本机端口。浏览器会自动打开实际选中的地址，因此用户不需要记 Launcher 端口。

Game Server 仍默认使用：

```text
0.0.0.0:30000
```

Cloudflare Tunnel 只转发 Game Server，不转发 Launcher 管理端口。

### Launcher 安全边界

Launcher 本机 API 使用随机 Browser Token。

Launcher **不直接编辑 `world/users.json`**，而是建立隐藏的本机 GM WebSocket Session，通过 Multiplayer Server 已有的权限协议执行：

- 批准 pending Player；
- 预创建 User；
- 默认 Actor；
- `NONE / OBSERVER / OWNER`；
- 重发 Player Key；
- 删除 User。

因此 Launcher 与游戏内“联机 / Users”面板始终共享同一套 Server 内存状态、权限规则与持久化逻辑。

## Launcher 未来管理中心

V1.4.3 已在 Launcher 首页预留三个禁用模块：

### World Manager

未来负责 World 选择、创建、复制、重命名、归档、启动和 schema / migration 检查。

### Scene Manager

未来负责 Map Registry、MapPackage 导入、多地图 / Scene 列表、排序、切换、reset / clone。

### Backup Center

未来负责一键 Snapshot、自动备份、备份列表、恢复、World 导入 / 导出和升级前备份。

完整状态见 `文档/未来规划.md`。

## 发布包结构

```text
RPGmap-v1.4.3/
├─ 启动 RPGmap.bat
├─ 操作说明.md
├─ app/                  RPGmap Web App
├─ launcher/             本机 Web Launcher / GM Control Center
├─ server/               Multiplayer Server 内部程序
├─ world/                当前 World / Campaign 持久数据
├─ maps/                 真正 Map / Scene 资源库
├─ tools/                cloudflared / 未来 Portable Node 等内部工具
├─ docs/
└─ VERSION.json
```

发布包根目录只保留一个 BAT，不包含 Native Launcher EXE，也不暴露散落的 Server 脚本。

## app / world / maps

长期语义固定为：

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

- `state.json`：World Snapshot、Actor / Token、Combat、Chat、Scene 实例状态。
- `users.json`：Persistent Player User、默认 Actor、Ownership、凭证哈希。
- `uploads/`：当前 World 上传资源。
- `backups/`：本地备份。

默认不依赖 AppData、用户主目录或其他隐藏 User Data 路径。

### maps/

`maps/` 专门留给真正的 Map / Scene 资源：

```text
maps/
├─ lanzhou/
├─ inn-01/
├─ dungeon-01/
└─ battlefield-01/
```

未来地图包可以包含背景层、建筑 / 墙体、可破坏对象、Collision / Navigation、环境特效、损坏 / 摧毁变体以及地图专属 Assets。

例如建筑“模板、模型、碰撞、破坏阶段”属于 `maps/`；本次跑团中当前 HP、燃烧、坍塌状态属于 `world/state.json`。

## Player Identity / User

多人联机身份模型：

```text
Session → Persistent User → Default Actor / Ownership
```

默认流程：Player 首次 Join Code 加入 → pending → GM 在 Launcher 或游戏内 Users 面板批准 → 分配默认 Actor / Ownership → Server 创建持久 User → Player 保存 Player Key。

Quick Tunnel 域名变化时，Player Key 用于在新 URL 恢复同一个持久 User。Server 只保存凭证哈希。

## Actor Ownership

| 权限 | 含义 |
| --- | --- |
| `NONE` | 无控制权 |
| `OBSERVER` | 观察 / 查看，不允许修改 Actor |
| `OWNER` | 可完整操控 Actor |

GM 对全部 Actor 隐式拥有完整权限。每个 Player 可以有一个默认 Actor 和多个 OWNER / OBSERVER Actor；默认 Actor 必须是 OWNER。

## Combat Turn Lock

Combatant、Initiative、排序、开始 / 结束、Round / Turn 由 GM 管理。

Combat active 时，Player 即使拥有多个 OWNER Actor，也只能修改当前 Turn 对应的 OWNER Actor。

权限采用：

```text
Client Preflight
      ↓
world.push
      ↓
Server authoritative validation
```

前端按钮隐藏不是安全边界，Server 会再次拒绝越权修改。

## Multiplayer

当前 Multiplayer 使用：

- 原生 WebSocket `/ws`；
- World Snapshot；
- `revision / baseRevision` 冲突保护；
- GM / Player；
- Presence；
- Persistent User；
- Actor Ownership；
- Combat Turn Lock；
- Cloudflare Quick Tunnel；
- Launcher GM Admin Session。

Selection、Ruler、地图视角 / Zoom、Hover、当前窗口等个人瞬时 UI 不进入共享 World。

## 旧数据迁移

新 `world/` 数据不存在时继续兼容：

```text
V1.4.1 Candidate
map/world.json  → world/state.json
map/users.json  → world/users.json

更旧版本
data/worlds/default/world.json  → world/state.json
data/worlds/default/access.json → world/users.json
```

旧文件保留不删除；新 `world/` 永远优先。

## 源码结构

```text
src/
├─ app/
├─ chat/
├─ combat/
├─ damage/
├─ engine/
├─ entities/
├─ healing/
├─ health/
├─ maps/
├─ measurement/
├─ movement/
├─ multiplayer/
├─ render/
├─ selection/
└─ ui/

deployment/
├─ launcher/
│  ├─ start-rpgmap.bat
│  ├─ launcher.mjs
│  ├─ admin-client.mjs
│  ├─ index.html
│  ├─ launcher.js
│  └─ launcher.css
└─ local-server/
   ├─ server.mjs
   ├─ access-control.mjs
   ├─ portable-storage.mjs
   ├─ 操作说明.md
   ├─ world/README.txt
   └─ maps/README.txt

tests/
文档/
```

## 文档职责

- `README.md`：项目整体介绍、架构和能力边界。
- `CHANGELOG.md`：版本级更新摘要。
- `文档/工作日志.md`：详细开发记录。
- `文档/未来规划.md`：带状态的项目路线。
- `文档/联机使用说明.md`：Multiplayer / Identity / Ownership。
- `deployment/local-server/操作说明.md`：发布 ZIP 的实际操作说明。

## 版本规则

RPGmap 使用 `MAJOR.MINOR.PATCH`：

- Patch：Bug、权限、Launcher、兼容性和小型架构整理，例如 `1.4.3`。
- Minor：完整新子系统，例如未来真正的 Multi-Map / Scene System。
- Major：明显不兼容的 World、协议或核心架构变化。

V1.4.3 当前保持 Candidate / Draft 测试状态，完成实际设备验证后再进入 `main`。
