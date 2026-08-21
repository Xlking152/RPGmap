# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器地图工具，目标是逐步发展为类似 Foundry VTT 的可自托管跑团平台。地图内容通过独立 `MapPackage` 接入；仓库中的北宋兰州地图是当前开发与验证场景。

当前应用版本：**1.4.0**。

## 1.4.0 核心能力

```text
RPGmap
├─ MapPackage          地图与场景内容
├─ EntitySystem        Actor / Token / Form / Runtime / Effects
├─ SelectionSystem     单选、多选、矩形框选
├─ MovementSystem      Token 拖动、Waypoint、A*、移动成本与 Ghost
├─ MeasurementSystem   Ruler、角色测距、Waypoint、纯几何距离
├─ CombatSystem        参战者、先攻、顺序、轮次与当前回合
├─ HealthSystem        SimpleHP / WoundTrack
├─ DamageSystem        向所选 Token 应用最终伤害
├─ HealingSystem       向所选 Token 应用实际恢复量
├─ ChatSystem          聊天、Combat / Damage / Healing Game Log
├─ Multiplayer         GM / Player、WebSocket、World Snapshot 同步
├─ World Store         revision、冲突检查、服务器持久化
├─ Internet Launcher   Cloudflare Quick Tunnel 一键远程联机
└─ AppShell UI         顶栏、先攻表、聊天 / 角色库 / Inspector
```

## 快速启动

需要 Node.js `^20.19.0 || >=22.12.0`。

### 本机 / 局域网

发布包中：

- Windows：双击 `start-rpgmap.bat`
- Linux / macOS：执行 `./start-rpgmap.sh`
- 本机默认地址：`http://127.0.0.1:30000`
- 同一局域网设备可使用启动窗口显示的 `Network` 地址

### 远程联机（Windows）

双击：

```text
start-rpgmap-internet.bat
```

启动器会自动完成：

1. 检查可用的 `cloudflared`；没有时尝试自动安装 / 下载。
2. 使用 Cloudflare Quick Tunnel 创建临时 HTTPS 公网地址。
3. 使用 HTTP/2 over TCP，提高 VPN / TUN / 校园网等环境下的兼容性。
4. 自动生成 6 位 `Join Code` 和随机 `GM Secret`。
5. 启动 RPGmap Multiplayer Server，并把公网 URL 注入服务器状态。
6. 自动打开公网 RPGmap 页面。
7. 额外打开一个独立的 **RPGmap Multiplayer Info** 窗口，集中显示公网地址、Join Code 与 GM Secret，便于复制和观察。

玩家只需要收到两项：

```text
Public URL : https://xxxx-xxxx.trycloudflare.com
Join Code  : 123456
```

**不要把 GM Secret 发给玩家。** GM 在联机窗口选择 `GM` 并填写 GM Secret；玩家选择 `Player` 并填写 Join Code。

Quick Tunnel 是当前 V1.4 的便捷远程联机入口，适合个人跑团和测试。它的公网地址每次启动都会变化，关闭启动器后地址失效；长期固定公网部署后续可迁移到 Named Tunnel / 自有域名。

完整说明见：`文档/联机使用说明.md`。

## Multiplayer V1.4

### GM / Player

- 当前只区分 `GM` 与 `Player`，不要求注册、邮箱、OAuth 或 JWT。
- 公网模式通过 `Join Code` 控制 Player 加入，通过 `GM Secret` 授予 GM 身份。
- GM Secret 不应共享给普通玩家。
- 当前 V1.4 默认允许 Player 写共享 World，以满足共同移动 Token、战斗和状态更新的跑团需求；更细粒度 Actor Ownership 后续继续扩展。

### 实时同步

浏览器使用原生 WebSocket：

- HTTP 页面使用 `ws://`
- HTTPS 页面使用 `wss://`

当前以完整 World Snapshot 为第一阶段同步模型，覆盖主要持久状态，包括：

- Actor / Token
- Token 位置与生命状态
- Damage / Healing
- Combat / Initiative / Round / Turn
- Chat / Game Log
- Scene / World 状态

Selection、Ruler、地图视角、Hover、打开的 UI 面板等临时界面状态不会同步。

### World Store

Server 保存：

```text
data/worlds/<world-id>/world.json
```

World 使用 `revision` 管理版本。客户端提交携带 `baseRevision`；如果版本已经落后，Server 会返回最新 Snapshot，避免旧状态无条件覆盖新状态。World 写入使用临时文件 + rename，Server 重启后可恢复已有 World。

### 公网地址/API

`/api/health` 与 `/api/multiplayer` 会返回当前多人状态；公网启动模式下还包含当前 `publicUrl`。Server 启动信息块也会显示 `Public URL`。

## 主要操作

### Token 选择

