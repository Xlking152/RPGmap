# RPGmap 1.5.4 Candidate · 启动与运行说明

Windows 用户只需要一个入口：

```text
start-rpgmap.bat
        ↓
launcher.mjs
   ├─ Local / LAN
   └─ Internet / Public
        ↓
server.mjs
```

## 发布包目录

```text
RPGmap-v1.5.4/
├─ app/                    构建后的浏览器 Client + 默认地图
├─ map/                    当前 World / User 可写数据
│  ├─ world.json
│  ├─ users.json
│  ├─ uploads/
│  └─ backups/
├─ reference/              MapPackage / DIY 源码参考，不是 Runtime 依赖
├─ docs/
├─ server.mjs
├─ launcher.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ start-rpgmap.bat        Windows 唯一入口
└─ start-rpgmap.sh
```

## Windows 启动

双击：

```text
start-rpgmap.bat
```

选择：

```text
1. Local / LAN
2. Internet / Public
```

两种模式都会在 Server READY 后集中显示连接信息：

```text
PLAYER INVITE
  URL / Internet URL
  Join Code          ← 房间号

LOCAL / LAN
  Local
  LAN URL

GM ONLY
  GM Secret          ← GM 密码

HOST
  Browser            ← 自动打开本机地图并以 GM 身份进入
```

### Local / LAN

Launcher 会：

```text
检查端口
→ 生成 Join Code + GM Secret
→ 启动 server.mjs
→ 等待 /api/health READY
→ 显示 Local / LAN 地址与凭据
→ 自动打开 127.0.0.1 地图
→ 自动以 GM 身份连接
```

同一局域网的玩家使用启动窗口中的 `LAN URL`，并填写 `Join Code`。

### Internet / Public

Launcher 会：

```text
检查端口
→ 准备 cloudflared
→ 创建 Quick Tunnel
→ 生成 Join Code + GM Secret
→ 启动 server.mjs
→ 等待 /api/health READY
→ 同屏显示 Public / LAN / Local / Join Code / GM Secret
→ 主机自动打开 127.0.0.1 地图并以 GM 身份连接
```

主机不会再通过 Cloudflare 公网地址访问自己的地图；公网 URL 只用于远程玩家。这样能减少 Tunnel 往返延迟，也避免主机因为公网链路波动出现长时间加载。

## 主机自动进入地图

Launcher 打开的本机 URL 会带一个只存在于 URL hash 中的 GM 启动信息。hash 不会被发送给 HTTP Server；Client 读取后会立即从地址栏清除，并且只有 `localhost / 127.0.0.1` 页面允许消费这个自动 GM 信息。

因此：

- GM Secret 不会被附加到玩家使用的 Public URL；
- 不会通过普通 HTTP 请求传给 Server；
- 玩家仍然需要 `Join Code`；
- GM 仍可从联机面板手动使用 `GM Secret` 登录其他设备。

## 启动互斥

Local/LAN 与 Internet/Public 是同一个 Server 的两种模式，默认都使用：

```text
PORT=30000
```

如果 30000 已被 RPGmap 或其他程序占用，Launcher 会在打开浏览器前停止并给出明确错误，不会再出现浏览器一直加载但 Server 实际没有成功启动的情况。

## 命令行直接指定模式

```text
start-rpgmap.bat local
start-rpgmap.bat internet
```

Linux/macOS：

```text
./start-rpgmap.sh local
./start-rpgmap.sh internet
```

## Runtime 与数据

`reference/` 只是开发 / DIY 参考。默认地图在 build 时已经进入 `app/index.html`；CI 会删除整个 `reference/` 后重新启动 Runtime 验证。

运行数据集中在：

```text
map/world.json
map/users.json
map/uploads/
map/backups/
```

升级时优先保留整个 `map/`。
