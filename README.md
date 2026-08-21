# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器端自托管跑团平台，目标是逐步发展为类似 Foundry VTT 的可扩展地图、角色、战斗与多人联机系统。当前仓库中的北宋兰州地图用于主要开发和验证。

当前开发版本：**V1.4.3 Candidate**。稳定 `main` 在该 Candidate 合并前仍保持 V1.4.0；V1.4.1 的 Player Identity / Ownership 与 V1.4.2 的 `app / world / maps` 结构均继续继承。

> 本 README 只作为**项目整体说明**。发布 ZIP 内面向 GM / Player 的实际操作文档为根目录 `操作说明.md`。

## 项目目标

RPGmap 希望形成一套可自托管、可携带、可扩展的 VTT 架构：

```text
RPGmap
├─ Native Launcher / GM Control Center
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

## V1.4.3：Native Launcher + GM Control Center

V1.4.3 将过去分散的本机、LAN、Internet、cloudflared、连接信息和 User 后台脚本整合为一个 Launcher。

Windows 发布包唯一启动入口：

```text
RPGmap Launcher.exe
```

它是一个轻量 Windows 原生启动壳，不使用 Electron，也不把完整浏览器或 Node Runtime 打进 EXE。

EXE 负责查找 Node.js 并启动：

```text
launcher/launcher.mjs
```

Launcher 随后在本机打开：

```text
http://127.0.0.1:29999
```

并统一负责：

- 启动 / 停止 RPGmap Server；
- 本机 / LAN 模式；
- Cloudflare Quick Tunnel Internet 模式；
- 本机地址、LAN 地址、Public URL；
- Join Code / 房间号；
- GM Secret；
- 玩家邀请文本；
- Server / Tunnel 日志；
- World / Maps 路径；
- User / Ownership 后台管理。

### 为什么不用 Electron

Launcher 的核心仍然是 Node + Web UI。

Native EXE 只提供 Windows 桌面软件式的单入口，因此：

- EXE 本身很小；
- 不增加 Electron 运行时；
- 不让发布包突然膨胀几十或几百 MB；
- 保持 Launcher UI 易开发、易调试；
- Windows 用户仍然可以直接双击 `.exe`。

当前运行前提仍为：

```text
Node.js ^20.19.0 或 >=22.12.0
```

如果没有检测到 Node.js，Native Launcher 会提示安装。

### Launcher 安全边界

Launcher 只绑定：

```text
127.0.0.1:29999
```

Cloudflare Tunnel 只转发 RPGmap 游戏端口，不转发 Launcher。

Launcher 自己使用随机 Browser Token 保护本机管理 API。

更重要的是，Launcher **不直接编辑 `world/users.json`**。它建立一个隐藏的本机 GM WebSocket Session，通过 Multiplayer Server 现有的 User / Ownership 协议执行：

- 批准 pending Player；
- 预创建 User；
- 默认 Actor；
- `NONE / OBSERVER / OWNER`；
- 重发 Player Key；
- 删除 User。

因此 Launcher 和游戏内“联机 / Users”面板始终共享同一套 Server 内存状态、权限规则与持久化逻辑。

## Launcher 未来管理中心

V1.4.3 已在 Launcher 首页预留三个明确入口，当前保持禁用并标记为“计划中”：

### World Manager

未来负责：

- World 选择；
- 创建 / 复制 / 重命名；
- 归档；
- 启动前选择 Campaign；
- World schema / migration 检查。

### Scene Manager

未来负责：

- Map Registry；
- MapPackage 导入；
- 多地图 / Scene 列表；
- 排序与切换；
- Scene reset / clone。

### Backup Center

未来负责：

- 一键 World Snapshot；
- 自动备份；
- 备份列表；
- 恢复；
- World 导入 / 导出；
- 升级前备份。

完整状态和已完成项见 `文档/未来规划.md`。

## 发布包结构

V1.4.3 发布包进一步整理为：

```text
RPGmap-v1.4.3/
├─ RPGmap Launcher.exe
├─ 操作说明.md
├─ app/                  RPGmap Web App
├─ launcher/             本机 Launcher / Admin Console
├─ server/               Multiplayer Server 内部程序
├─ world/                当前 World / Campaign 持久数据
├─ maps/                 真正 Map / Scene 资源库
├─ docs/
└─ VERSION.json
```

发布包根目录不再暴露多个 BAT，也不再放散落的 Server 脚本。

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

`maps/` 专门留给真正的地图 / Scene 资源：

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

GM 也可以预创建 Player User，并把 Player Key 私下发给对应玩家。

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

主要共享 Actor / Token、位置、Health / Damage / Healing、Combat、Chat / Game Log、Scene / World 状态。

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
│  ├─ windows-launcher.c
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
- `文档/未来规划.md`：带“已实现 / 部分实现 / 计划中”状态的项目路线。
- `文档/联机使用说明.md`：Multiplayer / Identity / Ownership。
- `deployment/local-server/操作说明.md`：发布 ZIP 的实际操作说明。

## 版本规则

RPGmap 使用 `MAJOR.MINOR.PATCH`：

- Patch：Bug、权限、Launcher、兼容性和小型架构整理，例如 `1.4.3`。
- Minor：完整新子系统，例如未来真正的 Multi-Map / Scene System。
- Major：明显不兼容的 World、协议或核心架构变化。

V1.4.3 当前保持 Candidate / Draft 测试状态，完成实际设备验证后再进入 `main`。
