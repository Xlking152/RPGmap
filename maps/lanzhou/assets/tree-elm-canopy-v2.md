# 榆树树冠美术素材 v2

- 生成日期：2026-10-17。
- 生成方式：内置 ImageGen，`transparent_background: true`；没有使用 CLI 或替代模型。
- 用途：原有城内可破坏树木与原有郊野树带的俯视树冠。没有新增地物、碰撞或视线遮挡声明。
- 文件：`tree-elm-canopy-v2.webp`，512 × 512，109,974 字节。
- SHA-256：`e57155528bb7e41074a6a0996c2b9139e6938e5dddb18ba442abc6018ce3dbda`。
- 原始图：1254 × 1254 RGBA。WebP 的 Alpha 最小值 0、最大值 255，86,714 个完全透明像素；不是烘焙棋盘格。
- 后处理：FFmpeg 等比缩至 512 × 512，`libwebp`、质量 84、压缩等级 6，保留原 Alpha；未覆盖任何旧素材。
- 运行参数：不透明度 0.97；基础饱和度 0.76、对比度 1.04，另有两档轻微色调变化。按原对象 ID 确定旋转角，固定在原足迹内裁切。素材位于原 `data-feature-id` 组内，继续随原树木破坏、恢复。

## 完整提示词

```text
Use case: stylized-concept. Production bitmap sprite for a historical top-down tactical map. A single mature northern Chinese elm tree canopy, seen in STRICT ORTHOGRAPHIC TOP-DOWN 90 degree view. Irregular rounded crown made of many naturally layered clusters of individually legible small leaves, visible branching only in a few interior gaps. Realistic modest tree, painterly ink-and-mineral watercolor plus very light woodcut grain, grounded semi-realistic map illustration. Muted olive green, sage highlights, deep neutral green interior, no golden tint. Strongly differentiated leaf clusters readable when reduced to 40 pixels. Tree fully contained in square composition with about 3 percent transparent safe margin; crown roughly circular but organically irregular, no trunk sticking out below. Soft ambient natural shading confined INSIDE leaves only. GENUINE RGBA TRANSPARENT BACKGROUND, alpha 0 outside tree silhouette and in foliage gaps. No ground, grass, rocks, buildings, objects, text, frame, cast shadow, white outline, glow or simulated checkerboard. Do not imitate a specific artist or game.
```
