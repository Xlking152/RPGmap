# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器地图工具，目标是逐步发展为类似 Foundry VTT 的可自托管跑团平台。地图内容通过独立 `MapPackage` 接入；仓库中的北宋兰州地图是当前开发与验证场景。

当前 V1.4.1 Candidate 正在 Draft PR #8 中进行实机验收；稳定 `main` 在该 PR 合并前仍为 V1.4.0。

## V1.4.1 核心能力

```text
RPGmap
├─ MapPackage          地图与场景内容
├─ EntitySystem        Actor / Token / Form / Runtime / Effects
├─ SelectionSystem     单选、多选、矩形框选
├─ MovementSystem      Token 拖动、Waypoint、A*、移动成本与 Ghost
├─ MeasurementSystem   Ruler、角色测距、Waypoint、纯几何距离
├─ CombatSystem        先攻、轮次、当前回合 + GM Turn Control
├─ Health / Damage     HP、伤害与恢复
├─ ChatSystem          聊天与 Game Log
├─ Multiplayer         WebSocket、GM / Player、Presence
├─ Player Identity     Persistent User + Player Key
├─ Actor Ownership     NONE / OBSERVER / OWNER
├─ Combat Turn Lock    仅当前 Turn 的 OWNER Actor 可由 Player 修改
├─ Portable Storage    app/ 程序 + map/ 跑团数据
└─ Internet Launcher   Cloudflare Quick Tunnel 一键远程联机
```

## 发布包：完全便携的数据布局

V1.4.1 把程序文件和地图可写数据明确分开：

```text
RPGmap-v1.4.1/
├─ app/                    前端程序
├─ map/                    当前跑团全部默认可写数据
│  ├─ world.json
│  ├─ users.json
│  ├─ uploads/
│  ├─ backups/
│  └─ README.txt
├─ docs/
├─ server.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ internet-launcher.mjs
├─ start-rpgmap.bat
└─ start-rpgmap-internet.bat
```

默认情况下，RPGmap 的 World / User / Ownership / 上传资源**不会写入 AppData 或其他隐藏 User Data 目录**，而是跟当前 RPGmap 文件夹一起保存在 `map/`。

因此：

- 备份当前跑团：备份整个 `map/`。
- 搬到另一块硬盘 / 另一台电脑：复制整个 RPGmap 文件夹。
- 升级程序：保留旧 `map/`，替换程序文件即可。

旧 V1.4.x 测试结构 `data/worlds/default/world.json` / `access.json` 在新 `map/` 文件不存在时会自动迁移，旧文件不会自动删除。

## 快速启动

需要 Node.js `^20.19.0 || >=22.12.0`。

### 本机 / 局域网

- Windows：双击 `start-rpgmap.bat`
- Linux / macOS：执行 `./start-rpgmap.sh`
- 本机：`http://127.0.0.1:30000`
- LAN：使用启动窗口显示的 `Network` 地址

### Windows 远程联机

双击：

```text
start-rpgmap-internet.bat
```

启动器自动创建 Cloudflare Quick Tunnel、生成 Join Code / GM Secret、启动 Server 并打开公网页面。

新玩家通常只需要：

```text
Public URL + Join Code
```

GM Secret 只供 GM 使用。

## User / Identity

```text
Session → Persistent User → Default Actor / Ownership
```

推荐流程：

1. Player 用 Join Code 首次加入。
2. Player 进入 pending，等待 GM 批准。
3. GM 在“联机 / Users”中指定 User 名称和默认角色。
4. GM 批准后 Server 创建持久 User，并给默认角色 OWNER。
5. Player 保存第一次获得的 Player Key。

GM 也可以预创建 Player User，然后私下把 Player Key 发给对应玩家。

### Player Key

Quick Tunnel 每次重启通常会换域名，而浏览器 localStorage 不能跨域共享。

因此：

- `authToken`：同一网址内自动重连。
- `Player Key`：在新的 Quick Tunnel 地址恢复原 User。

Server 只保存 Token / Player Key 的 SHA-256 哈希，不保存明文凭证。

## 数据保存

共享 World：

```text
map/world.json
```

Player User / 权限：

```text
map/users.json
```

上传与备份：

