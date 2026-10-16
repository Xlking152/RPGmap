# 生成式美术资产

本目录中的 WebP 是地图运行时实际使用的本地资产。它们由内置 ImageGen 生成，再经过尺寸、透明度和体积处理；构建时由 Vite 内联到最终单页，不产生网络请求。

## 文件

- `loess-terrain.webp`：`768 × 768`，低对比黄土与夯土地表纹理，约 65 KB。
- `yellow-river.webp`：`768 × 768`，低对比矿物色黄河流纹，约 39 KB。
- `rubble-atlas.webp`：`1536 × 1024`，3 × 2 透明瓦砾图集，约 260 KB。
- `yamen-hall.webp`：`1024 × 434`，透明州衙大殿俯视皮肤，约 93 KB。
- `chenghuang-temple.webp`：`660 × 1024`，透明州城隍神祠整院落俯视皮肤，约 163 KB。
- `city-gatehouse.webp`：`846 × 1024`，透明州城门楼俯视皮肤，约 186 KB。
- `jincheng-gatehouse.webp`：`1024 × 954`，透明金城关关楼俯视皮肤，约 221 KB。
- `city-wall-tower.webp`：`1007 × 964`，透明州城角楼俯视皮肤，约 230 KB。
- `yellow-river-pontoon.webp`：`159 × 1024`，透明黄河浮桥俯视皮肤，约 65 KB。
- `market-office-hall.webp`：`1024 × 609`，透明市易务正厅俯视皮肤，约 117 KB。
- `market-storehouse.webp`：`1024 × 366`，透明市易务货栈俯视皮肤，约 109 KB。

### 1.0.13 普通建筑变体

| 素材组 | 文件 | 成品尺寸 | 字节数 |
| --- | --- | ---: | ---: |
| 州衙仪门 | `yamen-gate.webp` | `768 × 312` | 52,448 |
| 州衙廊房 | `yamen-side-hall.webp` | `768 × 262` | 43,960 |
| 军营营房 | `barracks-01.webp` / `barracks-02.webp` | `768 × 220` / `768 × 220` | 47,280 / 47,260 |
| 仓廪 | `granary-01.webp` / `granary-02.webp` | `768 × 308` / `768 × 308` | 55,500 / 61,382 |
| 马厩 | `stable-01.webp` / `stable-02.webp` | `768 × 238` / `768 × 238` | 51,552 / 44,790 |
| 军需工坊 | `workshop-01.webp` / `workshop-02.webp` | `768 × 314` / `768 × 314` | 65,318 / 68,888 |
| 沿街市肆 | `market-shop-01.webp` / `02` / `03` | `768 × 384` / `768 × 384` / `768 × 384` | 74,410 / 75,824 / 68,980 |
| 普通民居 | `residence-house-01.webp` / `02` / `03` | `768 × 384` / `768 × 384` / `768 × 384` | 82,730 / 68,150 / 74,080 |
| 院落民居 | `residence-courtyard-01.webp` / `02` | `768 × 384` / `768 × 384` | 84,708 / 69,740 |

18 张合计 `1,137,000` 字节，单张最大 `84,708` 字节。全部为 `yuva420p` Alpha WebP，最长边 768px；画布按九类地图足迹比例透明补边，主体没有被非等比拉伸。

## 生成提示词摘要

### 黄土地表

`stylized-concept`；俯视、正交、无缝平铺的北宋边城黄土和院落夯土地表；矿物颜料淡彩与轻微木刻颗粒；低对比、无建筑、无道路、无大石、无文字、无阴影。

### 瓦砾图集

`stylized-concept`；六组北宋木构与夯土建筑瓦砾，3 × 2 排列；断木、灰瓦、红瓦、夯土块和少量焦痕；正交俯视、无阴影、无烟火、无文字。原图使用纯绿色背景，并通过官方 `remove_chroma_key.py` 转为透明图集。

### 黄河流纹

