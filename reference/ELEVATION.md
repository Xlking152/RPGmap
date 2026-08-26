# RPGmap Elevation / Height Blocking

V1.5 的高度系统采用轻量 **2.5D Movement** 模型：地图仍然是二维平面，但 Navigation 在判断 Feature 障碍时会读取当前移动 Token 的离地高度。

## 数据语义

Token 保存：

```js
token: {
  elevationFt: 30
}
```

`elevationFt` 表示 Token 当前离地高度，不表示角色身体身高。

Feature 的 MapPackage Capability 保存默认阻挡顶部高度：

```js
capabilities: {
  navigation: {
    blocks: true,
    blockingHeightFt: 20
  }
}
```

GM 在运行中的修改不回写 MapPackage，而进入 Feature State：

```js
preferences.featureStates[featureId].custom.blockingHeightFt
```

读取优先级：

```text
World Feature State override
        ↓ 没有
MapPackage blockingHeightFt
        ↓ 没有
legacy infinite-height blocking
```

## 通行规则

严格使用：

```text
elevationFt > blockingHeightFt  → 忽略该 Feature 的阻挡

elevationFt <= blockingHeightFt → 该 Feature 正常阻挡
```

因此 20 ft 的 Token 面对 20 ft 障碍仍然被挡；21 ft 才能越过。

Open / Destroyed 的既有规则优先保留：已经打开的可通行门、已经摧毁且声明 `passableWhenDestroyed` 的 Feature 不需要再通过高度判断。

## 阻挡与通道几何

Navigation 允许 MapPackage 分离视觉几何与通行几何：

```text
blockingPolygon  → Feature 关闭/阻挡状态下真正栅格化的障碍区域
passagePolygon   → Feature 打开/摧毁后恢复的通行区域
```

未声明 `blockingPolygon` 时继续使用 Feature 自身 geometry，保证普通建筑、墙体和旧地图兼容。

这一分离用于解决兰州城门的实际门洞问题：部分城墙预留门洞宽于城门楼视觉矩形，直接用视觉矩形阻挡会让旧的粗网格路线从两侧漏过。兰州 Reference Map 在自己的 Capability 转换中声明跨门洞的 `blockingPolygon`；Core 只读取通用 Navigation 字段，不包含城门或兰州专属判断。

## Runtime Adapter

V1.5 仍保留历史 `engine/app.js` 的 Navigation 调用方式。`src/elevation/runtime-context.js` 作为兼容适配层，向 Navigation 提供当前 mover context 与 App State；新代码/测试也可以直接向 `createNavigationGrid(..., options)` 传入：

```js
{
  appState,
  moverContext: {
    characterId,
    elevationFt
  }
}
```

旧 Movement/App 可以缓存 Navigation facade，但 facade 的 `grid` 会在 mover 高度或 Feature State 改变后重新解析，避免从一个 Token 切换到另一个 Token 时复用错误的障碍网格。

V1.5 还保留一个很小的 Character Placement compatibility guard：旧 App 的“放置角色”按钮使用私有 `setTool()`，因此进入放置模式时主动把 mover context 重置到 `0 ft`，防止新地面 Token 继承上一个飞行 Token 的越障能力。

未来 App/Scene 拆分后应把 mover context 作为显式参数一路传递，并删除这些兼容型 Runtime Adapter。

## Token UI

- Token 顶部固定显示 `elevationFt`，单位 `ft`，包括 `0 ft`。
- Token 下侧显示 HP bar；HP 读取 Actor 的通用 `hp` Resource。
- 右键 Token 打开紧凑 Elevation HUD，可直接输入或使用 `-5 / +5`。
- 本地模式可直接编辑；多人模式继续服从现有 Actor OWNER 与 Combat Turn Lock。

Token 高度保存在 `preferences.entitySystem.tokens`，因此沿用现有 Entity Save / Multiplayer ownership 链路，不创建第二份 Token 状态。

## Feature Inspector

所有声明 `navigation.blocks = true` 的 Feature 都可以在通用 Inspector 中看到“高度阻挡”。该 UI 不判断 `building / wall / gate` 类别。

- 显示 MapPackage 默认高度与当前有效高度。
- `-5 / +5` 或输入数值修改 World override。
- “恢复地图默认”删除 override。
- 连接模式下当前仅 GM 可以编辑 World 级 Feature 高度。

兰州 Reference Map 当前默认：

```text
普通建筑      20 ft
城墙          30 ft
可开关城门    30 ft
```

Minimal Reference Map 也提供不同高度的示例 Feature，用于证明 Core 不依赖兰州类别。

## 路径规划验证

V1.6.3 使用 1m 稀疏分块导航场和有界整数 supercover 直线检测，不会建立自动绕行路径：

1. 通用全宽障碍关闭时，`findDirectNavigationPath()` 必须返回 `null`。
2. 同一障碍传入 `calculateWaypointRoute()` 时必须返回 `valid: false`，并标出首个阻挡格。
3. 打开同一 Feature 后直线必须恢复。
4. 角色高度严格超过障碍高度后直线必须恢复。
5. 兰州北/东/南/西四座真实城门分别验证：关闭时直线受阻，打开后恢复通行。
6. 历史浮点 DDA 卡死坐标、长对角线和角点穿越均在 Worker 的硬时限内返回。

因此“Feature State → 1m Navigation Field → bounded direct check → Movement waypoint planner”的阻挡链路有直接回归覆盖；受阻时由玩家用 Ctrl/Cmd 添加可通行的直线拐点。

## 独立性边界

Runtime 不读取 `reference/`；CI 会在打包后删除整个 `reference/` 再启动 Linux Runtime，并对 Windows 包执行同样的 no-reference BAT smoke。

源码仓库中允许且只允许三个显式兰州适配入口：

```text
src/map-package/default-map.js          build-time 默认地图打包入口
src/maps/lanzhou.js                     历史 import compatibility shim
src/maps/presentation-cleanup.js        历史 presentation compatibility shim
```

自动测试扫描 `src/`，防止新增其他兰州 Reference import；同时扫描 `engine / movement / interaction / elevation`，禁止兰州地图 ID 和城门 ID 进入通用 Core。

这表示 V1.5 达成的是 **Runtime 独立 + Core 规则独立**，而不是为了形式上的“零源码引用”删除仍需兼容旧调用的薄适配器。后续完成 AppCore/Scene 重构时再逐步删除 compatibility shim。

## V1.5 边界

本版高度只影响 **Feature Navigation obstacle**。水体、弹坑、洪水仍按原二维规则处理。以下内容统一保留到未来计划：

- 地形/地面海拔与相对高度换算；
- 多楼层 / 楼层切换；
- 桥上 / 桥下双层通行；
- 上升、下降与飞行移动消耗；
- 坠落与坠落伤害；
- Vision / LOS 观察高度；
- 远程攻击、投射物越障高度；
- Token 身体高度、体积与姿态；
- 水体 / 弹坑 / 洪水的垂直语义。
