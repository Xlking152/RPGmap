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
├─ HealthSystem        SimpleHP / WoundTrack
├─ Damage / Healing    角色伤害与恢复
├─ ChatSystem          聊天与 Game Log
├─ Multiplayer         WebSocket、GM / Player、Presence
├─ Player Identity     Persistent User + Player Key
├─ Actor Ownership     NONE / OBSERVER / OWNER
├─ Combat Turn Lock    战斗中仅当前 Turn 的 OWNER Actor 可由 Player 修改
├─ World Store         world.json + revision
├─ Access Store        access.json + User / Ownership / Credential Hash
└─ Internet Launcher   Cloudflare Quick Tunnel 一键远程联机
```

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

启动器自动：

1. 检测 / 安装 `cloudflared`
2. 创建 Cloudflare Quick Tunnel
3. 强制使用 HTTP/2 over TCP
4. 解析 `https://*.trycloudflare.com` Public URL
5. 生成 Join Code / GM Secret
6. 启动 RPGmap Multiplayer Server
7. 自动打开公网页面
8. 打开独立 `RPGmap Multiplayer Info` 窗口

新玩家通常只需要：

```text
Public URL + Join Code
```

GM Secret 只供 GM 使用。

## V1.4.1 User / Identity

V1.4.1 将“当前 WebSocket Session”与“持久 Player User”分开：

```text
Session → User → Default Actor / Ownership
```

### 推荐 User 创建流程

1. Player 输入 Join Code 首次加入。
2. Player 进入 pending 状态，等待 GM 批准。
3. GM 打开顶栏“联机 / Users”。
4. GM 为该 Player 指定 User 名称和默认角色。
5. GM 点击批准。
6. Server 创建持久 User，并给默认角色 OWNER。
7. Player 保存第一次获得的 Player Key。

GM 也可以在开团前直接“预创建 Player User”，然后把生成的 Player Key 私下发给对应玩家。

### 为什么还需要 Player Key

Quick Tunnel 每次重启通常会换一个域名，而浏览器的 localStorage 不能跨域共享。

因此：

- `authToken`：用于同一网址内自动重连。
- `Player Key`：用于新 Quick Tunnel 地址恢复原 User。

已有 User 在新 URL 登录时填写：

```text
当前 Join Code + 自己的 Player Key
```

Server 只保存 Token / Player Key 的 SHA-256 哈希，不保存明文凭证。GM 可以重新签发 Player Key，使旧 Key 和旧浏览器 Token 同时失效。

## Actor Ownership

每个 Player User 可以拥有：

- 一个默认 Actor
- 多个 OWNER Actor
- 多个 OBSERVER Actor

权限等级：

| 权限 | 作用 |
| --- | --- |
| NONE | 无控制权 |
| OBSERVER | 观察 / 查看，不允许修改 Actor |
| OWNER | 可操控和修改 Actor |

GM 对全部 Actor 隐式拥有完整权限。

Player 不能通过 World Snapshot 修改自己的 Ownership；权限数据库由 Server 单独管理。

## Combat Turn Lock

Combat 管理由 GM 负责：

- 加入 / 移出 Combatant
- Initiative
- 拖动先攻排序
- 开始 / 结束 Combat
- Round / Turn 推进

Player 可以查看 Combat Tracker，但管理控件为只读。

当：

```text
Combat.state === active
```

时，Player 即使拥有多个 OWNER Actor，也只能修改**当前 Turn 对应的 OWNER Actor**。GM 始终可操作任何 Actor。

Movement 会在 Token 开始拖动和最终提交前主动检查；所有 World 更新还会经过 Server 的最终权限校验。

## Server-authoritative 权限

V1.4.1 不把“按钮隐藏”当作安全边界：

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

因此即使手动构造 WebSocket 消息，Player 也不能：

- 修改非 OWNER Actor
- 创建 / 删除 / 重绑 Actor / Token
- 修改 Combatant / Initiative / Round / Turn
- 删除或改写旧 Chat / Game Log
- 通过 World Snapshot 改写 User / Ownership