`stylized-concept`；正交俯视、可平铺的含沙河水表面；矿物蓝灰、灰青和少量泥沙色，只有低对比水平流纹；无岸线、船只、桥梁、浪花、文字或强高光。

### 州衙大殿

`stylized-concept`；北宋边州官衙单体大殿，约 2.6:1 横向足迹；严格正交俯视、灰黑瓦歇山顶、夯土台基、深色木构和少量砖红官式装饰；无院墙、人物、旗帜或文字。原图使用纯绿色背景，经官方色键工具、1px 边缘收缩和最大连续主体清理转为透明 WebP。

### 州城隍神祠

`stylized-concept`；南门朝下的紧凑北宋边城神祠院落，包含北部小房、正殿、东西廊房、中央香炉和分列式南门；严格正交俯视、灰绿瓦顶、红褐院墙与低饱和矿物淡彩。原图按与州衙相同的透明边缘流程处理。

### 州城门楼

`stylized-concept`；北宋边城近方形城门，严格正交俯视，中轴为从上到下连续贯通的深色门洞；两侧夯土城台、灰绿瓦顶、深色木构和少量砖红装饰；无长城墙、人物、旗帜、文字或投影。原图使用纯绿色背景，经官方色键工具、1px 边缘收缩和最大连续主体清理转为透明 WebP。

### 金城关关楼

`stylized-concept`；北宋西北关隘的宽体门楼，严格正交俯视，中轴保留连续通行孔；石砌与夯土城台、较厚重的灰绿屋顶和深色木构；无长城墙、院落、人物、文字或投影。透明边缘沿用州衙与州城门楼的处理流程。

### 州城角楼

`stylized-concept`；北宋边城近方形防御角楼，严格正交俯视；夯土与石砌墩台、深色木构上层、灰绿四坡瓦顶和克制砖红细节；无相连城墙、城门、道路、旗帜或文字。四角使用同一对称皮肤，由各自 Feature 控制破坏。

### 黄河浮桥

`stylized-concept`；北宋黄河木船浮桥，约十三艘低矮木质浮舟藏于连续横板桥面下，只露出短船艏，并用木栏、粗麻绳和不规则绑扎连接；严格正交俯视、约 1:6.4 的窄长主体、轻微线位偏转；无河水、河岸、人物、车辆或文字。成品沿原浮桥中心旋转，渲染宽度收至 132 世界单位，启用位图时隐藏 SVG 桥体底衬。

### 市易务正厅与货栈

`stylized-concept`；正厅为灰绿瓦四坡顶、夯土台基与克制官式砖红装饰，货栈为灰褐瓦顶、抬高基础与重木门的实用仓储建筑；均为严格正交俯视的独立横向单体，无院墙、人物、招牌或文字。

## 1.0.12 普通建筑完整生成记录

最终 18 张素材均由内置 ImageGen 单张生成。普通民居、营房和市肆先作为风格锚点；后续带参考图生成的首批 15 张文件被检测为 `rgb24`，透明棋盘格已经烘入像素，因此全部废弃。最终入库版本不附参考图，改为把公共风格直接写入提示词，并逐张验证 `rgba` 源文件和 Alpha 包围盒。

每张最终提示词由下列“公共提示词”与对应“主体子句”直接拼接：

```text
Use case: stylized-concept. Create one production-ready transparent bitmap sprite for an offline historical RPG map.

Exact shared art direction: Northern Song northwestern frontier construction; low-saturation mineral-watercolor wash; very light traditional woodcut grain; restrained thin dark linework; weathered gray-green or gray-brown tile; pale dusty rammed-earth walls; dark aged timber; realistic modest proportions. Clear at small map scale. Strict near-orthographic top-down map view with roof dominant and no horizon. Long axis exactly horizontal; the functional entrance, gate, or open frontage faces bottom. Keep every structural part and prop inside one compact footprint. Center tightly with about 3% safety padding.

CRITICAL OUTPUT REQUIREMENT: encode a real RGBA transparency channel. Every pixel outside the isolated asset must have alpha 0. Never paint or simulate a checkerboard. Do not create a white, gray, black, colored, or gradient background. No surrounding ground, road, cast shadow, ambient halo, white fringe, or edge glow.

Never include people, animals, flags, banners, readable signs, text, symbols, vegetation, outside clutter, modern structures, Qing decoration, exaggerated flying eaves, active flame, glowing fire, or smoke. Do not imitate a specific artist or commercial game.
```

