# RPGmap V1.5 Feature Operations / Feature State

V1.5 的交互边界采用以下单向关系：

```text
MapPackage
  └─ Feature + Capability + featureTaxonomy + initial state
          ↓
Feature State Model
  └─ open / intact|partial|destroyed / custom
          ↓
Feature Operations
  └─ inspect / enter / exit / damage / restore / open / close
          ↓
Generic Feature UI / Runtime Adapter
          ↓
Movement / Scene / Navigation / Multiplayer
```

## 1. MapPackage 只声明内容

地图作者只描述 Feature：几何、名称、素材、Capability、入口、Navigation 效果、显示 taxonomy 和初始状态。地图包不实现按钮回调、状态机、Damage 结算或多人同步。

示例：

```js
{
  id: 'portal-a',
  name: 'Portal A',
  category: 'mechanism',
  subtype: 'portal',
  entrance: [500, 400],
  capabilities: {
    inspectable: true,
    enterable: true,
    openable: true,
    actions: { inspect: true, enter: true, exit: true, open: true, close: true },
    navigation: { blocks: true, passableWhenOpen: true }
  },
  interaction: {
    initialState: {
      open: false,
      custom: { lockMode: 'manual' }
    }
  }
}
```

地图还可以声明：

```js
featureTaxonomy: {
  categories: { mechanism: '机关' },
  subtypes: { portal: '传送门' },
  detailFields: { purpose: '用途' }
}
```

Core 不需要知道它是 `building`、`door`、`gate` 还是任何自定义 category，也不需要维护这张地图自己的中文分类词典。

## 2. Feature State Model

`src/interaction/feature-state.js` 提供统一 Feature Runtime State 视图：

```text
open       可开关状态
damaged    是否存在破坏
destroyed  是否整毁
status     intact / partial / destroyed
custom     地图声明或运行时写入的 JSON 状态
```

`open/custom` 持久化在 `preferences.featureStates`；`partial/destroyed` 继续由唯一 Scene damage history 推导，不复制第二份破坏真相。

旧 V1.5 开发存档中的 `preferences.featureInteractions` 仍可读取，新写入统一使用 `featureStates`。

## 3. Feature Operations

`src/interaction/operations.js` 是不依赖 DOM、Leaflet、兰州城或 Feature category 的操作服务。

它只做：

```text
Capability 检查
→ Feature State 检查
→ 调用通用 Core state 逻辑
→ 通过 Runtime ports 请求选择/移动/退出/恢复
→ 返回统一 Action Result
```

外部调用统一从：

```text
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

## 4. Generic Feature UI

`src/interaction/ui-model.js` 负责通用 Feature UI 数据：

```text
category/subtype 显示名
Feature detail rows
entrance 文本
角色是否位于某 Feature 内
Feature location 文本
```

`src/interaction/system.js` 负责把这些数据和 `actionsForFeature()` 接到当前 Runtime UI：

- 检查面板的操作按钮完全由 Capability/Feature State 生成；
- Feature 详情不再要求 `category === building`；
- 内部角色不再由建筑类别决定；
- 普通浏览点击可以选择任何 inspectable Feature；
- 范围破坏面板使用 MapPackage taxonomy 显示 category；
- destroyed 后的内部角色按 `enterable + destroyed` 通用语义疏散；
- SVG 状态通过统一 `data-feature-*` / `interaction-*` hooks 同步。

因此第二张地图可以使用 `mechanism / portal / vehicle / chest / prop` 等完全不同的 category，而不修改 Core UI。

## 5. Compatibility Boundary

V1.4.1 的历史 `building` location/action 名称仍保留在稳定 Runtime 内部，以兼容旧存档和旧移动流程。它们只允许出现在 Interaction Runtime adapter / UI compatibility helper 中，不属于 MapPackage 或 Feature Operations 规则。

这意味着以后删除旧 compatibility port 时，只需要替换 Runtime adapter，不需要迁移每一张地图的操作实现。

## 6. V1.5 完成边界

V1.5 的目标是完成 **MapPackage 内容、Feature 操作规则和通用操作界面的解耦**：

- MapPackage = 内容模板 + Capability + taxonomy；
- Feature State = 统一运行状态视图；
- Feature Operations = 通用操作规则；
- Generic Feature UI = 通用呈现；
- Interaction System = Runtime/UI 适配；
- Navigation / Scene / Movement = 被 Operations 调用的 Core 能力；
- Reference maps 不向 Core 注入地图专属函数或分类规则。

Scene Instance / Scene Manager / World Manager / External MapPackage Registry 属于 V1.5 之后的架构阶段，不应反向污染这一边界。