## 数据保存

默认 World：

```text
data/worlds/default/world.json
```

Player User / 权限：

```text
data/worlds/default/access.json
```

两者物理分离并分别持久化。

`world.json` 保存共享跑团状态；`access.json` 保存 User、默认角色、Ownership、凭证哈希与 disabled 状态。

## 联机面板

### GM

顶栏“联机”可查看 / 管理：

- 在线 GM / Player
- 默认角色
- 待批准 Player
- 预创建 Player User
- NONE / OBSERVER / OWNER
- Player Key 重发
- User 删除

### Player

可查看：

- 当前在线 User / GM
- 各 User 默认角色
- 自己的 OWNER / OBSERVER 列表
- 自己的默认角色

Player 可以在自己的 OWNER Actor 中切换默认角色。

## World 同步

V1.4.1 仍采用完整 World Snapshot + `revision / baseRevision` 作为第一阶段同步模型。

主要共享：

- Actor / Token
- Token 位置
- Health / Damage / Healing
- Combat
- Chat / Game Log
- Scene / World 状态

不共享个人瞬时 UI：

- Selection
- Ruler
- 地图视角 / Zoom
- Hover
- 当前打开的窗口

后续多人并发需求继续增长时，可以把完整 Snapshot 演进为 patch / operation 同步。

## 主要操作

### Token 选择

- 左键：单选
- 空白地图左拖：框选
- Shift：追加
- Alt：移除
- Space + 左拖：平移地图

### Token 移动

- 直接拖动：规划移动
- Ctrl/Cmd 拖动：Waypoint 模式
- Ctrl/Cmd + 左键 / `F`：添加 Waypoint
- 右键 / Alt+F：撤销 Waypoint
- Enter：确认移动
- Esc：取消
- 规划时滚轮：切换吸附档位

### 测距

- `R`：Ruler
- `Shift + R`：从当前角色测距
- Ctrl/Cmd + 左键 / `F`：增加 Waypoint
- Esc：清除

### Actor

- 双击 Token / 右键菜单：打开角色卡
- `V`：切换 Form

这些 Actor 操作在 Multiplayer Player 模式下受 Ownership / Combat Turn Lock 约束。

## V1.4.1 实机验收建议

1. GM 登录。
2. Player A 首次申请 → GM 批准 → Actor A。
3. Player B 首次申请 → GM 批准 → Actor B。
4. A 能移动 A，不能移动 B。
5. B 能移动 B，不能移动 A。
6. 给 A 额外 OWNER Actor，验证多角色控制。
7. 给一个 Actor OBSERVER，验证不能修改。
8. 开始 Combat，验证只有当前 Turn 的 OWNER Actor 可操作。
9. Player 验证无法修改 Initiative / 排序 / Turn。
10. 重启 Quick Tunnel，使用新 URL + Join Code + Player Key 恢复同一 User。
11. 重启 Server，验证 `world.json` + `access.json` 恢复。
12. 重发 Player Key，验证旧身份失效。

完整联机说明：`文档/联机使用说明.md`。

## 项目目录

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
├─ path/
├─ render/
├─ selection/
└─ ui/

deployment/local-server/
├─ server.mjs
├─ access-control.mjs
├─ internet-launcher.mjs
└─ start / cloudflared scripts

tests/
文档/
```

## 文档

- `CHANGELOG.md`：版本更新
- `文档/联机使用说明.md`：User / Ownership / Combat Lock / 公网联机
- `文档/工作日志.md`：开发过程
- `文档/未来规划.md`：后续路线
- `文档/开发说明.md`：代码结构与开发约定

## 版本规则

- Patch：Bug 修复、权限增强、小交互与兼容性，例如 `1.4.1`
- Minor：较完整的新子系统，例如 `1.5.0`
- Major：明显不兼容的数据 / 协议 / 架构变化，例如 `2.0.0`

V1.4.1 当前保持 Draft 测试状态，真实设备验收完成后再合并到 `main`。