主体子句如下；同组不同变体均单独调用 ImageGen：

- `yamen-gate.webp`：`SUBJECT: State yamen ceremonial instrument gate, about 2.7:1 horizontal footprint. Symmetrical gray-green tiled roof over two solid side bays with a clearly readable central roofed passage aligned to the bottom entrance. Slightly more formal dark timber joinery than a residence, but no imperial yellow and no palace ornament.`
- `yamen-side-hall.webp`：`SUBJECT: State yamen east/west side hall, one long modest administrative office range, about 3.2:1 horizontal footprint. Continuous gray-green tiled roof, five restrained timber bays, pale rammed-earth infill, narrow bottom-facing veranda and entrances. Orderly but subordinate to the main hall.`
- `barracks-01.webp`：`SUBJECT: A single austere Northern Song frontier military barracks, about 3.4:1 horizontal footprint. Weathered gray-green tiled roof, repeated structural bays, pale rammed-earth lower walls, dark timber posts and one plain centered bottom entrance.`
- `barracks-02.webp`：`SUBJECT: A second long troop-quarters range, about 3.5:1 horizontal footprint. Patched dark gray-brown roof, six repeated structural bays, pale rammed-earth wall and a simple offset bottom doorway. Keep it distinct from a generic residence.`
- `granary-01.webp`：`SUBJECT: Frontier government grain granary, one broad sealed warehouse, about 2.8:1 horizontal footprint. Heavy gray-brown tiled roof, raised dry stone and timber foundation visible at bottom, thick pale earth walls, three small bottom-facing storage access bays, minimal windows and robust moisture-resistant construction.`
- `granary-02.webp`：`SUBJECT: A second compact long frontier granary, about 3:1 horizontal footprint. Muted gray-green patched roof, raised sill and paired bottom-facing storage doors, thick earth walls and strong dark crossbeams. Use a different roof rhythm and doorway layout from variant one.`
- `stable-01.webp`：`SUBJECT: Military stable, about 2.5:1 horizontal footprint. A simple gray-brown tiled roof shed covers the upper two-thirds. The lower third is an open footprint-contained frontage with three clearly readable empty bays, dark timber stall partitions, low rails and a compact feed rack. No horses, carts, tack or hay outside.`
- `stable-02.webp`：`SUBJECT: A second military stable, about 2.7:1 horizontal footprint. Muted gray-green lean-to roof over the upper half; the lower half contains four empty timber-separated stalls inside a low enclosing sill with an offset bottom entry. Patched and utilitarian, with a different partition rhythm from variant one. No horses or carts.`
- `workshop-01.webp`：`SUBJECT: Frontier military supply workshop, about 2.4:1 horizontal footprint. Gray-brown tiled roof covers the left and upper bays; a compact open work area remains inside the lower-right footprint. Include one cold masonry hearth with no flame, glow or smoke, one timber workbench and a restrained tool rack, all inside the boundary.`
- `workshop-02.webp`：`SUBJECT: A second frontier supply workshop, about 2.6:1 horizontal footprint. Patched gray-green roofed shed along the upper side; the lower frontage contains an enclosed work apron, one cold brick furnace, a low anvil block and a timber bench. Use a different bay arrangement from variant one and place nothing outside.`
- `market-shop-01.webp`：`SUBJECT: A single small street-facing market shop, about 2.2:1 horizontal footprint. Gray-brown tiled roof, pale rammed-earth walls, dark timber shopfront, shallow eave and a restrained low-saturation brick-red cloth awning along the bottom-facing entrance. No merchandise outside and no sign.`
- `market-shop-02.webp`：`SUBJECT: A second street-facing market shop, about 2.1:1 horizontal footprint. Weathered gray-green roof, pale earth walls, dark timber shopfront and a shallow bottom-facing eave with a muted ochre cloth awning split into three plain panels. No merchandise outside and no written sign.`
- `market-shop-03.webp`：`SUBJECT: A third street-facing market shop, about 2.3:1 horizontal footprint. Patched gray-brown roof, pale earth side walls, asymmetrical dark timber shopfront and a narrow shallow bottom-facing awning in muted dusty blue-gray cloth. No merchandise outside and no sign.`
- `residence-house-01.webp`：`SUBJECT: A compact low-status two-bay civilian residence, about 2:1 horizontal footprint. Gray-brown weathered tile roof, patched pale rammed-earth walls, restrained dark timber frame and one small centered bottom entrance. No courtyard.`
- `residence-house-02.webp`：`SUBJECT: A second modest two-bay civilian residence, about 2.1:1 horizontal footprint. Muted gray-green roof with restrained repair patches, pale cracked rammed-earth walls, sparse dark timber frame, a small off-center bottom entrance and one narrow lattice opening. No courtyard.`
- `residence-house-03.webp`：`SUBJECT: A third compact low three-bay civilian residence, about 2.5:1 horizontal footprint. Weathered gray-brown roof with a simple straight ridge, warmer dusty earth walls, dark timber posts, centered double-leaf bottom entrance and two tiny lattice openings. Plain, no courtyard.`
- `residence-courtyard-01.webp`：`SUBJECT: Compact civilian courtyard residence in a 1.7:1 horizontal compound footprint. Clear U-shaped layout: modest gray-brown tiled main house across the top, two very short side wings, a small pale enclosed earthen courtyard, a low front wall and one bottom gate. All compound floor and architecture remain tightly inside the footprint, transparent outside.`
- `residence-courtyard-02.webp`：`SUBJECT: A second compact civilian courtyard residence in a 1.8:1 horizontal compound footprint. Clear L-shaped layout: gray-green tiled main house along the top, shorter right side wing, small pale inner yard, low remaining boundary wall and an offset bottom gate. Distinct from the U-shaped variant, transparent outside the compound.`

