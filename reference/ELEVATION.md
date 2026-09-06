# RPGmap 米制高度与空间移动

v2.4.0 使用轻量三维空间模型。地图水平坐标仍由 MapPackage 定义，并通过 `metersPerUnit` 换算；Token、障碍、感知、光源和路径点的垂直坐标统一使用米。

## 数据语义

Token 保存离地高度：

```js
token: {
  elevationMeters: 3.6576
}
```

`elevationMeters` 表示 Token 当前离地高度，不表示角色身体高度。旧存档中的 `elevationFt` 仅在 World 3 → 4 迁移入口按 `feet * 0.3048` 转换，迁移后拒绝旧字段，重复加载不会再次换算。

Feature 的 MapPackage capability 可以声明阻挡顶部高度：

```js
capabilities: {
  navigation: {
    blocks: true,
    blockingHeightMeters: 6.096
  },
  vision: {
    occluder: true,
    blockingHeightMeters: 6.096
  }
}
```

GM 的运行时覆盖属于当前 Scene 的 Feature State：

```js
scene.featureStates[featureId].custom.blockingHeightMeters
```

读取顺序为 Scene Feature State 覆盖、MapPackage 默认值、未声明高度的兼容无限阻挡。Feature State 不回写 MapPackage，也不进入全局 preferences。

## 高度边界

阻挡采用严格边界：

```text
elevationMeters > blockingHeightMeters  → 可以越过该来源的阻挡
elevationMeters <= blockingHeightMeters → 仍被该来源阻挡
```

打开的门或声明 `passableWhenDestroyed` 且已经整毁的 Feature 会移除自身对应限制，但不会清除重叠建筑、边界、水域或其他 Feature 的阻挡。

路径段会在起点和终点之间插值高度并检查整个线段。飞行中的上升、下降和水平移动由同一个权威路径验证处理；最终点位仍必须满足对应移动方式的安全占位条件。

## 移动方式与成本

支持四种移动方式：

- `walk`：普通地面 1 倍，困难地形 2 倍。
- `swim`：天然水域和积水可以通行；没有专用游泳速度时成本 2 倍。
- `waterWalk`：在水面通行，不获得穿越其他障碍的能力。
- `fly`：允许三维路径并忽略地面及水域倍率，但仍受飞行能力、边界和合法降落点限制。

适用倍率相乘。移动预算未配置时不限；配置后以每回合米数计算。服务端验证能力来源、控制权、Combat 回合、移动预算和整组路径，并把位置与消耗作为一个原子 operation 提交。重试不会重复扣除预算。

移动 capability 必须来自 Ruleset 或 GM 授权。普通状态编辑、Synthetic Delta 和客户端 payload 不能自行授予游泳、水上行走或飞行。移动途中失去必要能力时保留当前位置并标记为待 GM 裁决，不进行未经规则支持的自动坠落或伤害结算。

## 水域、桥梁与弹坑

天然水域和积水使用同一水面规则。充水弹坑按水域处理，残余干坑按地形/障碍数据处理。完整桥面只消除桥面自身对应的水域限制；破损桥和重叠障碍仍分别求值。

## Navigation 与 Runtime

`createNavigationGrid(..., options)` 和权威移动入口接收明确的 mover context，例如：

```js
{
  appState,
  scene,
  moverContext: {
    tokenId,
    elevationMeters,
    movementMode,
    capabilities,
    remainingBudgetMeters
  }
}
```

导航使用 1 米稀疏分块场和有界 supercover 线段检查。玩家通过 Ctrl/Cmd 添加手动路径点；客户端预览和服务端提交复用同一空间语义，但服务端始终重新读取权威 Scene、Token、Ruleset capability 和 MapPackage 数据。

未知 MapPackage 只保留明确的 bounds-only 兼容；这不等于其自定义碰撞、桥梁或水域语义已被安全支持。

## 感知、LOS 与光源

观察者与目标使用三维距离。地面 Fog 的实时范围由感知球与地面的截面得到，空中目标单独按球形距离判断。

Scene 默认 LOS 可以关闭；玩家覆盖优先于 Scene 默认。兰州 MapPackage 仅为有可靠数据的城墙、城门、州衙院墙和门洞声明有限高度遮挡，不把所有导航碰撞体自动视为视觉墙。

静态和 Token 光源使用米制位置、离地高度和三维范围，并按观察者的遮挡模式计算亮度。地面探索继续写入按 Scene 和队伍共享的 5 米网格，同时受当前 LOS 限制。

完整运动轨迹只有在该 Audience 全程可证明精确可见时才会下发；否则只投影允许公开的最终变化，不能从动画路径反推出隐藏位置。

## UI 与权限

- Token 高度显示单位为 `m`，包括 `0 m`。
- `Shift + 右键`打开快速高度 HUD；实例配置页也可编辑高度。
- Feature Inspector 显示地图默认阻挡高度和当前 Scene 覆盖；恢复默认会删除覆盖字段。
- 离线与 LAN 使用同一 Document intent。玩家编辑必须同时满足 Token 控制、Ruleset capability、Combat 和服务器权限校验。

## 当前边界

v2.4.0 不实现多楼层 Navigation Surface、地下层、桥上/桥下双层拓扑、Token 三维身体体积、门洞净高、攀爬、坠落伤害、水深或投射物完整弹道。这些能力必须扩展现有米制空间内核，不能另建平行坐标或导航系统。

Runtime 不读取 `reference/`；发布包只包含编译后的 Map Runtime。源码参考文档用于说明 Contract 和维护边界，不是生产数据源。
