# RPGmap Internet Multiplayer Test

当前正式版本仍为 **1.3.0**。本说明用于 `feat/multiplayer-v1` 的跨地区联机测试，不代表正式 1.4.0 已发布。

## Windows 一键测试

1. 解压完整 Multiplayer 测试包。
2. 双击 `start-rpgmap-internet.bat`。
3. 第一次运行如果没有可用的 `cloudflared`，脚本会按以下顺序尝试：
   - 使用包目录中的 `cloudflared.exe`；
   - 使用系统 PATH 中已经安装的 `cloudflared.exe`；
   - 从 Cloudflare 官方 GitHub Release 下载 Windows amd64 版本（先尝试 curl，再尝试 PowerShell）；
   - 如果直接下载仍失败，尝试 Windows Package Manager `winget install --id Cloudflare.cloudflared --exact`。
4. 启动脚本会自动生成：
   - 6 位 `Player Join Code`；
   - 随机 `GM Secret`。
5. RPGmap Server 会以 `RPGMAP_PUBLIC=1` 启动；本机浏览器随后打开 `http://127.0.0.1:30000`。
6. Cloudflare Quick Tunnel 窗口会打印随机公网地址，例如：

```text
https://example-random.trycloudflare.com
```

7. GM 在本机 RPGmap 联机窗口中选择 `GM`，输入启动窗口显示的 `GM Secret`。
8. 只把 **公网 HTTPS 地址 + Player Join Code** 发给异地玩家。不要把 GM Secret 发给 Player。
9. Player 在任意地区使用浏览器打开公网 HTTPS 地址，选择 `Player`，输入显示名称和 Player Join Code 后加入。

浏览器通过 HTTPS 访问时，RPGmap Multiplayer Client 会自动使用 `wss://<同一域名>/ws` 连接 WebSocket。

## 如果出现 cloudflared download failed

这通常表示当前网络无法正常访问 GitHub Release Assets，而不是 RPGmap Server 本身故障。

最直接的手动处理方法：

1. 打开 Cloudflare 官方 Tunnel Downloads 页面；
2. 下载 Windows 64-bit Executable；
3. 如果文件名是 `cloudflared-windows-amd64.exe`，将其改名为 `cloudflared.exe`；
4. 把 `cloudflared.exe` 放到与 `start-rpgmap-internet.bat`、`server.mjs` 相同的 RPGmap 根目录；
5. 双击 `cloudflared.exe` 不需要进行安装；重新运行 `start-rpgmap-internet.bat` 即可。

也可以先在 Windows Terminal / CMD 中安装：

```text
winget install --id Cloudflare.cloudflared --exact
```

新版启动脚本会自动识别系统 PATH 中已经安装的 `cloudflared`。

如果浏览器本身也无法打开 GitHub Release 下载文件，请更换一个能够正常访问该下载资源的网络完成这一次下载；`cloudflared.exe` 下载成功后可长期保留在 RPGmap 目录中，以后启动不需要重复下载。

## 当前安全边界

Internet Test 模式不是完整公网账号系统：

- RPGmap 仍只区分 GM / Player；
- Player 通过 Join Code 加入当前 World；
- GM 通过 GM Secret 获得 GM 身份；
- 不做注册、密码、邮箱、OAuth、JWT；
- 当前 Multiplayer V1 为了测试双向同步，Player 默认仍可写共享 World；
- 不要把测试公网 URL、Join Code 或 GM Secret 发布到公开论坛；
- 测试结束后关闭 Cloudflare Tunnel 窗口和 RPGmap Server 窗口。

## Cloudflare Quick Tunnel 定位

Quick Tunnel 只用于开发 / 测试：

- 不需要 Cloudflare 账号或自有域名；
- 每次启动会获得新的随机 `trycloudflare.com` URL；
- 支持 HTTPS 和 WebSocket；
- URL 不保证长期有效，也没有生产 SLA；
- 正式长期公网部署应改为 Named Tunnel / 自有域名，并增加更严格权限与安全策略。

## 推荐测试项目

请至少用两台不在同一局域网的设备测试：

1. GM 移动 Token，Player 是否实时同步；
2. Player 移动 Token，GM 是否实时同步；
3. Damage / Healing 与 Token 血条；
4. Combat / 下一回合；
5. Chat / Game Log；
6. Player 刷新浏览器后能否恢复当前 World；
7. 短暂断网后重新连接是否能重新取得 Server Snapshot；
8. GM 关闭 Tunnel 后，远端地址是否立即不可继续访问；
9. 重新启动 Internet 模式后，虽然公网 URL 改变，但 `data/worlds/default/world.json` 是否仍能恢复原 World。

## 手动启动方式

也可以手动设置环境变量并运行 Server：

```text
RPGMAP_PUBLIC=1
RPGMAP_JOIN_CODE=<Player 房间码>
RPGMAP_GM_SECRET=<GM Secret>
RPGMAP_PLAYER_WRITE=1
```

然后运行：

```text
node server.mjs
cloudflared tunnel --url http://127.0.0.1:30000
```

跨互联网与局域网使用的是同一个 RPGmap Server、World Store 和 `/ws` 协议，Tunnel 只负责提供公网 HTTPS/WSS 网络入口。
