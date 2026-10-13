# 兰州城 Reference MapPackage

兰州城是 RPGmap 的复杂 **Reference Map**，用于验证真实大地图能够通过统一 MapPackage Contract、Feature Capability 和 Generic Feature UI 运行，而不是把兰州专属逻辑写入 Core。

## 文件职责

```text
manifest.js      Map ID、逻辑 Layer Plan、Feature taxonomy
package.js       兰州专属几何、Feature、Navigation、SVG 生成
capabilities.js  兰州内容 → 通用 Capability 声明
assets.js        Generated Art 素材绑定
presentation.js  兰州展示文本清理
assets/          兰州素材
index.js         最终 MapPackage 组装入口
```

## 当前逻辑层

- Base：纸张/基础背景父层；
- Terrain：`terrain / ruins / roads / parcels / vegetation` 等已带独立 `data-layer` 的物理子层；为兼容历史 SVG，它们当前仍嵌套在 Base 父层；
- Liquid：黄河；
- Special：Damage / Flood 等运行时表现；
- Destructible：建筑、城墙、桥梁、植被、地形 Feature；
- Labels：地名与说明。

逻辑层通过 `LANZHOU_LAYER_PLAN.sourceLayers` 解释物理子层，Core 不依赖 SVG 的历史嵌套结构。

## Feature taxonomy（对象分类）

兰州自己的显示词汇放在 `LANZHOU_FEATURE_TAXONOMY`，例如：

```text
building → 建筑
wall → 城墙
yamen → 州衙
gate → 城门
pass-gate → 关楼
```

这些是地图内容/展示元数据，不属于 Core。Generic Feature UI 通过 MapPackage taxonomy 显示它们；换成另一张地图时无需修改 Core 标签表。

## 重要原则

兰州包可以描述“什么对象能破坏、能进入、能开关、如何影响 Navigation”，但 **不能拥有自己的 InteractionSystem、DamageSystem、NavigationSystem 或 MovementSystem**。

Damage、Restore、Undo、Feature State、Scene State、Interaction、Movement、Navigation 执行逻辑都来自 `src/` Core。兰州专属的 category → Capability 转换只允许留在 `reference/maps/lanzhou/capabilities.js`，不能反向进入 Core。
