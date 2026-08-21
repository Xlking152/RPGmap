# RPGmap 1.4.3 Internet Multiplayer

本文件记录 V1.4.3 Internet Multiplayer 的技术说明。普通用户优先阅读发布包根目录 `操作说明.md`。

## 统一启动入口

Windows 只需要双击：

```text
启动 RPGmap.bat
```

浏览器打开本机 Launcher：

```text
http://127.0.0.1:29999
```

点击“启动互联网联机”后，Launcher 自动：

1. 检测 cloudflared；
2. Windows 缺失时下载官方 Windows amd64 binary 到包内 `tools/`；
3. 创建 Cloudflare Quick Tunnel；
4. 使用 `--protocol http2`；
5. 解析 `https://*.trycloudflare.com`；
6. 生成 6 位 Join Code 和 GM Secret；
7. 启动 RPGmap Game Server；
8. 等待 `/api/health` READY；
9. 建立隐藏 Launcher GM Admin Session；
10. 在 Launcher 页面显示公网地址、房间号、GM Secret 和日志。

V1.4.3 不再要求用户运行独立的 `setup-cloudflared.bat` 或 `start-rpgmap-internet.bat`。

## Player Invite

Launcher 的“玩家邀请”只包含：

```text
Public URL + Join Code
```

GM Secret 永远不会进入邀请文本。

已有 Persistent User 在新的 Quick Tunnel 域名恢复身份时，还需要自己的 Player Key。

## Launcher / Game Port

```text
Launcher: 127.0.0.1:29999
Game:     0.0.0.0:30000
Tunnel:   -> http://127.0.0.1:30000
```

Launcher 只绑定 loopback；Cloudflare 只代理 Game Port，因此远程 Player 不会经过 Launcher Admin Console。

## HTTP/2 / TCP

Quick Tunnel：

```text
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:30000 --protocol http2
```

用于提高 VPN / TUN、校园网和限制 UDP 环境下的兼容性。

## cloudflared

优先顺序：

1. `RPGMAP_CLOUDFLARED_EXE`；
2. RPGmap 包内 `tools/cloudflared.exe`；
3. RPGmap 根目录兼容位置；
4. 系统 PATH 中的 `cloudflared`；
5. Windows 自动下载 Cloudflare 官方 Release。

自动下载的文件留在 RPGmap 包内，不写入 AppData。

## User / Ownership

Launcher 通过隐藏 GM WebSocket Session 管理：

- pending Player 批准；
- User 预创建；
- 默认 Actor；
- NONE / OBSERVER / OWNER；
- Player Key rotation；
- User 删除。

它不直接改 `world/users.json`，因此运行中的 Server 内存状态和持久化状态保持一致。

## Portable Data

```text
app/     程序
world/   当前 Campaign 数据
maps/    Map / Scene 资源库
```

Internet 和 LAN 模式使用同一个 `world/` / `maps/`。

## Security

- Player：Join Code。
- GM：GM Secret。
- Persistent User：Browser Token / Player Key。
- Launcher：127.0.0.1 + 本机随机 Browser Token。
- Server 不保存明文 Player Key / Browser Token。
- Join Code / GM Secret 每次启动重新生成。
- Player Key 只发给对应玩家。

## Troubleshooting

### Public URL 无法访问

先使用手机关闭 Wi-Fi、改用移动网络测试。若仍不可访问，再查看 Launcher 的 Tunnel 日志，并检查本机 VPN / TUN / 代理。

### `stream N canceled by remote with error code 0`

单条日志不一定代表 Tunnel 故障，应以页面和 WebSocket 是否正常为准。

### `198.18.x.x`

常见于代理 / TUN 虚拟网络。HTTP/2/TCP 模式用于提高此类环境兼容性。

## Quick Tunnel 定位

Quick Tunnel 适合便捷个人联机，不是固定生产部署。需要固定域名和长期服务时，后续应迁移到 Named Tunnel / 自有域名。
