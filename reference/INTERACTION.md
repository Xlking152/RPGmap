# RPGmap Feature Interaction API

本文件补充 `reference/README.md` 的 MapPackage 规范，专门说明 Feature Capability、Interaction Effects 与通用 Interaction API。

## 设计边界

```text
MapPackage Feature
  ↓ capabilities/actions + capabilities.navigation
RPGmap InteractionSystem / Interaction Effects
  ↓
inspect / enter / exit / damage / restore / open / close
  ↓
Movement / Navigation / Damage / Scene State / Renderer / Multiplayer
```

地图只声明“能做什么、在什么状态下应具有什么物理语义”，Core 决定“怎么执行这些规则”。地图包不得复制 InteractionSystem、DamageSystem、NavigationSystem 或 MovementSystem。

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

`src/map-package/contract.js` 会兼容旧的 `enterable` / `destructible` 字段，并统一生成标准 Capability。

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
  interaction: { initialOpen: false }
}
```

不要求 `category === 'gate'`。`door`、机关、箱盖、舱门等都使用同一个 API。

## Interaction Effects + Navigation Capability

Open/Close 不再只是视觉状态。`src/interaction/effects.js` 将 Interaction state 投影成 Core 可消费的运行效果，Navigation 只解释标准 Feature Navigation Capability，不判断 `building` / `wall` / `gate` 类别。

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
- `passableWhenOpen`：Interaction `open=true` 时恢复可通行；
- `passableWhenDestroyed`：Scene 中对象整毁后恢复可通行；
- `damageCreatesPassage`：局部 `clipHits` 可在阻挡几何中形成破口；
- `passageTile`：可选 `road` / `open`，未指定时恢复该位置的基础 Navigation tile；
- `passagePolygon`：可选放行区域，例如城门只在门洞区域刻出通道，而不是把整个 Feature 外包框变成道路。

这些字段描述地图对象的内容/物理语义；“什么时候读取 open、怎样合并 Scene damage、怎样重建栅格”仍全部属于 Core 规则。

## Runtime API

注册 `createFeatureInteractionSystem()` 后：

```js
api.interaction.actionsForFeature(featureId)
api.interaction.snapshot(featureId)
api.interaction.inspect(featureId)
api.interaction.enter(featureId, characterId)
api.interaction.exit(featureId, characterId)
api.interaction.damage(featureId)
api.interaction.restore(featureId)
api.interaction.open(featureId)
api.interaction.close(featureId)
```

`actionsForFeature()` 返回动作是否可执行及原因。例如对象已经 destroyed 时，enter/damage/open/close 会自动禁用，restore 会自动启用。

## Inspect

`src/engine/feature-selection.js` 优先读取：

```text
feature.capabilities.actions.inspect
```

只有旧地图没有 Capability 时才回退到历史类别规则。因此自定义 `door/chest/mechanism/vehicle` 不需要改 Core。

## Enter / Exit

Feature 提供：

```text
entrance: [x, y]
capabilities.actions.enter = true
```

InteractionSystem 调用通用 Movement API 到入口，再进入该 Feature。地图不实现移动逻辑。

## Damage / Restore

直接破坏 Feature 仍复用原来的：

```text
createDamagePreview
→ commitDamageEvent
→ sceneEvents
→ deriveSceneState
```

不会创建第二套“地图互动破坏状态”。Restore 继续调用 Core `restoreFeatures()`。

## Open / Close State

Open/Close 当前保存到：

```text
state.preferences.featureInteractions[featureId].open
```

这是为了保持 V1.4.1 Save Schema 兼容，并且仍会跟随完整 World Snapshot 同步。未来升级正式 Scene Instance Schema 时，把这块迁移到 Scene 文档即可，Interaction API 不变。

Renderer 会给对应 SVG Feature 同步：

```text
interaction-open
interaction-closed
data-interaction-open="true|false"
```

地图作者可以用这些统一状态钩子控制视觉表现。

## UI Bridge

InteractionSystem 会接管旧 UI 中的：

```text
restore-feature
enter-building
exit-building
```

并在检查面板依据 Capability 自动加入：

```text
破坏对象
打开
关闭
离开
```

因此地图包不应该自己复制兰州城检查面板。

## Reference Tests

`reference/maps/minimal/` 包含：

```text
demo-house  enterable + destructible + navigation obstacle
demo-door   inspectable + openable + open/close collision effect
demo-wall   destructible + damage passage
```

`tests/interaction.test.js` 验证通用动作状态；`tests/navigation.test.js` 额外使用非 `gate` 类别的 openable Feature 验证关闭阻挡、打开放行、A* 路径变化，以及兰州城门/城墙在同一套 Capability 下的行为。
