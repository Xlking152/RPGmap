# RPGmap 1.4.1 · Server / 操作指南

这是 RPGmap V1.4.1 测试 / 发布包内的运行说明。V1.4.1 在 V1.4 Multiplayer 的基础上加入持久 Player User、Actor Ownership 和 Combat Turn Lock。

## 一、启动方式

### Windows：本机 / 局域网

双击：

```text
start-rpgmap.bat
```

本机默认：`http://127.0.0.1:30000`。同一局域网设备使用启动窗口显示的 `Network` 地址。

### Windows：远程公网联机

双击：

```text
start-rpgmap-internet.bat
```

启动器会自动检测 `cloudflared`、创建 Quick Tunnel、生成 Join Code / GM Secret、启动 Server，并打开公网网页与独立 `RPGmap Multiplayer Info` 信息窗口。

GM 首次发给普通新玩家：

```text
Public URL + Join Code
```

不要发送 GM Secret。

已有持久 User 在 Quick Tunnel 地址变化后恢复身份时，玩家还需要自己保存的：

```text
Player Key
```

## 二、User 创建：推荐流程

1. Player 打开地址，选择 `Player`，填写名称 + Join Code。
2. Player 进入“等待 GM 批准”。此时没有 World 写权限。
3. GM 点击顶栏“联机”。
4. 在“待批准 Player”中设置正式 User 名称和默认角色。
5. 点击“批准并绑定”。
6. Server 创建持久 User；默认角色自动获得 OWNER。
7. Player 保存第一次显示的 Player Key。

GM 也可以在“预创建 Player User”中提前建立 User，并把生成的 Player Key 私发给玩家。

## 三、Player Key 与自动登录

RPGmap 使用两种 Player 凭证：

- Browser Auth Token：同一网址刷新 / 重连时自动使用。
- Player Key：长期恢复身份；新的 Quick Tunnel 域名上手动输入。

Cloudflare Quick Tunnel 的域名通常每次启动都会变化，因此 **Player Key 是跨新公网地址恢复同一个 User 的必要补充**。

Server 只保存凭证哈希，不保存明文 Player Key / Token。

GM 点击“重发 Player Key”会使旧 Player Key 和旧浏览器 Token 同时失效。

## 四、User / World 数据

```text
data/worlds/default/world.json
data/worlds/default/access.json
```

- `world.json`：Actor / Token / Scene / Combat / Chat 等共享 World。
- `access.json`：持久 Player User、默认角色、Ownership 和凭证哈希。

Access 数据不进入 World Snapshot，Player 不能通过修改 World 获得更多权限。

## 五、Actor Ownership

权限：

- `NONE`：无控制权。
- `OBSERVER`：观察 / 查看，不允许修改 Actor。
- `OWNER`：可操控 Actor。

GM 对全部 Actor 隐式拥有完整权限。

每个 Player 可有：

```text
默认角色：1 个
OWNER：多个
OBSERVER：多个
```

默认角色必须属于 OWNER。

GM 在“联机 / Users”面板中可为每个 Player 调整所有 Actor 的权限。

## 六、Player 的控制范围

战斗外，Player 可以正常操控自己的 OWNER Actor，例如：

- 移动 Token
- 修改角色资源 / 状态
- 切换 Form
- 使用与自己角色有关的常规操作
- 聊天、测距和个人 UI

Player 不能创建 / 删除 / 重绑 Actor 或 Token，不能修改其他人的 Actor，也不能改已有 Chat / Game Log 历史。

客户端会先进行权限预检；Server 会对每次 `world.push` 再进行最终校验。

## 七、Combat Turn Lock

以下 Combat 操作是 GM-only：

- 建立 / 加入 / 移出 Combatant
- 修改 Initiative
- 拖动先攻顺序
- 开始 / 结束 Combat
- 推进 Round / Turn

Player 可以查看 Combat Tracker。

Combat active 后，即使 Player 有多个 OWNER Actor，也只能操控**当前 Turn 对应的那个 Actor**。GM 始终不受 Turn Lock 限制。

Token 移动在开始拖动和提交前都会检查 Ownership / Turn；不满足条件时直接提示。

## 八、联机面板

### GM 看到

- 当前在线 GM / Player
- 每个 User 的默认角色
- 待批准 Player
- 预创建 User
- NONE / OBSERVER / OWNER
- Player Key 重发
- User 删除

### Player 看到

- 在线 User 与默认角色
- 自己的默认角色
- 自己的 OWNER / OBSERVER 列表
- 在自己 OWNER Actor 中切换默认角色

## 九、角色 / Token / 战斗基本操作

原有 V1.4 操作保持不变：

- Token 单选：左键
- 框选：空白地图左拖
- Shift：追加选择
- Alt：移除选择
- Token 移动：直接拖动
- Movement Waypoint：Ctrl/Cmd + 点击或 `F`
- 确认移动：Enter
- 取消：Esc
- Ruler：`R`
- 从角色测距：`Shift + R`
- 切换 Form：`V`

Player 的这些 Actor 操作会受到 Ownership / Combat Turn Lock 限制。

## 十、实机验收建议

建议至少 GM + 两个 Player：

1. 两个 Player 分别首次申请并由 GM 批准。
2. A 只能移动 A 的角色，B 只能移动 B 的角色。
3. GM 给 A 额外 OWNER Actor，确认可操控多个角色。
4. 将一个 Actor 改成 OBSERVER，确认 Player 不能修改。
5. 开始 Combat，确认只有当前 Turn 的对应 Player/Actor 可操作。
6. Player 确认不能修改先攻、排序或推进 Turn。
7. 重启 Quick Tunnel，用新 URL + Join Code + Player Key 恢复原 User。
8. 重启 Server，确认 `world.json` 与 `access.json` 均恢复。
9. 重发 Player Key，确认旧身份失效。

完整说明：`docs/MULTIPLAYER-GUIDE.md`。
