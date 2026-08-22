# Lanzhou Reference MapPackage

兰州城是 RPGmap 的复杂 **Reference Map**，用于验证真实大地图能够通过统一 MapPackage Contract 运行，而不是把兰州专属逻辑写入 Core。

## 文件职责

```text
manifest.js      Map ID 与逻辑 Layer Plan
package.js       兰州专属几何、Feature、Navigation、SVG 生成
assets.js        Generated Art 素材绑定
presentation.js  兰州展示文本清理
assets/          兰州素材
index.js         最终 MapPackage 组装入口
```

## 当前逻辑层

- Base：纸张/基础背景；
- Terrain：当前历史实现与 Base 同源，后续可继续物理拆分；
- Liquid：黄河；
- Special：Damage / Flood 等运行时表现；
- Destructible：建筑、城墙、桥梁、植被、地形 Feature；
- Labels：地名与说明。

## 重要原则

兰州包可以描述“什么对象能破坏”，但 **不能拥有自己的 DamageSystem**。Damage、Restore、Undo、Scene State、Interaction、Movement、Navigation 执行逻辑都应来自 `src/` Core。
