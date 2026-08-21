# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器端自托管跑团平台，目标是逐步发展为类似 Foundry VTT 的可扩展地图、角色、战斗与多人联机系统。当前仓库中的北宋兰州地图用于主要开发和验证。

当前开发版本：**V1.4.2 Candidate**。稳定 `main` 在该 Candidate 合并前仍保持 V1.4.0；V1.4.1 的身份 / Ownership 工作已经被 V1.4.2 继续继承和整理。

> 本 README 只作为**项目整体说明**。发布 ZIP 内不会再放项目 README；实际使用者请阅读发布包根目录 `操作说明.md`。

## 项目目标

RPGmap 希望形成一套可自托管、可携带、可扩展的 VTT 架构：

```text
RPGmap
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

现阶段重点是把“地图资源”“跑团运行状态”“程序本身”三者边界做清楚，为后续多地图、可破坏建筑、环境特效和更复杂 Scene System 奠定基础。

## V1.4.2：三层便携结构

V1.4.2 将发布包统一为：

```text
RPGmap-v1.4.2/
├─ app/                 RPGmap 前端程序
├─ world/               当前 World / Campaign 的持久运行状态
├─ maps/                真正的 Map / Scene 资源库
├─ docs/
├─ server.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ internet-launcher.mjs
└─ start scripts
```

一句话区分：

- **`app/`：程序是什么。**
- **`maps/`：地图 / Scene 本身是什么。**
- **`world/`：这一场游戏里发生了什么。**

### `world/`

保存当前跑团实例的可写状态：

```text
world/
├─ state.json
├─ users.json
├─ uploads/
└─ backups/
```

其中：

- `state.json`：World Snapshot、Actor / Token、Combat、Chat、Scene 运行状态等。
- `users.json`：持久 Player User、默认 Actor、Ownership、凭证哈希。
- `uploads/`：当前 World 上传资源。
- `backups/`：本地备份。

RPGmap 默认不会再把这些 World / User 数据写到 AppData、用户主目录或其他隐藏目录。

### `maps/`

`maps/` 从 V1.4.2 起专门保留给真正的地图 / Scene 资源：

```text
maps/
├─ lanzhou/
├─ inn-01/
├─ dungeon-01/
└─ battlefield-01/
```

未来一个地图包可以继续扩展：

- 地图 manifest / metadata；
- 背景层；
- 建筑 / 墙体；
- 可破坏对象；
- 碰撞 / Navigation；
- 环境特效；
- 损坏 / 摧毁变体；
- 地图专属资源。

例如一栋可破坏建筑的“模板、模型、碰撞、破坏阶段”属于 `maps/`；某次跑团里它当前 HP、燃烧、墙体坍塌等实例状态属于 `world/state.json`。

V1.4.2 先确立目录与数据边界，真正的多地图切换 / 可破坏建筑逻辑将在后续版本实现。

## Player Identity / User

多人联机不再只有临时 WebSocket Session，而是：

```text
Session → Persistent User → Default Actor / Ownership
```

默认 User 流程：

1. Player 首次使用 Join Code 加入；
2. 进入 pending；
3. GM 在“联机 / Users”中批准；
4. GM 分配默认 Actor 和 Ownership；
5. Server 创建持久 User；
6. Player 保存 Player Key。

GM 也可以在开团前预创建 Player User，再把 Player Key 私下发给对应玩家。

Quick Tunnel 域名变化时，Player Key 用于在新 URL 恢复同一个持久 User。Server 只保存凭证哈希，不保存明文 Player Key / Browser Token。

## Actor Ownership

V1.4.2 继承 V1.4.1 的三档权限：

| 权限 | 含义 |
| --- | --- |
| `NONE` | 无控制权 |
| `OBSERVER` | 观察 / 查看，不允许修改 Actor |
| `OWNER` | 可完整操控 Actor |

GM 对全部 Actor 隐式拥有完整权限。每个 Player 可以拥有一个默认 Actor，以及多个 OWNER / OBSERVER Actor；默认 Actor 必须属于 OWNER。

## Combat Turn Lock

Combat 管理由 GM 负责，包括：

- 参战者加入 / 移出；
- Initiative；
- 先攻排序；
- 开始 / 结束 Combat；
- Round / Turn 推进。

Player 可以查看 Combat Tracker，但管理控件只读。

当 Combat active 时，Player 即使拥有多个 OWNER Actor，也只能修改**当前 Turn 对应的 OWNER Actor**。

权限检查采用两层结构：

```text
UI Action
  ↓
Client Preflight
  ↓
world.push
  ↓
Server authoritative validation
  ↓
accept / world.denied
```

因此前端隐藏按钮不是安全边界；Server 仍会拒绝越权 World 更新。

## Multiplayer

RPGmap 当前 Multiplayer V1 使用：

- 原生 WebSocket `/ws`；
- World Snapshot；
- `revision / baseRevision` 冲突保护；
- GM / Player；
- Presence；
- Persistent User；
- Actor Ownership；
- Combat Turn Lock；
- Cloudflare Quick Tunnel 一键公网入口。

主要共享：Actor / Token、位置、Health / Damage / Healing、Combat、Chat / Game Log、Scene / World 状态。

个人瞬时 UI，例如 Selection、Ruler、地图视角 / Zoom、Hover、当前打开窗口，不进入共享 World。

## 便携迁移

V1.4.2 会在新文件不存在时兼容迁移前两代目录：

```text
V1.4.1
map/world.json  → world/state.json
map/users.json  → world/users.json

更旧版本
data/worlds/default/world.json  → world/state.json
data/worlds/default/access.json → world/users.json
```

旧文件保留不删除；如果新的 `world/` 文件已经存在，则永远以新目录为准。

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

deployment/local-server/
├─ server.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ internet-launcher.mjs
├─ 操作说明.md
├─ world/README.txt
├─ maps/README.txt
└─ start / cloudflared scripts

tests/
文档/
```

## 文档职责

- `README.md`：项目整体介绍、架构和能力边界。
- `CHANGELOG.md`：版本级更新摘要。
- `文档/工作日志.md`：更详细的版本开发记录。
- `文档/联机使用说明.md`：User / Ownership / Combat Lock / 公网联机。
- `deployment/local-server/操作说明.md`：发布 ZIP 内面向 GM / Player 的实际操作说明。

## 版本规则

RPGmap 使用 `MAJOR.MINOR.PATCH`：

- Patch：Bug、权限、小型架构整理、兼容性，例如 `1.4.2`。
- Minor：完整新子系统，例如真正的多地图 / Scene System 可以进入后续 Minor 版本。
- Major：明显不兼容的 World、协议或核心架构变化。

V1.4.2 当前保持 Candidate / Draft 测试状态，完成实际设备验证后再进入 `main`。
