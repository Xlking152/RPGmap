# RPGmap 1.4.1 · Server / 操作指南

这是 RPGmap V1.4.1 测试 / 发布包内的运行说明。V1.4.1 加入持久 Player User、Actor Ownership、Combat Turn Lock，并把发布包整理为便携的 `app/ + map/` 结构。

## 一、发布包目录

```text
RPGmap-v1.4.1/
├─ app/                    前端程序文件
├─ map/                    当前地图 / 跑团的全部默认可写数据
│  ├─ world.json           运行后生成
│  ├─ users.json           有正式 Player User 后生成
│  ├─ uploads/
│  ├─ backups/
│  └─ README.txt
├─ docs/
├─ server.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ internet-launcher.mjs
├─ start-rpgmap.bat
├─ start-rpgmap-internet.bat
└─ ...
```

**要备份、迁移或复制当前跑团，重点备份整个 `map/` 文件夹。**

RPGmap 默认不把 World / User 数据写到 AppData、用户主目录或其他隐藏目录；它们跟发布包放在一起。

## 二、启动方式

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

启动器会自动检测 `cloudflared`、创建 Quick Tunnel、生成 Join Code / GM Secret、启动 Server，并打开公网网页与独立信息窗口。

新玩家通常只需要：

```text
Public URL + Join Code
```

不要发送 GM Secret。

已有持久 User 在 Quick Tunnel 地址变化后恢复身份时，还需要自己保存的 Player Key。

## 三、User 创建：推荐流程

1. Player 打开地址，选择 `Player`，填写名称 + Join Code。
2. Player 进入“等待 GM 批准”，暂时没有 World 写权限。
3. GM 点击顶栏“联机”。
4. 在“待批准 Player”中设置正式 User 名称和默认角色。
5. 点击“批准并绑定”。
6. Server 创建持久 User；默认角色自动获得 OWNER。
7. Player 保存第一次显示的 Player Key。

GM 也可以提前“预创建 Player User”，再把 Player Key 私下发给对应玩家。

## 四、Player Key 与自动登录

- Browser Auth Token：同一网址刷新 / 重连时自动使用。
- Player Key：长期恢复身份；新的 Quick Tunnel 域名上手动输入。

Server 只保存凭证哈希，不保存明文 Player Key / Token。

GM 点击“重发 Player Key”会使旧 Player Key 和旧浏览器 Token 同时失效。

## 五、User / World 数据

现在统一位于地图根目录：

```text
map/world.json
map/users.json
map/uploads/
map/backups/
```

- `world.json`：Actor / Token / Scene / Combat / Chat 等共享 World。
- `users.json`：持久 Player User、默认角色、Ownership 和凭证哈希。
- `uploads/`：当前地图 / 跑团上传资源。
- `backups/`：预留给本地备份。

`users.json` 不进入 World Snapshot，因此 Player 不能通过修改 World 获得更多权限。

### 从旧 V1.4.1 测试包迁移

如果新目录中还没有 `map/world.json` / `map/users.json`，Server 会尝试读取同一程序目录里的旧结构：

```text
data/worlds/default/world.json
data/worlds/default/access.json
```

并复制到新位置。旧文件不会被删除。

## 六、Actor Ownership

权限：

- `NONE`：无控制权。
- `OBSERVER`：观察 / 查看，不允许修改 Actor。
- `OWNER`：可操控 Actor。

GM 对全部 Actor 隐式拥有完整权限。每个 Player 可以有一个默认角色、多个 OWNER 和多个 OBSERVER；默认角色必须是 OWNER。

## 七、Combat Turn Lock

以下 Combat 操作为 GM-only：参战者增删、Initiative、拖动排序、开始/结束 Combat、Round / Turn 推进。

Player 可以查看 Combat Tracker。Combat active 后，即使 Player 有多个 OWNER Actor，也只能操控当前 Turn 对应的 OWNER Actor。

Token 移动开始和最终提交前都会检查 Ownership / Turn；Server 仍会进行最终强制校验。

## 八、实机验收建议

1. GM + Player A + Player B 分别登录。
2. GM 批准两个 Player 并分配不同 Actor。
3. A 只能修改 A，B 只能修改 B。
4. 验证额外 OWNER 与 OBSERVER。
5. 开始 Combat，验证控制权随 Turn 切换。
6. 验证 Player 不能改 Initiative / 排序 / Turn。
7. 重启 Quick Tunnel，用新 URL + Join Code + Player Key 恢复 User。
8. 重启 Server，确认 `map/world.json` 和 `map/users.json` 恢复。
9. 把整个 RPGmap 文件夹复制到另一个目录启动，确认 `map/` 数据随包迁移。
10. 重发 Player Key，确认旧身份失效。

完整说明：`docs/MULTIPLAYER-GUIDE.md`。
