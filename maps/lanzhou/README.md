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

Damage、Restore、Undo、Feature State、Scene State、Interaction、Movement、Navigation 执行逻辑都来自 `src/` Core。兰州专属的 category → Capability 转换只允许留在 `maps/lanzhou/capabilities.js`，不能反向进入 Core。

## 街区美术样板

本轮美术调整只改变绘制：恢复现有建筑素材的瓦面与木构对比，普通建筑素材不透明度为 0.94、地标为 0.98；去掉原有褪色、强提亮与棕褐滤镜。中性土石地表、城墙砌缝、道路铺石及岸线取代原先大面积黄底，原树木使用新增透明树冠素材。

`runtime.json` 的全部权威数据保持不变，55 栋建筑及其余地物的 ID、位置、几何、道路宽度、入口、LOS 和破坏组均未变化。生成源和正式 `runtime.svg` 必须一起更新：

```powershell
npm run generate:lanzhou-runtime
node scripts/export-map-packages.mjs --out output/art-map-slice-v2 --map-version 1.1.2
```

源码地图数据版本仍为 1.1.0。第一轮 1.1.1 样板已冻结，显式 `--map-version 1.1.2` 才导出第二轮候选：新增石板路面和院落地表两张真实生成纹理，在原有八块地块内绘制低对比材质，边缘使用局部遮罩过渡；原城墙采用连续压顶与细砌缝，不再画成棋盘格边框。道路中心线与原 12/7/3 米铺面宽度不变，不通过扩大通路或添加假地物制造街区密度。

默认导出与 `--map-version 1.1.0`、显式 `--map-version 1.1.1` 均使用 [冻结绘制快照](published/README.md)，验证各自原内容指纹后才写出；其他版本号拒绝猜测，不能把新美术静默标作旧版本。

新包需要安装并用于独立测试世界，不能覆盖旧安装的不可变 1.1.0 内容，也不会自动替换已有场景。标准图中的额外建筑、人物与装饰性街巷没有被当作真实游戏地物加入。
