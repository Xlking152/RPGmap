# World Bootstrap V1 架构约定

本文记录 RPGmap 2.x 的 World-first 启动边界。后续 World、Scene、MapPackage、Ruleset 与 Actor/Token 外观相关开发应以本文为准，不得重新引入按地图启动、按地图存储或浏览器默认 Ruleset 覆盖既有 World 等旧路径。

## 1. 总体所有权

```text
RPGmap Core
├─ World Manager / World Catalog
├─ Scene Manager
├─ MapPackage Registry
├─ Actor / Token Core Contract
├─ Runtime / Persistence / Multiplayer
└─ 通用地图与交互能力

World
├─ ruleset -> Ruleset reference
├─ actors[]
├─ scenes[]
└─ activeSceneId

Scene
├─ mapPackage -> MapPackage reference
├─ tokens[]
├─ markers[]
├─ attackAreas[]
├─ sceneEvents[]
└─ settings

Ruleset
└─ 解释 Actor.system、Health、Combat、Presentation 等规则语义

MapPackage
└─ 提供地图尺寸、SVG/资产、Feature、导航与地图内容
```

核心原则：**Actor 属于 World；Token 属于 Scene；World 绑定 Ruleset；Scene 绑定 MapPackage。**

## 2. World Catalog 与持久化

现代本地 World 使用两层存储：

```text
rpgmap:world-catalog:v1
rpgmap:world:<worldId>:v1
```

World Catalog 只保存用于选择和启动的轻量描述信息；完整 World save 按 `worldId` 独立存储。MapPackage ID 不是 World 的存储主键。

旧键：

```text
rpg-map:<mapId>:v1
```

只允许作为 legacy migration 输入。首次识别后应复制/迁移到 World-id save 并登记 World Catalog；旧键可保留作为兼容备份，但新代码不得继续向旧键写入现代 World。

## 3. 启动顺序

Runtime 创建前必须先确定 World、Ruleset、Active Scene 与 MapPackage。

标准启动链：

```text
startRpgMap
  ↓
检测 Local / LAN Server
  ↓
读取或选择 World
  ↓
读取 World.ruleset
  ↓
解析 World.activeSceneId
  ↓
读取 ActiveScene.mapPackage
  ↓
MapPackageRegistry.load(reference)
  ↓
prepareStoredWorldState
  ↓
createRpgMapRuntime
  ↓
安装 Scene / Token / Movement / Health / Multiplayer 等系统
```

禁止恢复以下启动方式：

```text
先 createDefaultMapPackage()
再决定 World

或

先使用浏览器默认 Ruleset
再覆盖已有 World.ruleset
```

已有 World 的 Ruleset **只服从 `World.ruleset`**。浏览器默认值只可用于创建/迁移一个尚未绑定 Ruleset 的新 World。

## 4. MapPackage Registry

MapPackage 通过 Registry 注册与解析，不由 `main.js` 直接 import 某张具体地图实现。

Registry 支持：

```js
registry.registerPackage(mapPackage)
registry.registerLoader({ id, version, title, load })
registry.list()
await registry.load({ id, version })
registry.require(...)
```

Built-in MapPackage 也通过 Registry 注册。未来 External MapPackage 应复用相同 Contract 与 Registry，而不是另建一套启动分支。

版本引用属于 Scene：

```js
scene.mapPackage = {
  id: 'example-map',
  version: '1.0.0'
}
```

当前 V1 对不兼容的显式版本返回 mismatch；自动升级/迁移策略留给后续 MapPackage Version Policy。

## 5. Scene 激活与跨 MapPackage 切换

同一个 MapPackage 内切 Scene 可以在当前 Runtime 中完成 canonical `activeSceneId` 更新与 Scene 投影切换。

跨 MapPackage 时不热替换已经初始化的 Leaflet Runtime：

```text
Scene A / map-a
  ↓ activate
canonical World.activeSceneId = Scene B
  ↓ persist / server commit
Scene B / map-b
  ↓
reload Runtime
  ↓
重新执行 World -> ActiveScene -> MapPackage 启动链
```

原因：MapPackage 不只影响底图，还可能改变尺寸、Feature、Navigation、Collision、Interaction 与资产依赖。V1 使用“canonical commit + Runtime reload”保持边界清晰。

LAN 客户端收到服务器权威 World 后，如果发现：

```text
requested ActiveScene.mapPackage.id != loaded Runtime MapPackage.id
```

不得把新 World 强行 import 到旧地图 Runtime；应更新已知 revision/状态后 reload，再从服务器 bootstrap 获取新的 Active Scene MapPackage。

## 6. New World Ruleset Setup

创建新 World 时同时选择：

```text
World 名称
Ruleset
初始 MapPackage
```

创建结果必须把 Ruleset reference 写入 World canonical state，而不是只保存在浏览器偏好中。

空 LAN Server World 也遵循同一原则：首次初始化时选择 Ruleset，随后服务器 World 成为权威来源。

## 7. Actor / Token Core 外观

Core Actor 正式拥有通用外观字段：

```js
Actor {
  id,
  name,
  img,
  prototypeToken: {
    texture: { src },
    color,
    diameterMeters,
    showName
  },
  system,
  effects,
  ...
}
```

具体 Ruleset 可以在 `Actor.system` 的当前 Form 中提供 presentation override，但 `img/prototypeToken` 不再是 Ruleset 私有字段或依赖对象 spread 偶然保留下来的字段。

Scene Token 可保存实例级外观覆盖：

```js
Token {
  id,
  actorId,
  texture: { src },
  color,
  diameterMeters,
  ...
}
```

渲染优先级固定为：

```text
Token 显式实例覆盖
  > Ruleset 当前 Form presentation
  > Actor.prototypeToken / Actor.img 默认值
```

其中 Token 的显式值只影响该 Scene Token，不应写回 Actor 或其他同源 Token。

## 8. Health Authority 不因本轮改变

World Bootstrap V1 不重新设计 Health。继续保持上一阶段已经收束的边界：

- `system.runtime.health` 是 HP/伤势运行时唯一权威来源；
- `system.runtime.resources.hp` 不得持久化；
- 已存在 Health Runtime 时，stale legacy HP mirror 不得覆盖其 current/maxOverride/B-L-A；
- `resource.*` 对 `hp` 必须被阻断，Health 操作继续走 Ruleset Health Contract；
- legacy `resources.hp.max` 只保留读取/迁移兼容，不恢复 generic Resource authority。

## 9. 下一阶段

World Bootstrap V1 收束后，真正还未完成的架构工作主要是：

1. **External MapPackage 安装/导入**：manifest、资产目录、校验、沙箱/安全边界、Registry discovery。
2. **MapPackage version migration/update policy**：Scene pinning、兼容范围、升级预览、迁移与回滚。
3. **完整 Scene Manager UI**：create / rename / duplicate / delete / reorder，以及初始 MapPackage 选择。
4. **Server multi-World Manager**：服务器 World catalog、创建/切换/归档、权限与启动选择。
5. **Asset Store**：Actor/Token 图片与 MapPackage 资产引用，逐步替代大型 data URL。
6. **External Ruleset package discovery/install**：Ruleset manifest、版本依赖、安装/升级/隔离。

这些功能应建立在本文件定义的 World-first 启动链上，而不是再次增加平行 bootstrap 路径。
