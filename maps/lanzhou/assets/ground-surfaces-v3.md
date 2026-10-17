# 第二轮街面与院落地表

2026-10-17 使用内置 ImageGen 分别生成两张不透明平面材质。没有使用 CLI 生图或外部下载。成品为独立 1.1.2 美术候选所用；已冻结 1.1.0、1.1.1 不引用这两张图片。

## 石板铺面完整提示词

```text
Use case: stylized-concept. Create a high quality seamless material swatch for a medieval Chinese city tactical map. ONLY the surface of a weathered historical stone-paved street. Strict 90-degree orthographic overhead. Small irregular rectangular and polygonal grey limestone slabs, a mix of broad worn flat stones and occasional narrower packing stones. Uneven old joints filled with grey-beige dust, naturally polished lighter centers, faint cool charcoal cracks, a little flat muted olive moss tucked in some joints. Subtle lateral foot-traffic wear but NO distinct road edges, paths, road stripes or tire marks. Refined ink and mineral watercolor map-art detail, semi-realistic grounded materials, no thick comic outlines, no modern uniform bricks. Palette neutral mid grey with soft warm ivory stone highlights and sparse muted sage; stay low-saturation with visible local contrast, not flat beige. Consistent diffuse ambient daylight, no cast shadows, perspective, vignette or dramatic light. Tileable seamless square with no framing, no text, no buildings, walls, furniture, objects, people, plants, tree silhouettes or fake chessboard background. Entire image is an opaque continuous paving material, for clipping inside existing road geometry. Do not imitate any artist or commercial game.
```

- ImageGen 源文件：`exec-4b4f8196-9a75-44ca-8d06-5c394cba7f84.png`，1254 × 1254。
- 成品：`street-stone-v3.webp`，512 × 512，82,742 字节。
- FFmpeg：Lanczos 缩放，`libwebp -quality 84 -compression_level 6`。
- SHA-256：`c5207c87c72e911882386fc2e1b1d600f315e215fea72baeb08c173a30fe27a3`。
- 道路使用 24 × 24 地图单位平铺；城墙同材质使用 40 × 40 平铺并以 0.66 不透明度叠在原城墙面内。铺面、路肩和城墙均不扩张几何。

## 院落地表完整提示词

```text
Use case: stylized-concept. A seamless top-down material texture for a historical Chinese city tactical map. Only a flat old courtyard earth surface with organically varied interlocking patches: pale compacted foot-scuffed grey earth, warmer dry dusty packed clay, darker damp grey-green soil, and sparse flat short moss. No raised vegetation. Low-saturation natural grey, subdued sage, muted olive, soft clay; avoid a uniformly beige field. Fine local grain and tiny grit, large gently transitioning irregular worn patches, restrained hand-painted ink-and-mineral watercolor game map detail. Orthographic 90 degree overhead, diffuse lighting, no cast shadows or center vignette. Seamless tileable edges and no recognizable repeating motifs. No roads, paths, stripes, footprints, buildings, walls, roof shapes, tree or bush silhouettes, stones larger than fine grit, grass tufts, objects, figures, text, emblems, frames. All features are flush surface material variation only, not obstacles. No imitation of any specific artist or commercial game.
```

- ImageGen 源文件：`exec-b16fa511-6eca-43a7-b3a8-36253ac6fbd8.png`，1536 × 1024。
- 成品：`courtyard-ground-v3.webp`，768 × 512，112,880 字节。
- FFmpeg：Lanczos 缩放，`libwebp -quality 82 -compression_level 6`。
- SHA-256：`4677ca71d7b4c6bd85397a577afce2bc6ef3f09b67a1daa72857e3f72922953b`。
- 使用 480 × 320 地图单位平铺，按原八块地块分别降低不透明度。原地块路径内以七级局部亮度遮罩淡出边缘，不使用全图模糊或更改地物形状。

## 验收边界

保留全部 Feature、导航、入口、LOS 和地图数据原始 receipt。实际 Chrome 截图覆盖北门、城中、州衙及 390px；检查材质加载、标签、控制台与页面溢出。新增纹理不能改变空旷地图本身的建筑数量或街巷密度，不将概念图中更密集的建筑布局声称为已实现。
