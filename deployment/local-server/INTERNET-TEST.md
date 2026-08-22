# RPGmap 1.5.3 Internet Multiplayer

V1.5.3 不再提供单独的 Internet BAT。Windows 公网联机与本地 / 局域网统一从：

```text
start-rpgmap.bat
```

启动，然后选择：

```text
2. Internet / Public
```

也可直接运行：

```text
start-rpgmap.bat internet
```

## Internet 模式流程

统一 `launcher.mjs` 会：

1. 检查 `30000` 端口，拒绝与已有 Local/LAN 或 Internet Server 并行启动；
2. 查找 RPGmap 目录中的 `cloudflared.exe`；
3. 其次查找系统 PATH；
4. Windows 若仍缺少，则自动尝试下载 Cloudflare 官方 portable executable；
5. 官方下载失败时尝试 Winget；
6. 创建 `HTTP/2 over TCP` Quick Tunnel；
7. 解析 `https://*.trycloudflare.com`；
8. 生成 6 位 Join Code 和 16 位十六进制 GM Secret；
9. 以 Public 模式启动同一个 `server.mjs`；
10. 等待 `/api/health` READY，并确认 `publicMode=true`；
11. 在当前窗口打印 Local / Network / Public 地址与凭据；
12. 打开 Public URL。

不会再启动：

```text
setup-cloudflared.bat
run-rpgmap-public-server.bat
internet-launcher.mjs
额外 Multiplayer Info 命令行窗口
```

## 玩家邀请

普通 Player 首次加入只发送：

```text
Public URL + Join Code
```

已有 User 在新的 Quick Tunnel 地址恢复身份时使用：

```text
Public URL + Join Code + Player Key
```

GM Secret 只供 GM 使用。

## Internet 模式也包含 LAN

选择 Internet / Public 后，同一个 Server 会同时输出：

```text
Local URL
Network URL
Public URL
```

因此同一局域网设备仍可直接使用 Network URL；不要再启动第二个 Local Server。

## Cloudflared

默认 Quick Tunnel 命令仍为：

```text
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:30000 --protocol http2
```

HTTP/2/TCP 用于提高 VPN / TUN / 校园网 / 防火墙环境下的兼容性。

如果自动安装失败，可手动下载 Windows 64-bit `cloudflared.exe` 并放在 `start-rpgmap.bat` 同目录，再重新选择 Internet 模式。

## 故障定位

### 启动后端口占用

Launcher 会区分：

- 已有 RPGmap Local/LAN；
- 已有 RPGmap Internet/Public；
- 其他程序占用端口。

应先关闭对应进程，不要同时启动两个 RPGmap Server。

### 玩家打不开 Public URL

先在主机确认：

- `/api/health` 已 READY；
- Public URL 已打印；
- cloudflared 没有退出。

再用手机关闭 Wi-Fi、通过 4G/5G 测试 Public URL，以区分本机 LAN 问题和公网 Tunnel 问题。

### Quick Tunnel 定位

Quick Tunnel 是便捷个人联机入口，不是固定公网部署方案。需要固定域名、长期运行和更严格访问策略时，再迁移到 Named Tunnel / 自有域名。
