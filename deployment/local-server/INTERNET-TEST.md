# RPGmap 1.4.3 Internet Multiplayer

普通用户优先阅读发布包根目录 `操作说明.md`。本文件记录 V1.4.3 Internet Launcher 的技术流程。

## 启动入口

Windows 双击：

```text
启动 RPGmap.bat
```

BAT 仅负责查找 Node.js 并启动：

```text
launcher/launcher.mjs
```

随后在浏览器 Launcher 页面点击：

```text
启动互联网联机
```

## Launcher 本机端口

Launcher 只绑定：

```text
127.0.0.1
```

首选端口 `29999`。被占用时自动尝试 `29998 / 29997 / 29996 / 29995`，仍不可用时交给 Windows 自动分配空闲 loopback 端口。

Launcher 会自动打开实际地址，Internet Tunnel 永远不会转发 Launcher 端口。

## Internet 流程

Launcher 自动：

1. 检查完整 `app/`、`world/`、`maps/`、`server/`。
2. 优先使用 `tools/cloudflared.exe`。
3. 其次使用 RPGmap 根目录或系统 PATH 中的 cloudflared。
4. Windows 仍未找到 cloudflared 时，下载官方 Windows amd64 binary 到 `tools/`。
5. 使用 `--protocol http2` 创建 Cloudflare Quick Tunnel。
6. 自动解析 `https://*.trycloudflare.com`。
7. 自动生成 6 位 Join Code 与 GM Secret。
8. 启动 `server/server.mjs`。
9. 等待 `/api/health` READY。
10. 建立隐藏的 Launcher GM Admin WebSocket Session。
11. Launcher 页面显示 Public URL / Join Code / GM Secret / User 后台。

## 玩家邀请

普通 Player 只需要：

```text
Public URL + Join Code
```

已有 Persistent User 在新 Quick Tunnel 域名恢复时，还需要自己的 Player Key。

GM Secret 只供 GM 使用。

Launcher 的“复制玩家邀请”不会包含 GM Secret。

## Launcher / Game Server 安全边界

```text
Launcher  : 127.0.0.1:<dynamic>
Game      : 0.0.0.0:30000
Cloudflare: -> 127.0.0.1:30000 only
```

公网 Player 无法通过 Quick Tunnel 访问 Launcher 管理端口。

Launcher 本机 API 使用随机 Browser Token。

## User / 权限

Launcher 可以通过隐藏 GM WebSocket Session：

- approve pending Player；
- create User；
- Default Actor；
- NONE / OBSERVER / OWNER；
- rotate Player Key；
- delete User。

Launcher 不直接修改 `world/users.json`。

## HTTP/2 / TCP

Quick Tunnel：

```text
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:30000 --protocol http2
```

用于提高 VPN / TUN、校园网和限制 UDP 环境下的兼容性。

## 便携目录

```text
app/      程序前端
world/    当前 Campaign 运行状态
maps/     Map / Scene 资源库
server/   Multiplayer Server 内部程序
launcher/ Launcher 内部程序
tools/    cloudflared / 可选 Portable Node
```

Internet 和 LAN 使用同一套 `world/` / `maps/` 数据。

## Troubleshooting

### BAT 提示未检测到 Node.js

安装 Node.js `^20.19.0 || >=22.12.0`，然后重新双击 `启动 RPGmap.bat`。

### BAT 启动后没有浏览器页面

查看：

```text
launcher-startup.log
```

或手动运行：

```bat
node launcher\launcher.mjs
```

### 29999 已被其他程序占用

无需结束其他进程。Launcher 会自动切换到其他本机端口。

### `stream N canceled by remote with error code 0`

单条日志不一定表示 Tunnel 故障，可能只是客户端取消 HTTP 请求。以页面和 WebSocket 是否正常连接为准。

### Player 打不开 Public URL

GM 可先使用手机关闭 Wi-Fi、通过 4G/5G 测试 Public URL，再检查 VPN / TUN / 防火墙。

### `198.18.x.x`

该地址属于保留测试网段，常见于代理 / TUN 软件虚拟网络路径。RPGmap 默认 HTTP/2/TCP 模式用于提高此类环境兼容性。

## Quick Tunnel 定位

Quick Tunnel 是便捷个人联机入口，不是固定公网部署方案。长期固定 URL / 域名后续计划使用 Named Tunnel / 自有域名。
