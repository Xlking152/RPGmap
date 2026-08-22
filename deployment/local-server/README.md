# RPGmap 1.5.3 Candidate · 启动与运行说明

V1.5.3 将 V1.5 的启动层重新收口：**Windows 用户只需要一个 `start-rpgmap.bat`。**

MapPackage / Elevation / Feature Interaction / Navigation 架构不变；本次只整理 Runtime 启动入口与联网模式生命周期。

## 发布包目录

```text
RPGmap-v1.5.3/
├─ app/                    构建后的浏览器 Client + 默认地图
├─ map/                    当前 World / User 可写数据
│  ├─ world.json           运行后生成
│  ├─ users.json           有正式 Player User 后生成
│  ├─ uploads/
│  └─ backups/
├─ reference/              MapPackage / DIY 源码参考，不是 Runtime 依赖
├─ docs/
├─ server.mjs              通用 HTTP + WebSocket Server
├─ launcher.mjs            Local / LAN / Internet 唯一启动逻辑
├─ access-control.mjs
├─ portable-storage.mjs
├─ start-rpgmap.bat        Windows 唯一入口
└─ start-rpgmap.sh         Linux/macOS 本地入口
```

不再包含：

```text
start-rpgmap-internet.bat
setup-cloudflared.bat
run-rpgmap-public-server.bat
local-launcher.mjs
internet-launcher.mjs
launcher-guard.mjs
```

这些职责已经全部合并到 `launcher.mjs`。

## Windows 启动

双击：

```text
start-rpgmap.bat
```

然后选择：

```text
1. Local / LAN
2. Internet / Public
```

### 1 · Local / LAN

适合本机或同一局域网跑团。

Launcher 会按顺序执行：

```text
检查 30000 端口
→ 启动 server.mjs
→ 等待 /api/health READY
→ 确认 publicMode=false
→ 显示 Local / Network 地址
→ 打开浏览器
```

本机默认地址：

```text
http://127.0.0.1:30000
```

同一局域网其他设备使用启动窗口中的 `Network` 地址。

### 2 · Internet / Public

Internet 模式本身同时提供：

- 本机 Local 地址；
- 局域网 Network 地址；
- Cloudflare Public URL。

因此启动 Internet 模式后**不要再启动第二个 Local Server**。

Launcher 会：

1. 检查 30000 端口是否已有 RPGmap / 其他程序；
2. 查找包目录或系统 PATH 中的 `cloudflared`；
3. Windows 首次缺少时自动尝试下载官方 portable `cloudflared.exe`；
4. 下载失败时尝试 Winget；
5. 创建 Quick Tunnel；
6. 生成 Join Code / GM Secret；
7. 启动同一个 `server.mjs`；
8. 等待 `/api/health` 并确认 `publicMode=true`；
9. 在同一个窗口打印 Public URL / Join Code / GM Secret；
10. 打开公网页面。

不再弹出额外的 Multiplayer Info 命令行窗口。

## 启动互斥

Local / LAN 与 Internet / Public 是**同一个 Server 的两种启动模式**，不是两套 Server。

两者默认都使用：

```text
PORT=30000
```

如果端口已经被 RPGmap 占用，Launcher 会明确说明当前是 Local/LAN 还是 Internet/Public；如果被其他程序占用，也会直接报错，不会继续打开一个一直加载的浏览器页面。

## 命令行直接指定模式

Windows CI、快捷方式或高级用户可以跳过菜单：

```text
start-rpgmap.bat local
start-rpgmap.bat internet
```

Linux/macOS：

```text
./start-rpgmap.sh local
./start-rpgmap.sh internet
```

## Runtime 与 MapPackage

```text
reference/maps/lanzhou/
        ↓ build
src/map-package/ + Core
        ↓
app/index.html
        ↓
server.mjs
        ↓
Browser
```

`reference/` 是开发 / DIY 参考。构建后的 Runtime 不读取它；CI 会删除整个 `reference/` 后重新启动 Server 验证。

## 数据与备份

World / User / 上传资源仍集中在：

```text
map/world.json
map/users.json
map/uploads/
map/backups/
```

升级程序时优先保留和备份整个 `map/`。

## DIY 地图

地图开发规范见：

```text
reference/README.md
```

更换地图应替换 MapPackage，不复制 Damage / Movement / Multiplayer / Scene 等通用逻辑。
