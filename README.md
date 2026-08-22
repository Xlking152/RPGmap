# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器端自托管地图与跑团平台。当前开发 Candidate 为 **V1.5.0 MapPackage Framework**；它从已验证的 V1.4.1 Multiplayer / User / Ownership 基线上重新整理“地图内容”和“通用游戏逻辑”的边界。

## V1.5.0 的核心原则

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

当前仍保持 V1.4.1 的稳定运行模型：地图源码在 **build 时** 与 Core 一起打进 `app/index.html`，Server 只负责提供完整 Client 和保存 World/User 数据。不会再让 Launcher、BAT 或 PowerShell 去扫描外部 `maps/`。

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

`reference/` 是源码 / DIY 参考，不是运行时依赖。构建完成后即使删除 `reference/`，`app/index.html` 仍应可以独立运行；CI 会专门验证这一点。

---

## 1. 兰州城 Reference MapPackage

原来散在 `src/maps/` 和 `src/assets/generated/` 的兰州城地图内容已经整理到：

```text
reference/maps/lanzhou/
├─ manifest.js       # Map ID、版本方向、逻辑 Layer Plan
├─ package.js        # 兰州专属几何、Feature、Navigation、SVG 生成
├─ assets.js         # 兰州素材绑定
├─ presentation.js   # 兰州专属展示文本处理
├─ assets/           # Generated Art
├─ index.js          # 组装 MapPackage
└─ README.md
```

兰州城现在是 **Reference Map**：它负责描述地图，不拥有自己的 DamageSystem / MovementSystem / Multiplayer / Scene State。

旧 `src/maps/lanzhou.js` 只保留一个兼容 re-export，真实地图实现不再位于 Core 目录。

---

## 2. 通用 MapPackage Contract

通用接口位于：

```text
src/map-package/
├─ contract.js
├─ default-map.js
└─ index.js
```

`prepareMapPackage()` 会在地图进入 Engine 前统一验证和归一：

- ID / Version / Width / Height；
- SVG renderer；
- Feature ID 唯一性；
- Logical Layer Plan；
- Feature Capability。

标准逻辑 Layer Role：

```text
base          基础背景
terrain       地面 / 山体 / 道路地表
liquid        河流 / 湖泊 / 水域
structure     建筑 / 城墙 / 桥梁等结构（可选）
special       Damage / Flood / 火焰 / 毒区等特殊表现
destructible  可破坏 Feature
labels        地名与文字
```

物理 SVG Group 和逻辑 Layer 不必一次性完全一致。老地图可以用 `layerPlan` 映射，逐步重构而不改变 Core API。

---

## 3. Feature + Capability

所有地图对象统一视为 Feature。地图包描述对象能力，但不实现游戏规则。

例如：

```js
{
  id: 'house-001',
  name: '木屋',
  category: 'building',
  geometry: {
    type: 'polygon',
    points: [[100,100], [300,100], [300,260], [100,260]],
  },
  center: [200,180],
  enterable: true,
  destructible: {
    enabled: true,
    maxHp: 100,
    material: 'timber-earth',
  }
}
```

Contract 会归一为：

```text
feature.capabilities.inspectable
feature.capabilities.interactive
feature.capabilities.enterable
feature.capabilities.destructible
```

Damage / Restore / Undo / Scene State / Selection / Movement 等执行逻辑继续属于 Core。

---

## 4. Minimal Reference Map

为了防止 Engine 继续偷偷依赖兰州城，仓库新增：

```text
reference/maps/minimal/
```

它只有：

- 基底；
- 地面；
- 水体；
- Special Layer；
- 一栋可进入、可破坏木屋；
- 一堵可破坏墙；
- Labels。

自动测试会把它直接交给兰州城同一套：

```text
createDamagePreview
→ commitDamageEvent
→ deriveSceneState
```

并要求 `demo-house` 正常进入 destroyed 状态。这个测试用于证明“换地图只换 MapPackage，不复制可破坏逻辑”。

---

## 5. DIY 新地图

完整规范见：

```text
reference/README.md
```

推荐流程：

1. 复制 `reference/maps/minimal/`；
2. 修改地图 ID / 名称 / 尺寸 / 版本；
3. 设计 Layer Plan；
4. 添加 Feature 几何与 Capability；
5. 添加素材及 `assets.js`；
6. 保证 SVG 中 `data-feature-id` 与 Feature 对应；
7. 通过 `prepareMapPackage()` 校验；
8. `npm test`；
9. `npm run build`；
10. 将 `src/map-package/default-map.js` 切换到新 MapPackage 做运行测试。

主入口 `src/main.js` 不应该因为换地图而修改。

---

## 6. 当前 Core 能力

V1.5.0 继承 V1.4.1 的：

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
- Portable `app/ + map/` runtime storage。

当前 `map/` 名字虽然不够理想，但在这次地图框架重构中**故意不同时迁移 runtime storage**，避免再次把“地图架构”和“存储迁移”绑在一起。

---

## 7. 发布包 / Runtime

测试包仍采用 V1.4.1 已验证的启动方式：

```text
RPGmap-v1.5.0/
├─ app/                    # 完整 build 后 Client
├─ map/                    # World/User 可写 runtime 数据
├─ reference/              # DIY / MapPackage 源码参考；运行不依赖
├─ docs/
├─ server.mjs
├─ access-control.mjs
├─ portable-storage.mjs
├─ internet-launcher.mjs
├─ start-rpgmap.bat
└─ start-rpgmap-internet.bat
```

本机 / LAN：双击 `start-rpgmap.bat`。默认地址 `http://127.0.0.1:30000`。

远程联机：双击 `start-rpgmap-internet.bat`，使用 Cloudflare Quick Tunnel。

---

## 8. CI 的关键验收

V1.5.0 CI 不仅执行测试与 build，还要求：

1. 兰州实现和素材真实位于 `reference/maps/lanzhou/`；
2. `src/main.js` 不出现 Lanzhou / generated assets 直接引用；
3. production `app/index.html` 确实包含默认兰州 MapPackage；
4. 最小地图通过同一套 Core Damage / Scene State；
5. 打包后复制一份 Runtime；
6. **删除 Runtime 测试副本中的整个 `reference/`**；
7. 再启动 `server.mjs`；
8. `/api/health` 与 `/` 仍必须成功。

这条测试用于防止未来再次把“Reference Map 源码”和“运行时磁盘加载”混在一起。

---

## 9. 后续路线

在 MapPackage Contract 稳定后再推进：

```text
MapPackage Contract
        ↓
Feature Capability 收口
        ↓
通用 Interaction API
        ↓
World Manager
        ↓
Scene Manager
        ↓
Scene Instance
        ↓
Server-owned Data Path / 外部 Map Import
```

只有当 Scene Manager 从导入、实例化、Server 提供资源到保存状态整条链路都设计完成后，才考虑真正的外部地图导入。不会再提前创建一个运行时根 `maps/` 让 Client / Launcher 自己找文件。
