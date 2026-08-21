# RPGmap 1.4.0 · Server / 操作指南

这是 RPGmap 1.4.0 发布包内的运行说明。V1.4 已包含 Multiplayer Server、World Store、GM / Player 与 Windows 一键公网联机。

## 一、启动方式

### Windows：本机 / 局域网

双击：

```text
start-rpgmap.bat
```

默认本机地址：

```text
http://127.0.0.1:30000
```

同一局域网设备可使用启动窗口显示的 `Network` 地址。

### Windows：远程公网联机

双击：

```text
start-rpgmap-internet.bat
```

启动器会自动检测 `cloudflared`，创建 Cloudflare Quick Tunnel，生成 Join Code / GM Secret，启动 Multiplayer Server，并自动打开公网页面。

随后还会打开一个独立的 `RPGmap Multiplayer Info` 信息窗口，其中集中显示：

- Public URL
- Join Code
- GM Secret
- Local URL
- 当前版本

玩家只需要 **Public URL + Join Code**。不要把 GM Secret 发给 Player。

### Linux / macOS

```bash
chmod +x start-rpgmap.sh
./start-rpgmap.sh
```

当前一键 Cloudflare Internet Launcher 主要面向 Windows；其他系统可以自行运行 Server 并配置反向代理 / Tunnel。

## 二、联机身份

### GM

- 身份选择 `GM`
- 公网模式填写 `GM Secret`
- Join Code 可留空

### Player

- 身份选择 `Player`
- 填写 6 位 Join Code
- GM Secret 留空

成功后顶栏显示身份与在线人数。

## 三、共享 World

默认 World Store：

```text
data/worlds/default/world.json
```

当前同步内容主要包括 Actor、Token、位置、Health、Damage、Healing、Combat、Chat / Game Log 与 Scene 状态。

Selection、Ruler、地图视角和其他瞬时 UI 不同步。

World 使用 revision 管理冲突；Server 重启后会恢复持久化 World。

## 四、Token / Movement / Ruler

- 左键 Token：单选
- 空白地图左拖：框选
- `Shift`：追加选择
- `Alt`：移除选择
- `Space + 左拖`：平移地图
- 直接拖动 Token：移动规划
- `Ctrl/Cmd + 左键` 或 `F`：添加 Waypoint
- 右键或 `Alt + F`：撤销 Waypoint
- `Enter`：确认移动
- `Esc`：取消移动
- `R`：Ruler 开关
- `Shift + R`：从所选角色测距

## 五、Combat

1. 选择参战 Token。
2. 点击“进入战斗”。
3. 左侧填写先攻。
4. 可拖动调整顺序。
5. 点击“开始战斗”。
6. 使用“下一回合”推进轮次。
7. 新角色需要选择后点击“加入所选”。

Combat 状态会进入 Multiplayer World 同步。

## 六、Damage / Healing / Health

RPGmap 支持：

- `SimpleHP`
- `WoundTrack`：完好 / B 冲击 / L 严重 / A 恶性

右侧聊天页可应用最终伤害和实际恢复量，并写入 Game Log。Token 上方生命条会随状态变化刷新。

## 七、Chat / Game Log

右侧聊天页记录：

- 普通聊天
- Combat 事件
- Damage
- Healing
- 后续可扩展 Roll / Check

这些持久消息会随 World 同步。

## 八、公网联机说明

`start-rpgmap-internet.bat` 使用 Cloudflare Quick Tunnel。当前启动器强制 `HTTP/2 over TCP`，用于提高 VPN / TUN、校园网和限制 UDP 网络下的兼容性。

Quick Tunnel：

- 无需 Cloudflare 账号
- 无需自有域名
- 每次启动随机生成 `trycloudflare.com` URL
- 启动器关闭后 URL 失效
- 适合个人跑团与便捷联机
- 长期固定服务器后续建议 Named Tunnel / 自有域名

详细流程见 `docs/MULTIPLAYER-GUIDE.md` 或仓库 `文档/联机使用说明.md`。

## 九、Release 包主要内容

```text
public/                     预编译 Web Client
server.mjs                  Multiplayer Server
internet-launcher.mjs       公网一体化启动器
start-rpgmap.bat            本机 / LAN 启动
start-rpgmap.sh             Linux / macOS 启动
start-rpgmap-internet.bat   Windows 一键公网联机
setup-cloudflared.bat       cloudflared 检测 / 安装
run-rpgmap-public-server.bat 手动公网 Server 入口
data/                       World / uploads / backups
VERSION.json                版本 / Build 信息
docs/MULTIPLAYER-GUIDE.md   联机使用说明
README.md                   本文件
```

## 十、服务器 API

- `/api/health`
- `/api/version`
- `/api/multiplayer`
- `/ws`

公网启动时 `/api/health` 和 `/api/multiplayer` 的 Multiplayer 信息包含当前 `publicUrl`。

## 十一、当前边界

- 当前权限模型为 GM / Player，没有 Actor Ownership。
- Player 默认可写共享 World。
- 当前同步主要使用完整 World Snapshot；高频并发编辑可能触发 revision conflict，并回载 Server 最新状态。
- Quick Tunnel 不提供固定公网地址或生产 SLA。

应用版本：**1.4.0**。
