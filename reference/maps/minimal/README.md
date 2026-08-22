# Minimal Reference MapPackage

这是 RPGmap 的最小参考地图，不追求美术效果，只用于验证 **MapPackage / Generic Feature UI / Core** 的边界。

包含：

- Base；
- Terrain；
- Liquid；
- Structure；
- Special；
- Destructible；
- Labels；
- `demo-house`：可检查、可进入、可破坏、阻挡 Navigation；
- `demo-door`：`category = door`，可检查、可打开/关闭，关闭阻挡而打开恢复通行；
- `demo-wall`：可破坏，并可通过局部破坏形成 Navigation 通道；
- `MINIMAL_FEATURE_TAXONOMY`：证明 UI 显示标签来自 MapPackage，而不是 Core 的地图类别表。

自动测试把这张地图交给与兰州城相同的 Feature Operations、Damage、Navigation 和 Feature State 逻辑。如果它在不引入兰州代码的情况下完成检查、进入、开关、破坏和通行变化，就说明这些行为属于 Core，而不是某一张地图。

制作新地图时可以直接从本目录复制并替换：地图尺寸、Layer Plan、Feature、Capability、taxonomy 和 SVG `data-feature-id`。
