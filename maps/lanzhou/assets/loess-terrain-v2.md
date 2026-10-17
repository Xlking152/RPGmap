# 中性土石地表 v2

- 生成日期：2026-10-17，使用内置 ImageGen，非透明材质。
- 文件：`loess-terrain-v2.webp`，768 × 768，190,740 字节。通过 `loessTerrainUrl` 接入正式地图；旧 `loess-terrain.webp` 不覆盖、不删除。
- SHA-256：`8aa9644d5508b96675e4fb851f9f015115c74858227b5d84128cd46436247d8e`。
- FFmpeg 后处理：等比缩放至 768 × 768，`libwebp`、质量 82、压缩等级 6。
- 纹理只描绘土石微表面，不含假建筑、道路、树木等带游戏语义的物体。
- 在地图上按 256 × 256 世界单位平铺，轻度去饱和，叠加于底色和原有功能地块；台基与道路仍单独绘制。
- 地表画面为美术示意，不是新的困难地形或障碍。

## 完整提示词

```text
Use case: stylized-concept. Create a seamless tileable ground material texture for a strictly top-down historical tactical map. The entire square image is only fine compacted grey-beige earth with tiny irregular weathered grey stones, soft sage mineral flecks, gentle worn foot-scuffed patches and subtle uneven soil grain. Quiet desaturated cool neutral ground, not yellow parchment or brown mud. Match a detailed hand-painted Northern Song city map with restrained ink line detail and mineral watercolor, but NO illustrative objects. Fine natural surface detail clearly readable at 768 pixels while the large-scale color remains even. Perfect orthographic 90 degree overhead material scan, no perspective and no horizon. Diffuse ambient lighting with no directional cast shadow or center spotlight. Seamless edges, nondirectional randomized texture, no grids or regular dots, no visible repeated motifs. Absolutely no buildings, roofs, streets, walkways, walls, grass tufts, trees, leaves, bushes, large rocks, cobblestone paving pattern, water, characters, words, frames or symbols. This is an unobtrusive soil MATERIAL only, to sit under separately rendered accurate gameplay geometry. No artist or commercial game imitation.
```
