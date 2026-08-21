# RPGmap 1.4.2 Internet Multiplayer

本文件记录 V1.4.2 Windows 公网联机入口的技术说明。普通用户优先阅读发布包根目录 `操作说明.md`；更完整的身份 / Ownership 说明见 `docs/MULTIPLAYER-GUIDE.md`。

## 一键启动

双击：

```text
start-rpgmap-internet.bat
```

流程：

1. 检查 Node.js。
2. 检查完整 `app/` 发布内容。
3. 创建 / 检查 `world/` 与 `maps/`。
4. 优先使用包目录中的 `cloudflared.exe`。
5. 其次使用系统 PATH 中的 `cloudflared.exe`。
6. 如果仍不存在，调用 `setup-cloudflared.bat` 尝试官方下载或 `winget` 安装。
7. 启动 `internet-launcher.mjs`。
8. Launcher 使用 `--protocol http2` 创建 Cloudflare Quick Tunnel。
9. 自动解析 `https://*.trycloudflare.com`。
10. 自动生成 6 位 Join Code 与 GM Secret。
11. 启动 `server.mjs`，注入 Public URL、Join Code 和 GM Secret。
12. 等待 `/api/health` 返回 READY。
13. 自动打开公网 RPGmap 页面。
14. Windows 额外打开独立 `RPGmap Multiplayer Info` 信息窗口。

## V1.4.2 便携目录

```text
app/     程序前端
world/   当前 World / Campaign 的运行数据
maps/    真正的 Map / Scene 资源库
```

公网联机和局域网联机使用同一套 `world/` / `maps/` 数据，不会另外在 AppData、用户主目录或隐藏目录再保存一份 RPGmap World/User 数据。

## 玩家邀请

首次加入的普通 Player 通常只需要：

```text
Public URL + Join Code
```

GM Secret 只供 GM 使用。

已存在的 Player User 在 Quick Tunnel 域名变化后恢复身份时，还需要自己的 Player Key。

## User / 权限

- Player 首次加入后进入 pending，由 GM 批准为持久 User。
- GM 可以预创建 User + Player Key。
- Actor 权限分为 NONE / OBSERVER / OWNER。
- Combat active 时，Player 只能操控当前 Turn 对应且自己拥有 OWNER 的 Actor。
- Client 负责友好预检，Server 负责最终权限裁决。
- User / Ownership / 凭证哈希保存在 `world/users.json`。

## HTTP/2 / TCP

Quick Tunnel 默认：

```text
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:30000 --protocol http2
```

这样可以提高 VPN / TUN、校园网、防火墙限制 UDP 环境下的兼容性。

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
- Player User 通过 Browser Token / Player Key 恢复身份。
- Server 不保存明文 Player Key / Browser Token，只保存哈希。
- Join Code 与 GM Secret 每次公网启动重新生成。
- 不要把 GM Secret 发给 Player。
- Player Key 只发给对应 Player。
- Quick Tunnel URL 是临时地址，Launcher 停止后失效。

## Troubleshooting

### `stream N canceled by remote with error code 0`

单条日志不一定代表 Tunnel 故障，可能只是客户端取消 HTTP 请求。应以页面和 WebSocket 是否正常连接为准。

### Player 打不开 Public URL

GM 可先用手机关闭 Wi-Fi、使用 4G/5G 测试 Public URL。如果移动网络也无法访问，再检查 Cloudflare 日志和本机代理 / VPN / TUN 设置。

### `198.18.x.x`

该地址属于保留测试网段，常见于某些代理 / TUN 软件的虚拟网络路径。RPGmap 默认 HTTP/2/TCP 模式用于提高这类环境的兼容性。

## 手动模式

高级用户可以手动设置：

```text
RPGMAP_PUBLIC=1
RPGMAP_PUBLIC_URL=https://example.trycloudflare.com
RPGMAP_JOIN_CODE=123456
RPGMAP_GM_SECRET=ABCDEF0123456789
RPGMAP_PUBLIC_DIR=<package>/app
RPGMAP_WORLD_DIR=<package>/world
RPGMAP_MAPS_DIR=<package>/maps
```

然后分别运行 Server 和 Tunnel。

## Quick Tunnel 定位

Quick Tunnel 是便捷个人联机入口，不是固定公网部署方案。需要长期固定 URL、域名和更严格访问策略时，应迁移到 Named Tunnel / 自有域名。