### 技术处理参数

- 源文件：ImageGen 输出的 RGBA PNG；用 `ffprobe` 验证 `pix_fmt=rgba`，再用 FFmpeg `alphaextract,bbox=min_val=2` 取得有效 Alpha 包围盒。
- 裁切：在有效包围盒外保留约 3% 安全边距，禁止通过色键或背景抠除修补不合格源图。
- 缩放：Lanczos，最长边固定 768px，保持原始宽高比。
- 编码：FFmpeg `libwebp`、`compression_level=6`、`pix_fmt=yuva420p`。首轮 `quality=82` 会使内联单页达到 4,380,420 字节并超过 4.2MB 上限，因此最终 16 张使用 `quality=78`，两个复杂院落分别使用 `quality=68` 与 `quality=66`；成品单页降至 4,110,208 字节。
- 质量门槛：每张小于 90 KiB，总量小于 1.5MB；必须有真实 Alpha、无白边、无假棋盘格、无背景投影。

## 1.0.13 视角统一与比例校准记录

1.0.13 对上述 18 张普通建筑素材全部重新调用内置 ImageGen。公共提示词固定为：北宋西北边城、约 80 度近正交高俯视、屋顶占主体、长轴水平、南侧入口朝下、灰绿或灰褐瓦、夯土墙、深色木构、低饱和矿物淡彩与轻微木刻颗粒；输出必须是真实 RGBA，物体外 Alpha 为 0，禁止投影、地面、光晕、棋盘格、人物、文字、旗帜、道路、植被、烟火、现代构件、清代装饰和夸张飞檐。

