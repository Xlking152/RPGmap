# Changelog

RPGmap 使用语义化版本号。这里记录版本级的重要变化；更细的开发过程见 `文档/工作日志.md`。

## 1.4.2 — Candidate · 2026-08-22

V1.4.2 继承 V1.4.1 Candidate 的 Player Identity、Actor Ownership 与 Combat Turn Lock，并进一步把发布包的数据模型统一为 **`app/ + world/ + maps/`**。本版本重点是把程序、当前跑团状态和真实地图资源彻底分开，为后续多地图、可破坏建筑和 Scene System 做结构准备。

### Portable Layout

- `app/`：RPGmap 前端程序。
- `world/`：当前 World / Campaign 的全部默认可写运行数据。
- `maps/`：真正的 Map / Scene 资源库，不再承担 User / World 持久化职责。
- `world/state.json` 取代 V1.4.1 Candidate 的 `map/world.json`。
- `world/users.json` 取代 `map/users.json`。
- `world/uploads/` 与 `world/backups/` 跟随当前 World 保存。
- `maps/` 预留给地图 manifest、背景、建筑、墙体、可破坏对象、碰撞 / Navigation、环境特效和损坏 / 摧毁变体。
- 默认不依赖 AppData、用户主目录或其他隐藏 User Data 目录。

### Storage Migration

- 新增 V1.4.1 Candidate → V1.4.2 自动迁移：
  - `map/world.json` → `world/state.json`
  - `map/users.json` → `world/users.json`
  - `map/uploads/` → `world/uploads/`
  - `map/backups/` → `world/backups/`
- 继续兼容更老目录：
  - `data/worlds/default/world.json` → `world/state.json`
  - `data/worlds/default/access.json` → `world/users.json`
- 旧文件不会自动删除。
- 新 `world/` 文件存在时永远优先，不会被旧数据覆盖。
- `portable-storage.mjs` 统一维护 app / world / maps 路径及迁移逻辑。

### Documentation Roles

- GitHub 根 `README.md` 改为纯项目总览：项目目标、整体架构、V1.4.2 数据边界与后续路线。
- 发布 ZIP 根目录不再复制项目 `README.md`。
- 新增发布包根 `操作说明.md`，专门面向 GM / Player，说明启动、联机、User、Ownership、Combat、备份和迁移。
- Release workflow 取消“必须全部 ASCII 路径”的旧限制，以支持有意使用的中文 `操作说明.md`。

### Packaging / CI

- 测试包与正式 Release 均强制生成：
  - `app/`
  - `world/`
  - `maps/`
  - `操作说明.md`
- CI 明确拒绝最终 ZIP 中重新出现 `map/`、`data/`、`public/` 或包内根 `README.md`。
- `VERSION.json.storageMode` 更新为 `portable-world-maps`。
- Windows / Linux 启动脚本改用 `RPGMAP_WORLD_DIR` 与 `RPGMAP_MAPS_DIR`。

### Player Identity / Actor Ownership

- 继承 V1.4.1 Candidate 的 persistent Player User、pending → GM approve、预创建 User + Player Key。
- User / 默认 Actor / Ownership / Credential Hash 保存到 `world/users.json`。
- Actor 权限仍为 `NONE / OBSERVER / OWNER`。
- GM 对全部 Actor 隐式拥有完整权限。
- Player 只能修改 OWNER Actor；Server 仍为最终权限裁决者。

### Combat Turn Lock

- Combatant、Initiative、排序、开始 / 结束、Round / Turn 继续保持 GM-only。
- Combat active 时，Player 只能操控当前 Turn 对应且自己拥有 OWNER 的 Actor。
- Client preflight + Server authoritative validation 继续双层执行。

### Map / Scene Boundary

V1.4.2 只先建立目录与数据边界，不在本版本强行加入完整多地图系统。

约定：

- `maps/` 描述地图 / Scene **是什么**。
- `world/state.json` 描述当前游戏里地图实例**发生了什么**。

例如建筑模板、碰撞、破坏阶段资源属于 `maps/`；当前 HP、燃烧、坍塌状态属于 `world/state.json`。

## 1.4.1 — Candidate · Superseded by 1.4.2

V1.4.1 Candidate 建立了持久 Player Identity、Actor Ownership、Server-authoritative Combat Turn Lock 和初版 Portable Storage。其 `app/ + map/` 数据结构没有进入正式 `main`，已由 V1.4.2 的 `app/ + world/ + maps/` 结构取代。

主要能力继续保留到 V1.4.2：

- pending Player → GM 批准 → Persistent User；
- Player Key / Browser Token；
- NONE / OBSERVER / OWNER；
- GM Users 面板；
- Server 越权校验；
- Combat Turn Lock；
- Player Token Movement 权限预检。

## 1.4.0 — 2026-08-21

V1.4.0 正式加入 Multiplayer V1，使 RPGmap 从单机 / 局域网地图工具扩展为可通过 WebSocket 共享 World 的自托管 VTT，并提供 Windows 一键远程联机入口。

### Multiplayer Server / World Store

- 原生 WebSocket `/ws`。
- `data/worlds/<world-id>/world.json` World Store。
- World revision / baseRevision 冲突保护。
- `hello / welcome / presence / world.push / world.snapshot / world.conflict / world.request`。
- Server 重启后恢复共享 World。

### GM / Player / Internet

- Join Code 与 GM Secret。
- Cloudflare Quick Tunnel 一键远程联机。
- HTTP/2 over TCP 提高 VPN / TUN / 校园网兼容性。
- 独立 Multiplayer Info 窗口显示 Public URL / Join Code / GM Secret。

## 1.3.0 — 2026-08-21

- SelectionSystem 多选 / 框选。
- FVTT 风格 Ruler 与角色测距。
- CombatSystem、先攻表、轮次与回合推进。
- SimpleHP / WoundTrack、DamageSystem、HealingSystem 和 Token 生命条。
- Chat / Game Log。
- XLSX Actor Sheet、Form 与不良状态。
- 本地 HTTP Server 和发布包启动脚本。

## 1.2.0 — 2026-08-21

- Actor / Token / Form EntitySystem。
- XLSX 角色导入。
- MovementSystem、Waypoint 与移动成本重构。
- AppShell UI 与 MapPackage 架构。

## 1.1.0 及更早

早期版本主要完成基础地图浏览、Marker / Token 原型、坐标与地图数据验证，为后续 VTT 架构重构提供基础。
