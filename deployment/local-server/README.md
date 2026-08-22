# RPGmap 1.5.0 Candidate · Server / 操作指南

V1.5.0 在 V1.4.1 已验证的 Multiplayer / User / Ownership / `app + map` Runtime 基线上加入新的 **MapPackage Framework**。

这次最重要的变化不是运行方式，而是源码职责：兰州城已经从 Core 中抽离为 `reference/maps/lanzhou/` Reference MapPackage；地图在 build 时打进 `app/index.html`，Server 运行时不读取 `reference/`。

## 一、发布包目录

```text
RPGmap-v1.5.0/
├─ app/                    完整 build 后的前端程序 + 当前默认地图
├─ map/                    当前 World / User 的可写运行数据
│  ├─ world.json           运行后生成
│  ├─ users.json           有正式 Player User 后生成
│  ├─ uploads/
│  └─ backups/
├─ reference/              MapPackage / DIY 源码参考，不是 Runtime 依赖
│  ├─ README.md
│  └─ maps/
│     ├─ lanzhou/
│     └─ minimal/
├─ docs/
├─ server.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ internet-launcher.mjs
├─ start-rpgmap.bat
└─ start-rpgmap-internet.bat
```

### `app/`

真正运行的浏览器 Client。当前兰州 Reference Map 已在 Vite build 时打入这里。

### `reference/`

给开发者 / 地图作者学习和 DIY 的源码参考。**删除它不应影响当前已经构建好的 RPGmap 运行。** CI 会实际删除测试副本的整个 `reference/` 后重新启动 Server 进行验证。

### `map/`

沿用 V1.4.1 的稳定 Runtime Storage：

```text
map/world.json
map/users.json
map/uploads/
map/backups/
```

这次故意不同时迁移 `map/` 命名，以免再次把 MapPackage 重构和 World Storage 迁移绑在一起。

## 二、启动方式

### Windows：本机 / 局域网

双击：

```text
start-rpgmap.bat
```

本机默认：`http://127.0.0.1:30000`。

### Windows：远程公网联机

双击：

```text
start-rpgmap-internet.bat
```

启动器继续使用 Cloudflare Quick Tunnel，生成 Join Code / GM Secret，并启动同一个 Game Server。

## 三、MapPackage 和 Runtime 的关系

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

Runtime 不会：

- 扫描 `reference/`；
- 查找根目录 `maps/`；
- 建立 Junction；
- 让 BAT / PowerShell 解析地图；
- 让浏览器读取 Windows 磁盘路径。

地图 DIY 规范请直接查看：

```text
reference/README.md
```

## 四、兰州与 Minimal Reference

### Lanzhou

完整复杂参考：大地图、道路、建筑、城墙、黄河、桥梁、Navigation、Generated Art、可破坏 Feature。

### Minimal

极简测试参考：地面、水体、一栋可进入可破坏木屋、一堵可破坏墙。

自动测试会让 Minimal 地图调用与兰州相同的 Core Damage / Scene State API，证明可破坏规则不是兰州私有逻辑。

## 五、Player / Ownership / Combat

V1.5.0 继续完整继承 V1.4.1：

- pending → GM approve → Persistent User；
- Player Key；
- Default Actor；
- NONE / OBSERVER / OWNER；
- Server-authoritative World diff validation；
- Combat Turn Lock；
- Multiplayer WebSocket；
- `map/world.json` / `map/users.json` 持久化。

## 六、备份与迁移

当前跑团数据仍然只需要重点备份：

```text
map/
```

`reference/` 不是运行存档；它是 MapPackage 源码参考。

## 七、开发 / DIY

完整步骤：

1. 阅读 `reference/README.md`；
2. 复制 `reference/maps/minimal/`；
3. 定义 Layer Plan 与 Feature；
4. 让 `prepareMapPackage()` 校验；
5. `npm test`；
6. `npm run build`；
7. 在 `src/map-package/default-map.js` 切换默认 MapPackage；
8. 运行 Server 做浏览器验收。

主程序 `src/main.js` 不应因为更换地图而修改。