```text
map/uploads/
map/backups/
```

`users.json` 与 World Snapshot 分离，Player 不能通过 World 更新修改自己的 Ownership。

## Actor Ownership

| 权限 | 作用 |
| --- | --- |
| NONE | 无控制权 |
| OBSERVER | 观察 / 查看，不允许修改 Actor |
| OWNER | 可操控和修改 Actor |

每个 Player 可以有一个默认 Actor、多个 OWNER Actor 和多个 OBSERVER Actor。默认 Actor 必须属于 OWNER。GM 对全部 Actor 隐式拥有完整权限。

## Combat Turn Lock

Combat 管理由 GM 负责：

- 参战者加入 / 移出
- Initiative
- 拖动先攻排序
- 开始 / 结束 Combat
- Round / Turn 推进

Player 可以查看 Combat Tracker，但管理控件为只读。

`Combat.state === active` 时，Player 即使拥有多个 OWNER Actor，也只能修改当前 Turn 对应的 OWNER Actor。

Movement 会在 Token 开始拖动和最终提交前主动检查；Server 还会对所有 World 更新做最终权限校验。

## Server-authoritative 权限

```text
UI Action
  ↓
Client Ownership Preflight
  ↓
world.push
  ↓
Server Diff + Ownership + Combat Validation
  ↓
accept / world.denied
```

因此 Player 不能通过手动构造 WebSocket 消息来修改非 OWNER Actor、Combat 流程或 User / Ownership 数据。

## 联机面板

### GM

- 在线 GM / Player
- 待批准 Player
- 预创建 Player User
- 默认角色
- NONE / OBSERVER / OWNER
- Player Key 重发
- User 删除

### Player

- 在线 User / GM
- 自己的默认角色
- OWNER / OBSERVER 列表
- 在自己的 OWNER Actor 中切换默认角色

## World 同步

V1.4.1 仍使用完整 World Snapshot + `revision / baseRevision` 作为第一阶段同步模型，并在 Server 增加权限 diff 校验。

共享：Actor / Token、位置、Health / Damage / Healing、Combat、Chat / Game Log、Scene / World 状态。

不共享个人瞬时 UI：Selection、Ruler、地图视角 / Zoom、Hover、当前打开的窗口。

## 主要操作

- Token 单选：左键
- 框选：空白地图左拖
- Shift：追加选择
- Alt：移除选择
- Token 移动：直接拖动
- Waypoint：Ctrl/Cmd + 点击或 `F`
- 确认移动：Enter
- 取消：Esc
- Ruler：`R`
- 从角色测距：`Shift + R`
- 切换 Form：`V`

Player 的 Actor 操作受 Ownership / Combat Turn Lock 约束。

## V1.4.1 实机验收建议

1. GM 登录。
2. Player A / B 首次申请并由 GM 批准。
3. A 只能操作 A，B 只能操作 B。
4. 测试额外 OWNER 与 OBSERVER。
5. 开始 Combat，验证控制权随 Turn 切换。
6. Player 验证无法修改 Initiative / 排序 / Turn。
7. 重启 Quick Tunnel，用新 URL + Join Code + Player Key 恢复 User。
8. 重启 Server，验证 `map/world.json` + `map/users.json` 恢复。
9. 将整个 RPGmap 文件夹复制到另一目录，确认 `map/` 数据跟随迁移。
10. 重发 Player Key，确认旧身份失效。
11. 在含旧 `data/worlds/default/` 的目录中启动，验证自动迁移。

完整联机说明：`文档/联机使用说明.md`。

## 项目目录

```text
src/
├─ app/
├─ chat/
├─ combat/
├─ engine/
├─ entities/
├─ movement/
├─ multiplayer/
└─ ...

deployment/local-server/
├─ server.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ internet-launcher.mjs
├─ map/README.txt
└─ start / cloudflared scripts

tests/
文档/
```

## 版本规则

- Patch：Bug 修复、权限增强、小交互与兼容性，例如 `1.4.1`
- Minor：较完整的新子系统，例如 `1.5.0`
- Major：明显不兼容的数据 / 协议 / 架构变化，例如 `2.0.0`

V1.4.1 当前保持 Draft 测试状态，真实设备验收完成后再合并到 `main`。
