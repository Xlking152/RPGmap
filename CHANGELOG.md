# Changelog

RPGmap 使用语义化版本号。更细的开发过程见 `文档/工作日志.md`。

## 1.5.0 — Candidate · 2026-08-22

V1.5.0 从 V1.4.1 已验证的 Multiplayer / User / Ownership / Portable Runtime 基线上重新建立地图框架，目标是让“换地图”只替换 MapPackage，不复制 Damage / Movement / Scene / Multiplayer 逻辑。

### MapPackage Framework

- 新增 `src/map-package/contract.js`。
- MapPackage 进入 Engine 前统一验证 ID、Version、尺寸、SVG Renderer、Feature ID、Layer Plan。
- 增加 MapPackage API V1 与逻辑 Layer Role：`base / terrain / liquid / structure / special / destructible / labels`。
- Feature 归一出 `inspectable / interactive / enterable / destructible` Capability。
- 主入口 `src/main.js` 不再直接 import 兰州城代码与 Generated Art，只依赖 `createDefaultMapPackage()`。

### Lanzhou Reference Map

兰州城实现从 Core 目录实际迁移到：

```text
reference/maps/lanzhou/
├─ manifest.js
├─ package.js
├─ assets.js
├─ presentation.js
├─ assets/
├─ index.js
└─ README.md
```

职责：

- `manifest.js`：Map ID / Layer Plan；
- `package.js`：兰州专属 Feature / Navigation / SVG；
- `assets.js`：素材绑定；
- `presentation.js`：兰州专属展示处理；
- `index.js`：MapPackage 组装。

旧 `src/maps/lanzhou.js` 与 `src/maps/presentation-cleanup.js` 仅保留兼容 re-export，实际地图源码不再属于 Core。

### Minimal Reference Map

- 新增 `reference/maps/minimal/`。
- 仅包含 Base / Terrain / Liquid / Special / Destructible / Labels、一栋木屋和一堵墙。
- 自动测试将 Minimal 地图交给与兰州相同的 `createDamagePreview / commitDamageEvent / deriveSceneState`。
- 测试要求 `demo-house` 正常进入 destroyed Scene State，证明可破坏逻辑属于通用 Core。

### DIY Map Documentation

新增 `reference/README.md`，记录：

- MapPackage / Core / Scene Instance / World 四层职责；
- Reference Map 目录样式；
- Layer Plan；
- Feature + Capability；
- 可破坏地图边界；
- 新地图 DIY 流程；
- 禁止重新引入外部 `maps/` 双 Source of Truth、Launcher 文件解析、Junction 等 V1.4.2/V1.4.3 实验模式。

### Runtime Model

V1.5.0 **不改变** V1.4.1 已验证的稳定 Runtime：

```text
Reference MapPackage source
        ↓ Vite build
app/index.html
        ↓
server.mjs
        ↓
Browser
```

- 当前默认兰州地图在 build 时被打入 `app/index.html`。
- `reference/` 是开发 / DIY 参考，不是 Server Runtime 数据源。
- Server 不扫描 `reference/`，不创建根 `maps/`，不创建 Junction。
- World/User 仍沿用 `map/world.json` 与 `map/users.json`；此次故意不同时做 Storage Migration。

### CI Validation

V1.5.0 CI 增加：

- 兰州源码与素材必须真实位于 `reference/maps/lanzhou/`；
- `src/assets/generated` 必须不存在；
- `src/main.js` 不允许直接出现 Lanzhou / generated asset 引用；
- production build 必须包含默认兰州 Map ID；
- 打包后完整复制 Runtime 并删除测试副本中的整个 `reference/`；
- 删除后重新启动 `server.mjs`，`/api/health` 和 `/` 仍必须成功；
- 最终 ZIP 同时包含完整 `app/` Runtime 和 `reference/` DIY 参考。

## 1.4.1 — Candidate · 2026-08-21

- Persistent Player User / Player Key；
- Actor Ownership：NONE / OBSERVER / OWNER；
- Default Actor；
- Server-authoritative Ownership 校验；
- Combat Turn Lock；
- Client Ownership preflight；
- `app/ + map/` 便携 Runtime；
- `map/world.json` / `map/users.json`；
- Quick Tunnel 身份恢复与旧 `data/worlds/default/` 兼容迁移。

## 1.4.0 — 2026-08-21

- Multiplayer V1；
- 原生 WebSocket `/ws`；
- World Snapshot + revision / baseRevision；
- GM / Player；
- Join Code / GM Secret；
- Cloudflare Quick Tunnel。

## 1.3.0 — 2026-08-21

- Selection / Measurement；
- Combat；
- Health / Damage / Healing；
- Chat / Game Log；
- Actor XLSX / Form；
- 本地 HTTP Server。

## 1.2.0 — 2026-08-21

- Actor / Token / Form EntitySystem；
- XLSX 角色导入；
- Movement / Waypoint / A*；
- AppShell；
- 初版 MapPackage。

## 1.1.0 及更早

早期版本完成基础地图浏览、Marker / Token 原型和地图数据验证。