各资产单独生成，主体约束如下：

- `yamen-gate.webp`：横向州衙仪门，双侧实墙与中轴门洞，官式但不宫殿化。
- `yamen-side-hall.webp`：五开间长廊房，连续灰绿瓦顶，秩序感强但从属于正堂。
- `barracks-01.webp` / `02`：六开间营房，重复结构节奏；第二张增加克制的修补瓦面。
- `granary-01.webp` / `02`：封闭仓廪，抬高基础、厚墙、少窗与重木门，两张使用不同门和屋脊节奏。
- `stable-01.webp` / `02`：屋棚与空马厩分隔栏清晰可见，不含马匹、草堆或界外杂物。
- `workshop-01.webp` / `02`：屋棚加足迹内工作区，保留冷炉台、工作台和工具区，不出现明火与烟雾。
- `market-shop-01.webp` / `02` / `03`：两开间沿街市肆，分别使用砖红、土黄和蓝灰低饱和布棚，不含招牌与外摆货物。
- `residence-house-01.webp` / `02` / `03`：两至三开间普通民居，以门窗位置、瓦面修补和屋顶组合形成差异，不带院落。
- `residence-courtyard-01.webp` / `02`：紧凑宽体 U/L 形院落，小院、短侧翼和朝南入口可辨，院外完全透明。

技术处理统一使用 `ffprobe` 验证 `pix_fmt=rgba`，FFmpeg `alphaextract,cropdetect` 测量有效边界，在主体外保留约 3% 安全边距，再按各组实际 Feature 宽高比增加透明补边。最终使用 Lanczos 缩放至最长边 768px，以 `libwebp`、`quality=78`、`compression_level=6` 和 `yuva420p` 编码。素材在浅色 `#f2ead9` 与深色 `#24272b` 背景联系表上分别检查，确认无白边、彩边、暗底光晕、伪棋盘格和主体裁切。

淘汰记录：市肆第三变体先后淘汰一张红黄色边缘污染图、一张烘入棋盘格的 `rgb24` 图和一张白底 `rgb24` 图；第一张院落民居因有效主体只有 `1.43:1`、无法无损填入约 `2:1` 足迹而重生成。所有不合格候选均未进入生产目录。

## 使用边界

- 纹理只作为 SVG 表面填充，不参与坐标、命中或破坏判定；生产 SVG 会统一降低地标位图的饱和与对比、提高明度，并保留低透明度矢量底衬。
- 瓦砾贴花只用于整毁建筑，按 Feature ID 稳定选择六种变体，并裁切在建筑足迹内。
- 州衙大殿素材分别放在正堂与后堂 Feature 内；神祠素材放在神祠院落 Feature 内，不能提升到基底层或跨 Feature 共用一个不可破坏图组。
- 四座州城门分别在自身 Feature 内渲染同一门楼素材；金城关关楼素材只位于 `jincheng-gatehouse` Feature 内。素材随原足迹旋转，不能覆盖独立的城墙或关墙图组。
- 四座角楼分别位于 `city-wall-tower-*` Feature 内，并保持墙体类别的局部破坏规则；浮桥素材只位于 `yellow-river-pontoon-bridge` Feature 内。
- 市易务正厅与货栈各自使用独立素材和 Feature，不合并为一个不可单独破坏的院落图组。
- 50 栋普通建筑各自在自己的 Feature 图组内插入一个 `generated-building-art` 节点；按 `category + renderType` 选择九组素材，再按 Feature ID 的 FNV-1a 哈希稳定选择变体。生成图层透明度为 0.62，普通建筑 SVG 屋体底衬为 0.24，并使用 `xMidYMid meet` 保持素材比例；台基和阴影继续存在但降低视觉权重。
- 默认导出的 `lanzhouMapPackage` 仍不包含栅格资源；生产入口通过 `createLanzhouMapPackage()` 显式注入资产。
- 不直接修改构建产物或把生成图片放到在线地址。