- 左键点击 Token：单选
- 空白地图左键拖动：矩形框选
- `Shift + 点击 / 框选`：追加选择
- `Alt + 点击 / 框选`：移除选择
- `Space + 左拖`：平移地图

### Token 移动

- 直接拖动 Token：规划移动
- `Ctrl/Cmd` 拖动并松开：Waypoint 模式
- `Ctrl/Cmd + 左键` 或 `F`：添加 Waypoint
- 右键或 `Alt + F`：撤销最近 Waypoint
- `Enter`：确认移动
- `Esc`：取消移动
- 规划时滚轮：切换 5 / 10 / 20 / 50 / 100 m 吸附

### 测距

- `R`：开启 / 关闭 Ruler
- `Ctrl/Cmd + 左键` 或 `F`：增加测距 Waypoint
- 右键或 `Alt + F`：撤销 Waypoint
- `Shift + R`：从当前所选 Token 开始测距
- `Esc`：清除 Ruler

### 战斗

1. 选择参战 Token。
2. 点击“进入战斗”。
3. 左侧先攻表填写先攻。
4. 可拖动排序。
5. “开始战斗”进入第 1 轮。
6. “下一回合”推进当前行动者。
7. 新角色必须明确选择后点击“加入所选”。

### 伤害 / 恢复

右侧聊天面板包含消息、伤害与恢复入口。DamageSystem 接收已经完成防具、DR、免疫等前置计算后的最终伤害；HealingSystem 接收按规则换算后的实际恢复量。

生命系统同时支持：

- `SimpleHP`
- `WoundTrack`：完好 / B 冲击 / L 严重 / A 恶性

## 快捷键速查

| 操作 | 快捷方式 |
| --- | --- |
| 单选 Token | 左键单击 |
| 框选 Token | 空白地图左键拖动 |
| 追加选择 | `Shift + 点击 / 框选` |
| 移除选择 | `Alt + 点击 / 框选` |
| 平移地图 | `Space + 左拖` |
| 打开角色卡 | 双击 Token / 右键菜单 |
| 添加移动 / 测距 Waypoint | `Ctrl/Cmd + 左键` / `F` |
| 撤销 Waypoint | 右键 / `Alt + F` |
| 确认移动 | `Enter` |
| 取消移动 / 清除 Ruler | `Esc` |
| 开启 / 关闭 Ruler | `R` |
| 从所选角色测距 | `Shift + R` |
| 切换角色 Form | `V` |

## 源码开发

```bash
npm ci
npm test
npm run dev
```

生产构建：

```bash
npm run build
```

## 项目目录

```text
src/
├─ app/           持久化与应用辅助
├─ chat/          ChatSystem / Game Log
├─ combat/        CombatSystem
├─ damage/        DamageSystem
├─ engine/        地图核心、几何、导航、场景状态
├─ entities/      Actor / Token / Form / XLSX
├─ healing/       HealingSystem
├─ health/        SimpleHP / WoundTrack / Token 血条
├─ maps/          MapPackage
├─ measurement/   Ruler
├─ movement/      MovementSystem
├─ multiplayer/   Client WebSocket / GM / Player / World sync
├─ path/          路径显示辅助
├─ render/        场景与地图表现
├─ selection/     Token 选择
└─ ui/            AppShell UI

tests/            自动化测试
deployment/       Server、启动器与发布设施
文档/             工作日志、联机说明、开发说明与规划
```

## 文档

- `CHANGELOG.md`：正式版本更新日志。
- `文档/工作日志.md`：开发阶段和历史实现记录。
- `文档/联机使用说明.md`：V1.4 GM / Player、局域网和公网联机说明。
- `文档/未来规划.md`：后续服务器、权限与多人能力路线。
- `文档/开发说明.md`：代码结构和开发约定。
- `deployment/local-server/README.md`：Release ZIP 内的运行与操作说明。

## V1.4 当前边界

- Cloudflare Quick Tunnel 是便捷临时公网入口，不提供固定地址或生产 SLA。
- 当前权限粒度为 GM / Player；Actor Ownership 与更细权限尚未加入。
- 当前同步模型以完整 World Snapshot 为主；极端高频并发编辑仍可能触发 revision conflict 并回载 Server 最新状态。
- 长期公网部署应采用固定域名 / Named Tunnel，并继续增强认证、安全与备份策略。

## 版本规则

RPGmap 使用语义化版本：

- Patch，例如 `1.4.1`：Bug 修复、小交互调整、兼容性修正。
- Minor，例如 `1.5.0`：新增较完整功能或子系统，同时尽量保持已有数据兼容。
- Major，例如 `2.0.0`：存在明显不兼容的数据、服务器协议或核心架构变化。

GitHub Release 使用应用版本号，例如 `v1.4.0`。
