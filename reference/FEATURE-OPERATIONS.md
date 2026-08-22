# RPGmap V1.5 Feature Operations / Feature State

V1.5 的交互边界采用以下单向关系：

```text
MapPackage
  └─ Feature + Capability + initial state
          ↓
Feature State Model
  └─ open / intact|partial|destroyed / custom
          ↓
Feature Operations
  └─ inspect / enter / exit / damage / restore / open / close
          ↓ Runtime ports
Map UI / Movement / Scene / Navigation / Multiplayer
```

## 1. MapPackage 只声明内容

地图作者只描述 Feature：几何、名称、素材、Capability、入口、Navigation 效果和初始状态。地图包不实现按钮回调、状态机、Damage 结算或多人同步。

示例：

```js
{
  id: 'portal-a',
  category: 'mechanism',
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

Core 不需要知道它是 `building`、`door`、`gate` 还是任何自定义 category。

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

进入、退出等仍需要 Runtime 提供 Movement port；V1.4.1 的 `building` location 表示只存在于兼容适配边界，不属于 Feature Operations 规则。

## 4. 地图交互方式

地图不注册自己的操作函数。新地图只声明 Capability，默认 Interaction System 根据 Capability 自动得到可用动作，并通过 Feature Operations 执行。

因此第二张地图可以使用完全不同的 category，例如 `mechanism`、`portal`、`prop`，而不修改 Interaction Core。

## 5. V1.5 完成边界

V1.5 的目标是完成 **MapPackage 内容与通用操作规则解耦**：

- MapPackage = 内容模板；
- Feature State = 统一运行状态视图；
- Feature Operations = 通用操作规则；
- Interaction System = Runtime/UI 适配；
- Navigation / Scene / Movement = 被 Operations 调用的 Core 能力；
- Reference maps 不向 Core 注入地图专属函数。

Scene Instance / Scene Manager / World Manager / External MapPackage Registry 属于 V1.5 之后的架构阶段，不应反向污染这一边界。
