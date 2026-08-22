# Changelog

RPGmap 使用语义化版本号。更细的开发过程见 `文档/工作日志.md`。

## 1.5.5 — Candidate · 2026-08-23

V1.5.5 将服务器 World 设为本地启动时的唯一状态来源，并完成了角色卡规范化模块的接入。

### Token / Startup Stability

- 在本地 RPGmap Server 模式下，浏览器启动时不再读取历史 `localStorage` World；客户端会在检测到 `/api/health` 后使用内存存储，随后以 `map/world.json` 的服务器快照为准。
- 自动 GM 连接前会让地图完成首帧绘制，避免连接与完整 World 导入抢占启动渲染。
- 空白、缺字段或结构异常的角色卡会在创建 Actor 前补齐安全默认值，防止 `undefined` 进入 Token 绑定与渲染链路。
- 新增空角色卡回归测试，覆盖 Actor / Form / Token 所需的默认数据。

## 1.5.4 — Candidate · 2026-08-22

V1.5.4 继续收口单入口 Launcher 的主机体验，不改变 MapPackage / Feature / Elevation / Navigation 数据模型。

### Startup / Multiplayer UX

- Local/LAN 与 Internet/Public 两种模式都会生成并显示 Join Code（房间号）与 GM Secret（GM 密码）。
- READY 信息集中显示本机地址、可用 LAN 地址、Internet 模式的 Cloudflare Public URL、Join Code 与 GM Secret。
- Internet 模式下主机不再通过 Public URL 访问自己的地图，而是直接打开 `127.0.0.1`，减少 Tunnel 往返和公网波动对主机加载的影响。
- Launcher 打开的 localhost URL 使用 hash 携带一次性 GM bootstrap；Client 读取后立即清除 hash，并自动以 GM 身份连接。
- GM bootstrap 只允许 localhost / 127.0.0.1 消费，不把 GM Secret 放进玩家使用的 Public URL 或普通 HTTP 查询参数。
- LAN Player 现在同样使用 Join Code 进入房间，使 Local/LAN 与 Internet/Public 的加入流程保持一致。

### CI

- Candidate workflow 名称改为版本无关的 `Build RPGmap Candidate`，实际 ZIP / VERSION.json 继续从 `package.json` 动态读取版本。
- Windows BAT smoke 额外验证 Local/LAN Server 已启用 Join Code。

## 1.5.3 — Candidate · 2026-08-22

V1.5.3 在 V1.5.2 端口互斥修复基础上进一步收口启动架构，不改变 MapPackage、Feature Interaction、Elevation 或 Navigation 数据模型。

### Single-entry launcher

- Windows 发布包只保留一个 `start-rpgmap.bat`。
- 双击后选择 `Local / LAN` 或 `Internet / Public`；也支持 `start-rpgmap.bat local|internet`。
- 新增统一 `launcher.mjs`，集中负责端口检查、Server 启动、`/api/health` READY 等待、浏览器打开、Internet Tunnel 和凭据生成。
- 删除 `local-launcher.mjs`、`internet-launcher.mjs`、`launcher-guard.mjs`，避免多套启动逻辑分叉。
- 删除 `start-rpgmap-internet.bat`、`setup-cloudflared.bat`、`run-rpgmap-public-server.bat`。
- Internet 模式自动查找 `cloudflared`；Windows 缺少时自动尝试官方下载，失败后尝试 Winget。
- Internet 模式不再额外打开 Multiplayer Info 命令行窗口，Local / Network / Public / Join Code / GM Secret 统一打印在当前 Launcher 窗口。

### Packaging / CI

- Candidate ZIP 根目录强制只能存在一个 Windows BAT：`start-rpgmap.bat`。
- CI 明确禁止旧 Split Launcher / Setup / Public Server BAT 重新进入源码和安装包。
- Windows smoke 改为执行 `start-rpgmap.bat local`，验证单入口 Launcher 能启动 `publicMode=false` Runtime。
- Linux no-reference Runtime、source separation、Node tests、syntax 与 Vite build 验证继续保留。

## 1.5.2 — Candidate · 2026-08-22

V1.5.2 修复 V1.5.1 人工验收中发现的 Local/LAN 与 Internet 启动生命周期冲突风险，不改变 MapPackage、Feature Interaction 或 Elevation 数据模型。

### Local / LAN startup

- 新增 `local-launcher.mjs`，本地入口不再先打开浏览器再启动 Server。
- 本地启动顺序改为：端口检查 → 启动 Server → `/api/health` READY → 打开 `127.0.0.1`。
- 本地启动显式清除 Public URL / Join Code / GM Secret，并强制 `RPGMAP_PUBLIC=0`，避免继承公网模式环境。
- `start-rpgmap.bat` 与 `start-rpgmap.sh` 统一通过 guarded local launcher 启动。

### Local / Internet mutual exclusion

- 新增 `launcher-guard.mjs` 检查 30000 端口占用。
- 若已有 RPGmap Local/LAN 或 Internet/Public Server，占用信息会被识别并直接报错，不再继续创建第二个 Server。
- 若端口被其他程序占用，也会给出明确错误。
- Internet launcher 在创建 Quick Tunnel 前先检查本地 origin 端口，避免等到 Tunnel 创建后才发现 Server 无法绑定。
- Local/LAN 与 Internet 是两种互斥启动方式；Internet 模式本身仍同时提供 Local、Network 与 Public URL，不需要再额外启动本地 Server。

### Validation

- 新增 launcher port-guard 自动测试。
- Windows package smoke 额外确认 `start-rpgmap.bat` 启动的是 `publicMode=false` 的 Local/LAN Server。
- Package 继续执行 Node、syntax、source separation、Vite build、Linux no-reference Runtime 与 Windows BAT no-reference Runtime 验证。

## 1.5.1 — Candidate · 2026-08-22

V1.5.1 是 V1.5.0 MapPackage / Feature Interaction / Elevation Candidate 的人工验收修订版，保持 V1.5 架构边界不变。

### Token UI / Elevation

- Token 名称固定在正上方。
- HealthSystem 保持唯一 HP 条并放在 Token 下方。
- `elevationFt` 标签移到 Token 右上角，避免与名称 / 血条冲突。
- Character Marker 直接绑定 `contextmenu`，同时保留 DOM capture 与 Map fallback；右键高度 HUD 不再依赖某一次 DOM 扫描时序。
- 高度 HUD 保持直接输入与 `-5 / +5 ft` 调整。

### Packaging / Validation

- Package version 更新为 `1.5.1`。
- Windows package smoke 使用 Linux package job 输出的实际版本，不再写死 `1.5.0`。
- `VERSION.json`、归档目录、ZIP 与 Artifact 的版本一致性继续由 CI 验证。
- 继续执行 Node、JavaScript syntax、源码独立性、Vite build、Linux no-reference Runtime、Windows BAT no-reference Runtime 全链路验证。

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
├─ capabilities.js
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
