# RPGmap Feature Interaction API

本文件补充 `reference/README.md` 的 MapPackage 规范，专门说明 Feature Capability、Feature State、Interaction Effects 与通用 Interaction UI/API。

## 设计边界

```text
MapPackage Feature
  ↓ capabilities/actions + featureTaxonomy + capabilities.navigation
Feature State / Feature Operations
  ↓
InteractionSystem（Generic UI + Runtime Adapter）
  ↓
Movement / Navigation / Damage / Scene State / Renderer / Multiplayer
```

地图只声明“是什么、能做什么、如何显示、在什么状态下具有什么物理语义”，Core 决定“怎么执行规则”。地图包不得复制 InteractionSystem、DamageSystem、NavigationSystem 或 MovementSystem。

## Capability

新地图推荐显式声明：

```js
capabilities: {
  inspectable: true,
  interactive: true,
  enterable: true,
  destructible: true,
  openable: false,
  actions: {
    inspect: true,
    enter: true,
    exit: true,
    damage: true,
    restore: true,
    open: false,
    close: false,
  }
}
```

`src/map-package/contract.js` 会兼容旧的 `enterable` / `destructible` 等字段，并统一生成标准 Capability。新的 UI 和 Feature Operations 只读取归一后的 Capability，不按地图 category 决定操作规则。

## Feature Taxonomy / UI Labels

地图自己的类别、子类型和详情字段显示名放在 MapPackage：

```js
featureTaxonomy: {
  categories: {
    mechanism: '机关',
    vehicle: '载具',
  },
  subtypes: {
    portal: '传送门',
  },
  detailFields: {
    purpose: '用途',
    structure: '构造',
  },
}
```

`src/interaction/ui-model.js` 是纯通用 UI 模型。Core 对未知 category/subtype 会直接显示其原始 ID，因此添加 `door / chest / mechanism / portal / vehicle` 不需要修改 Core 的标签表。

## Openable Feature

```js
{
  id: 'door-001',
  name: '木门',
  category: 'door',
  geometry: { type: 'polygon', points: [...] },
  capabilities: {
    inspectable: true,
    interactive: true,
    openable: true,
    actions: { inspect: true, open: true, close: true },
    navigation: {
      blocks: true,
      passableWhenOpen: true,
      passageTile: 'open'
    }
  },
  interaction: {
    initialState: { open: false }
  }
}
```

不要求 `category === 'gate'`。门、机关、箱盖、舱门等都使用同一个 API。

## Feature State

统一 Runtime State 视图：

```text
open
status = intact | partial | destroyed
damaged
destroyed
custom
```

当前新写入：

```text
state.preferences.featureStates[featureId]
```

其中 `open/custom` 持久化在 `featureStates`；`partial/destroyed` 继续从 Scene damage history 推导，因此不会产生第二份 destruction source of truth。

旧 V1.5 开发存档中的：

```text
state.preferences.featureInteractions[featureId]
```

仍可读取，但它只是兼容输入，新状态不再写回旧 key。

## Interaction Effects + Navigation Capability

Open/Close 不只是视觉状态。`src/interaction/effects.js` 将 Feature State 投影成 Core 可消费的运行效果，Navigation 只解释标准 Feature Navigation Capability，不判断 `building / wall / gate` 类别。

Feature 可以声明：

```js
capabilities: {
  navigation: {
    blocks: true,
    passableWhenOpen: true,
    passableWhenDestroyed: true,
    damageCreatesPassage: true,
    passageTile: 'road',
    passagePolygon: [[...], [...], [...]]
  }
}
```

语义如下：

- `blocks`：完整、未满足放行条件时参与碰撞/寻路阻挡；
- `passableWhenOpen`：`open=true` 时恢复可通行；
- `passableWhenDestroyed`：Scene 中对象整毁后恢复可通行；
- `damageCreatesPassage`：局部 `clipHits` 可在阻挡几何中形成破口；
- `passageTile`：可选 `road` / `open`，未指定时恢复该位置的基础 Navigation tile；
- `passagePolygon`：可选放行区域，例如门只在实际通道区域刻出 passage。

这些字段只描述 Feature 内容/物理语义；“什么时候读取 state、怎样合并 Scene damage、怎样重建栅格”仍属于 Core。

## Runtime API

