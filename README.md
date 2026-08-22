# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器端自托管地图与跑团平台。当前开发 Candidate 为 **V1.5.3**。

V1.5 系列的核心目标有两条：

1. **地图内容与通用游戏逻辑分离**：换地图只换 MapPackage，不复制 Damage / Movement / Multiplayer / Scene 等 Core。
2. **运行入口保持简单**：Windows 只保留一个 `start-rpgmap.bat`，Local/LAN 与 Internet/Public 共用一个 Launcher 和一个 Server。

---

## 1. 架构边界

```text
MapPackage
“世界是什么”
        ↓
RPGmap Core
“世界如何运行”
        ↓
Scene Instance
“这张地图现在怎样”
        ↓
World
“这一场 Campaign 发生了什么”
```

当前默认兰州地图在 build 时进入浏览器 Client：

```text
reference/maps/lanzhou/
        ↓ build-time input
src/map-package/ + RPGmap Core
        ↓ Vite
app/index.html
        ↓
server.mjs :30000
        ↓
Browser
```

`reference/` 是源码 / DIY 参考，不是运行时依赖。CI 会在打包后删除整个 `reference/` 再启动 Runtime 验证。

---

## 2. Reference MapPackage

兰州实现位于：

```text
reference/maps/lanzhou/
├─ manifest.js
├─ package.js
├─ capabilities.js
├─ assets.js
├─ presentation.js
├─ assets/
├─ index.js
└─ README.md
```

极简参考地图位于：

```text
reference/maps/minimal/
```

Minimal MapPackage 会交给与兰州相同的 Core Damage / Scene / Navigation API，用于防止 Core 偷偷依赖兰州 Feature ID 或地图类别。

---

## 3. MapPackage Contract

通用接口位于：

```text
src/map-package/
├─ contract.js
├─ default-map.js
└─ index.js
```

`prepareMapPackage()` 统一验证和归一：

- ID / Version / Width / Height；
- SVG renderer；
- Feature ID 唯一性；
- Layer Plan；
- Feature Capability；
- Navigation blocker / passage geometry；
- 可选 2.5D blocking height。

标准逻辑 Layer Role：

```text
base
terrain
liquid
structure
special
destructible
labels
```

---

## 4. Feature / Interaction / Navigation

Core 只消费通用 Feature Capability，不识别“兰州北门”“衙门门”等地图专属 ID。

当前通用行为包括：

- inspect / enter / exit；
- damage / restore；
- open / close；
- Feature State；
- Feature Control Layer；
- `blockingPolygon` / `passagePolygon`；
- mover-aware Navigation；
- EasyStar A*；
- 2.5D `elevationFt` / `blockingHeightFt`。

高度规则：

```text
elevationFt > blockingHeightFt   => 忽略该 Feature obstacle
elevationFt <= blockingHeightFt  => 正常阻挡
```

没有声明 `blockingHeightFt` 的旧 Feature 保持传统无限高度 2D obstacle 行为。

---

## 5. Token UI

V1.5.3 延续 V1.5.1 的 Token UI：

```text
        Character Name
             ↑
        ┌─────────┐  ↗ elevation ft
        │  Token  │
        └─────────┘
             ↓
          HP Bar
```

- HealthSystem 是唯一 HP 条 owner；
- 名称位于 Token 上方；
- Elevation 位于右上角；
- 右键 Token 打开高度 HUD；
- 高度修改直接进入 mover-aware Navigation。

---

## 6. Windows 启动：只有一个 BAT

V1.5.3 最终只保留：

```text
start-rpgmap.bat
```

双击后选择：

```text
1. Local / LAN
2. Internet / Public
```

结构统一为：

```text
start-rpgmap.bat
        ↓
launcher.mjs
   ├─ local
   └─ internet
        ↓
server.mjs
```

不再存在独立的：

```text
start-rpgmap-internet.bat
setup-cloudflared.bat
run-rpgmap-public-server.bat
local-launcher.mjs
internet-launcher.mjs
launcher-guard.mjs
```

### Local / LAN

```text
端口检查
→ 启动 Server
→ 等待 /api/health READY
→ 确认 publicMode=false
→ 打印 Local / Network 地址
→ 打开浏览器
```

### Internet / Public

```text
端口检查
→ 查找/安装 cloudflared
→ 创建 Quick Tunnel
→ 生成 Join Code / GM Secret
→ 启动同一个 Server
→ 等待 READY + publicMode=true
→ 打印 Local / Network / Public 地址
→ 打开 Public URL
```

Internet 模式本身已经同时提供 Local + LAN + Public 访问，不需要再启动第二个 Local Server。

高级用法：

```text
start-rpgmap.bat local
start-rpgmap.bat internet
```

---

## 7. Portable Runtime

测试包结构：

```text
RPGmap-v1.5.3/
├─ app/
├─ map/
├─ reference/
├─ docs/
├─ server.mjs
├─ launcher.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ start-rpgmap.bat
└─ start-rpgmap.sh
```

World / User 默认写入：

```text
map/world.json
map/users.json
map/uploads/
map/backups/
```

升级程序时重点备份整个 `map/`。

---

## 8. 当前 Core 能力

- Movement / Waypoint / A*；
- Entity / Actor / Token / Form；
- Selection / Ruler；
- Health / Damage / Healing；
- Combat / Turn Lock；
- Chat / Game Log；
- Multiplayer WebSocket；
- Persistent User / Player Key；
- NONE / OBSERVER / OWNER；
- Server-authoritative 权限；
- Cloudflare Quick Tunnel；
- Portable `app/ + map/` runtime storage；
- Generic Feature Operations / Controls；
- 2.5D Elevation / Height Blocking。

---

## 9. DIY 新地图

完整规范见：

```text
reference/README.md
```

推荐流程：

1. 复制 `reference/maps/minimal/`；
2. 修改地图 ID / 名称 / 尺寸；
3. 设计 Layer Plan；
4. 添加 Feature Geometry / Capability；
5. 添加素材；
6. 通过 `prepareMapPackage()` 校验；
7. `npm test`；
8. `npm run build`；
9. 在 `src/map-package/default-map.js` 切换默认 MapPackage；
10. 运行完整 Runtime 验收。

主入口 `src/main.js` 不应该因为换地图而修改。

---

## 10. CI 关键验收

V1.5.3 CI 要求：

1. Core / Reference 边界检查通过；
2. Node tests 全部通过；
3. JavaScript syntax 通过；
4. Vite production build 成功；
5. 默认兰州 MapPackage 已打进 `app/index.html`；
6. 删除 `reference/` 后 Runtime 仍可启动；
7. Windows 实际运行打包后的 `start-rpgmap.bat local`；
8. `/api/health` 必须明确 `publicMode=false`；
9. 最终 ZIP 根目录 **只能有一个 BAT：`start-rpgmap.bat`**；
10. 旧 Split Launcher / Setup / Public Server BAT 不允许重新进入安装包。

这组约束用于同时防止地图架构和启动架构再次回退到多 Source of Truth。
