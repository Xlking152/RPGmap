# RPGmap 1.4.0 Internet Multiplayer

本文件记录 V1.4 Windows 公网联机入口的技术说明。普通用户优先阅读 `README.md` 或 `文档/联机使用说明.md`。

## 一键启动

双击：

```text
start-rpgmap-internet.bat
```

流程：

1. 检查 Node.js。
2. 检查完整 `public/` 发布内容。
3. 优先使用包目录中的 `cloudflared.exe`。
4. 其次使用系统 PATH 中已安装的 `cloudflared.exe`。
5. 如果仍不存在，调用 `setup-cloudflared.bat` 尝试官方下载或 `winget` 安装。
6. 启动 `internet-launcher.mjs`。
7. Launcher 以 `--protocol http2` 创建 Cloudflare Quick Tunnel。
8. 自动解析 `https://*.trycloudflare.com`。
9. 自动生成 6 位 Join Code 与 16 位十六进制 GM Secret。
10. 启动 `server.mjs`，注入 `RPGMAP_PUBLIC_URL`、Join Code 和 GM Secret。
11. 等待 `/api/health` 返回 READY。
12. 自动打开公网 RPGmap 页面。
13. Windows 额外打开独立 `RPGmap Multiplayer Info` 信息窗口。

## 玩家邀请

只发送：

```text
Public URL + Join Code
```

GM Secret 只供 GM 使用。

## HTTP/2 / TCP

V1.4 Quick Tunnel 默认：

```text
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:30000 --protocol http2
```

这样可以绕开部分 VPN / TUN、校园网、防火墙对 QUIC / UDP 的限制。

## cloudflared 自动安装

`setup-cloudflared.bat` 会尝试：

- 本地 `cloudflared.exe`
- 系统 PATH
- Cloudflare 官方 GitHub Release Windows amd64 binary
- `winget install --id Cloudflare.cloudflared --exact`

如果自动下载失败，可手动将 Windows 64-bit `cloudflared.exe` 放在 RPGmap 根目录。

## 安全边界

- Player 使用 Join Code。
- GM 使用 GM Secret。
- 不使用注册、邮箱、OAuth、JWT。
- 当前默认允许 Player 写共享 World。
- Join Code 与 GM Secret 每次公网启动重新生成。
- 不要把 GM Secret 发布给玩家或公开到论坛。
- Quick Tunnel URL 是临时地址，Launcher 停止后失效。

## Troubleshooting

### `stream N canceled by remote with error code 0`

单条日志不一定代表 Tunnel 故障，可能只是客户端取消 HTTP 请求。应以页面和 WebSocket 是否能正常连接为准。

### 玩家打不开 Public URL

GM 可先用手机关闭 Wi-Fi、使用 4G/5G 测试 Public URL。如果移动网络也无法访问，再检查 Cloudflare 日志和本机代理 / VPN / TUN 设置。

### `198.18.x.x`

该地址属于保留测试网段，常见于某些代理 / TUN 软件的虚拟网络路径。V1.4 默认 HTTP/2/TCP 模式用于提高这类环境的兼容性。

## 手动模式

高级用户也可以手动设置：

```text
RPGMAP_PUBLIC=1
RPGMAP_PUBLIC_URL=https://example.trycloudflare.com
RPGMAP_JOIN_CODE=123456
RPGMAP_GM_SECRET=ABCDEF0123456789
RPGMAP_PLAYER_WRITE=1
```

然后分别运行 Server 和 Tunnel。

## Quick Tunnel 定位

Quick Tunnel 是 V1.4 的便捷个人联机入口，不是固定公网部署方案。需要长期固定 URL、域名和更严格访问策略时，应迁移到 Named Tunnel / 自有域名。