注册 `createFeatureInteractionSystem()` 后：

```js
api.interaction.actionsForFeature(featureId)
api.interaction.stateForFeature(featureId)
api.interaction.snapshot(featureId)
api.interaction.execute(action, options)
api.interaction.inspect(featureId)
api.interaction.enter(featureId, characterId)
api.interaction.exit(featureId, characterId)
api.interaction.damage(featureId)
api.interaction.restore(featureId)
api.interaction.open(featureId)
api.interaction.close(featureId)
api.interaction.patchState(featureId, patch)
```

`actionsForFeature()` 返回动作是否可执行及原因。例如对象 destroyed 后，enter/damage/open/close 自动禁用，restore 自动启用。

## Inspect / Browse Selection

`src/engine/feature-selection.js` 使用：

```text
feature.capabilities.actions.inspect
feature.capabilities.inspectable
```

没有历史 category allowlist fallback。

InteractionSystem 也为普通浏览点击提供通用 Feature 选择：点击任何可检查 Feature 都可以进入检查面板，不再只选择 `building`。

## Generic Feature UI

检查面板的可操作按钮统一从 `actionsForFeature()` 生成，而不是由地图或 category 写死：

```text
进入
离开
破坏对象
恢复对象
打开
关闭
```

Feature 的详情使用 `feature.details + featureTaxonomy.detailFields` 渲染；内部角色使用通用 Feature location helper 渲染；类别/子类型文本由 MapPackage taxonomy 决定。

因此新地图不应该复制检查面板，也不应该为了显示自己的分类名称修改 `app.js`。

## Enter / Exit

Feature 提供：

```text
entrance: [x, y]
capabilities.actions.enter = true
```

InteractionSystem 调用 Movement Runtime port 到入口，再进入 Feature。地图不实现移动逻辑。

V1.4.1 存档/Runtime 内部仍存在历史 `location.type = 'building'` 表示。它只在 `src/interaction/ui-model.js` 和 Interaction Runtime adapter 中作为兼容输入识别，Feature Operations 和 MapPackage 不认识也不要求 `building` 语义。以后 Scene/Actor schema 升级时可把该兼容端口替换为正式 `type: 'feature'`，不改变 MapPackage 与 Interaction API。

当一个可进入 Feature 被整毁后，Interaction adapter 会按通用 `enterable + destroyed` 状态疏散内部角色，而不是按 `category === 'building'` 决定。

## Damage / Restore

直接破坏 Feature 仍复用原来的：

```text
createDamagePreview
→ commitDamageEvent
→ sceneEvents
→ deriveSceneState
```

不会创建第二套“地图互动破坏状态”。Restore 继续调用 Core `restoreFeatures()`。

范围破坏面板的 category 显示使用 MapPackage `featureTaxonomy`；具体哪些 category 可破坏仍来自 `mapPackage.destructibleCategories` / Capability，而不是由兰州 UI 标签决定。

## SVG Runtime Hooks

Renderer / Interaction 会给对应 SVG Feature 同步：

```text
interaction-open
interaction-closed
data-interaction-open="true|false"
data-feature-state="intact|partial|destroyed"
data-feature-damaged="true|false"
```

地图作者可以用这些统一状态钩子控制视觉表现。

## V1.4.1 Compatibility Boundary

旧 `app.js` 中还保留少量历史 action/location 名称以保证旧存档和稳定 Runtime 不被一次性重写，例如：

```text
restore-feature
enter-building
exit-building
location.type = building
```

这些名称现在只由 `src/interaction/system.js` / `ui-model.js` 在适配边界接管和翻译。实际可见 UI、动作判断、Feature State 和 MapPackage Contract 都使用通用 Feature 语义。后续重构可以删除该兼容端口，而无需修改地图包。

## Reference Tests

`reference/maps/minimal/` 包含：

```text
demo-house  enterable + destructible + navigation obstacle
demo-door   inspectable + openable + open/close collision effect
demo-wall   destructible + damage passage
```

测试同时使用 `mechanism / prop / portal` 等非兰州 category，验证：

- Capability 驱动检查与动作；
- Feature taxonomy 驱动 UI 标签；
- Feature State 统一 open/custom/damage status；
- generic Feature location helper 兼容旧 location schema；
- open/close 改变 collision + A*；
- direct damage 不经过 category routing。
