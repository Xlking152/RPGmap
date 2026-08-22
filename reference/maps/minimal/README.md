# Minimal Reference MapPackage

这是 RPGmap 的最小参考地图，不追求美术效果，只用于验证 MapPackage 与 Core 的边界。

包含：

- Base；
- Terrain；
- Liquid；
- Special；
- Destructible；
- Labels；
- 一栋可进入、可破坏的 `demo-house`；
- 一堵可破坏的 `demo-wall`。

自动测试会把这个地图交给和兰州城相同的 `createDamagePreview / commitDamageEvent / deriveSceneState`，如果能正常得到 destroyed Scene State，就说明可破坏逻辑已经属于 Core，而不是兰州城。
