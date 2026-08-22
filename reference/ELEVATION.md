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

未来 App/Scene 拆分后应把 mover context 作为显式参数一路传递，而不是继续扩大兼容适配层。

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
