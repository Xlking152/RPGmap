# RPGmap 1.4.3 Internet Multiplayer

普通用户优先阅读发布包根目录 `操作说明.md`。本文件记录 V1.4.3 Internet Launcher 的技术流程。

## 启动入口

Windows 双击：

```text
RPGmap.bat
```

BAT 查找 Node.js 并直接运行：

```text
launcher/launcher.mjs
```

随后在网页 Launcher 点击：

```text
启动互联网联机
```

## Launcher 本机端口

Launcher 只绑定 `127.0.0.1`。

首选 `29999`；被占用时尝试 `29998 / 29997 / 29996 / 29995`；仍不可用时让 Windows 自动分配空闲 loopback 端口。

Cloudflare 永远只转发 Game Server，不转发 Launcher 管理端口。

## Internet 流程

Launcher 自动：

1. 检查 `app/`、`world/`、`maps/`、`server/`；
2. 优先使用 `tools/cloudflared.exe`；
3. 其次检查根目录 / PATH；
4. Windows 仍未找到时下载官方 amd64 binary 到 `tools/`；
5. 使用 `--protocol http2` 创建 Quick Tunnel；
6. 解析 `https://*.trycloudflare.com`；
7. 生成 Join Code / GM Secret；
8. 启动 `server/server.mjs`；
9. 等待 `/api/health` READY；
10. 建立隐藏 Launcher GM Admin WebSocket Session；
11. 页面显示 Public URL / Join Code / GM Secret / Users。

## 玩家邀请

普通 Player 需要：

```text
Public URL + Join Code
```

已有 Persistent User 在新 Quick Tunnel 域名恢复时还需要 Player Key。

Player Invite 永不包含 GM Secret。

## 安全边界

```text
Launcher  : 127.0.0.1:<dynamic>
Game      : 0.0.0.0:30000
Cloudflare: -> 127.0.0.1:30000 only
```

Launcher 本机 API 使用随机 Browser Token。

## User / 权限

Launcher 通过隐藏 GM Session执行：

- approve pending Player；
- create/update/delete User；
- Default Actor；
- NONE / OBSERVER / OWNER；
- rotate Player Key。

Launcher 不直接修改 `world/users.json`。

## Quick Tunnel 命令

```text
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:30000 --protocol http2
```

HTTP/2 over TCP 用于提高 VPN / TUN、校园网和限制 UDP 环境下的兼容性。

## 便携目录

```text
app/      程序前端
world/    Campaign 状态
maps/     Map / Scene 资源
server/   Multiplayer Server
launcher/ Web Launcher
tools/    cloudflared / 可选 Portable Node
```

## Troubleshooting

### RPGmap.bat 提示未检测到 Node.js

安装 Node.js `^20.19.0 || >=22.12.0` 后重新双击。

### BAT 启动后没有网页

查看 BAT Runtime 窗口中的错误，或手动运行：

```bat
node launcher\launcher.mjs
```

### 29999 被占用

无需结束其他程序，Launcher 自动切换端口。

### `stream N canceled by remote with error code 0`

单条日志不一定表示 Tunnel 故障，可能只是客户端取消请求。以网页和 WebSocket 是否正常为准。

### Player 打不开 Public URL

GM 可先用手机关闭 Wi-Fi，通过 4G/5G 测试 Public URL，再检查 VPN / TUN / 防火墙。

## Quick Tunnel 定位

Quick Tunnel 是便捷个人联机入口，不是固定公网部署方案。长期固定 URL / 域名后续计划使用 Named Tunnel / 自有域名。
