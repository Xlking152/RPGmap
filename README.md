# 北宋兰州 RPG 矢量地图

这是一个可离线运行的 RPG 战术地图项目。地图结构为 `6000 × 5000` 世界单位的原生 SVG，并以少量本地生成式 WebP 增强地表、水体和瓦砾质感；坐标统一采用左上角原点、Y 向下、`1 单位 = 1 米`。

当前应用版本：`1.1.0`；地图数据版本：`1.0.5`；存档格式版本：`SaveV2`。本仓库保留源码、测试、必要美术资产、历史参考与开发文档；`node_modules/`、`dist/`、Playwright 输出和最终运行包不纳入 Git，由依赖安装与构建流程按需生成。版本更新记录见根目录 `CHANGELOG.md`。

## 直接使用

执行 `npm run build` 后，开发构建产物位于：

- `dist/index.html`

该文件会内联 JavaScript、CSS、Leaflet、地图 SVG 与 29 项生成式美术 WebP。`dist/` 作为可重复生成的构建产物不进入 Git；发布时可将 `dist/index.html` 复制并重命名为独立运行的地图 HTML，使用者无需服务器、CDN、Node.js 或网络连接。

当前通用工具包括：标记改名/改色/拖动、框选批量删除、一键清空标记、地物检查与精确恢复、建筑详情、圆形头像角色、道路优先移动、进出建筑、两点与路线测距、三种攻击范围、临河弹坑积水、存档导入导出，以及带事件回溯的场景破坏。框选和清空只处理玩家标记，不删除角色、攻击范围或已经应用的场景破坏记录。

1.0.6 将应用界面统一为砖红执行色、河青选择色和冷灰中性色；顶部工具使用本地内联 Lucide 图标，右侧面板改为分隔式信息层级。桌面保持单行工具栏，窄屏和手机宽度使用可横向滚动的工具带，地图与面板上下排列。

1.0.7 增加州衙大殿和州城隍神祠两项俯视生成式地标素材。州衙正堂与后堂仍是两个独立 Feature，神祠仍是一个完整院落 Feature；位图只负责表面表现，并跟随各自 SVG 图组参与局部破坏、整毁、撤销和重放。

1.0.8 增加州城门楼和金城关关楼两项俯视生成式素材。四座州城门复用同一门楼皮肤，金城关使用更厚重的关隘门楼皮肤；五个实例都留在各自独立 Feature 内，门洞方向随原足迹旋转并保持道路贯通。

1.0.9 完成剩余高价值地标美术：黄河浮桥、市易务正厅、市易务货栈和四座州城角楼。角楼新增为四个独立墙体 Feature，浮桥与市易务建筑沿用原足迹；七个实例均跟随各自图组参与破坏、撤销和重放。

1.0.10 重新生成黄河浮桥皮肤：桥面收窄，低矮浮舟藏于桥板下方并只露出短船艏，绑扎与舟距增加不规则变化；地图渲染宽度由 210 收到 132 世界单位，原中心线、碰撞足迹、破坏行为和地图数据版本保持不变。

1.0.11 增加总览、中景、近景三档地图信息层级和按优先级自动避让标签；生成式地标统一降饱和、提明度并与 SVG 底衬共同呈现；整毁建筑增加梁木瓦片，浮桥改为两端残桥与漂散舟体，城墙局部破坏改为锯齿缺口与散石。新增“检查地物”工具、运行时选择轮廓、完整/局部破坏/整毁状态、精确恢复、场景记录对象摘要与定位高亮，以及破坏预览具体目标列表。

1.0.12 使用 18 个透明 ImageGen 变体覆盖剩余 50 栋普通建筑，包括州衙仪门/廊房、营房、仓廪、马厩、工坊、市肆、普通民居和院落民居。生产包按 Feature ID 稳定分配素材，位图透明度为 0.62、SVG 屋体底衬为 0.42；台基、阴影、足迹、命中、破坏、SaveV1 和地图数据版本保持不变。

1.0.13 全量重生成 18 个普通建筑变体，统一为约 80 度近正交高俯视，并按九类实际足迹比例透明补边；渲染改为 `xMidYMid meet`，不再拉伸位图。普通建筑 SVG 底衬降至 0.24，台基、阴影和重复矢量细节同步减重；州衙与市易务增加克制的台基层级。建筑局部破坏由规则圆斑改为稳定的 14 点深色不规则缺口，并增加足迹内梁木与瓦片碎片。地图坐标、命中几何、地图数据版本和 SaveV1 保持不变。

1.1.0 新增显式弹坑与临河积水：弹坑和河流相交时直接进水，12 米内可生成 6 米宽入水沟，完整建筑与城墙会阻断连通，接触的弹坑可继续传播。55 栋建筑增加用途、构造、说明和入口资料，其中 54 栋可进入。新增独立角色系统，支持 128×128 WebP 圆形头像、10 米 A* 道路优先寻路、移动动画、建筑内部名单和整毁疏散；存档升级到 SaveV2，并自动迁移 SaveV1。

## 开发与验证

需要 Node.js `^20.19.0` 或 `>=22.12.0`。Windows 下建议使用：

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd test
npm.cmd run build
```

项目结构：

- `src/app/storage.js`：浏览器存档读取、迁移备份、延迟写入和失败熔断。
- `src/assets/generated/`：本地黄土、黄河、透明瓦砾和地标建筑美术资产及生成记录。
- `src/engine/app.js`：通用 RPG 地图应用、工具切换和交互编排。
- `src/engine/feature-selection.js`：地物命中排序、事件对象归并、破坏状态和对象边界计算。
- `src/engine/geometry.js`：坐标、距离、吸附、圆/扇形/矩形和命中计算。
- `src/engine/navigation.js`：10 米导航网格、道路代价、动态障碍和 EasyStar A* 寻路。
- `src/engine/state.js`：SaveV2 校验、SaveV1 迁移、弹坑积水推导和场景操作记录管理。
- `src/maps/lanzhou.js`：北宋兰州独立地图包、SVG 与可破坏对象。
- `src/render/scene-renderer.js`：废墟、裁切损伤、弹坑与液体倒灌 SVG 渲染。
- `src/render/map-presentation.js`：缩放信息层级、标签优先级和屏幕空间自动避让。
- `tests/`：几何、状态、持久化、地图包和安全边界测试。

## 通用地图包接口

新地图只需要提供独立 `MapPackage`，无需复制标记、测距或破坏逻辑：

```js
const mapPackage = {
  id: 'unique-map-id',
  title: '地图名称',
  version: '1.0.0',
  width: 6000,
  height: 5000,
  metersPerUnit: 1,
  initialView: [minX, minY, maxX, maxY],
  layers: ['base', 'liquid', 'destructible', 'damage', 'flood', 'labels'],
  destructibleCategories: ['building', 'wall', 'vegetation', 'bridge', 'terrain'],
  features: [],
  liquidBodies: [{ id: 'river', polygon: [[0, 0], ...] }],
  roadRules: {
    widthsMeters: { major: 12, secondary: 7, alley: 3, country: 8 },
    setbacksMeters: { building: 3, streetShop: 1.5 }
  },
  roadBuffers: [],
  navigation: {
    cellSizeMeters: 10,
    roads: [{ id: 'road-1', kind: 'major', points: [[x1, y1], [x2, y2]] }],
    gateways: [{ id: 'gate-1', polygon: [[x1, y1], ...] }],
    bridgeFeatureIds: ['bridge-1']
  },
  floodRules: {
    maxInflowGapMeters: 12,
    inletWidthMeters: 6,
    propagationGapMeters: 1
  },
  sources: [],
  createSvg() { return '<svg viewBox="0 0 6000 5000">...</svg>'; }
};
```

坐标转换固定为：

```js
worldToLatLng({ x, y }, height) => ({ lat: height - y, lng: x })
latLngToWorld({ lat, lng }, height) => ({ x: lng, y: height - lat })
```

`features` 为空时，场景破坏功能自动不可用；标记、两点测距、路线测距和范围显示仍可正常使用。

`liquidBodies` 和 `floodRules` 为可选元数据。旧式岸边破坏仍按破坏多边形与水体超过 1% 重合判定；显式弹坑可在 12 米内寻找不穿过完整建筑或城墙的最短连接，生成入水沟和坑内积水。`deriveFloodRegions()` 返回水源、区域类型与多边形，`deriveFloodPolygons()` 保留为兼容包装。地图未声明液体体时该功能自动关闭。

`navigation` 公开道路中心线、城门通道和桥梁 Feature。运行时以 10 米网格构建静态地形，再叠加墙体破坏、桥梁缺口、弹坑与积水等动态障碍；道路代价为 1.0，普通地面为 1.7。

`roadBuffers` 用于构建期碰撞验收。普通建筑不得进入道路宽度加 3 米退界形成的缓冲区；只有显式标记为 `roadOverlapAllowed` 的城门、跨街设施或桥梁可以例外。

## 可破坏对象

每个对象需要稳定 ID、统一类别、碰撞多边形和 SVG 图组：

```js
{
  id: 'building-001',
  name: '一号仓廪',
  category: 'building',
  subtype: 'granary',
  importance: 'secondary',
  mode: 'object',
  minCoverage: 0.25,
  details: {
    use: '储存官粮与军粮。',
    structure: '夯土墙木构仓房。',
    description: '游戏复原说明。'
  },
  enterable: true,
  entrance: [x, y],
  center: [x, y],
  geometry: { type: 'polygon', points: [[x1, y1], [x2, y2], [x3, y3]] }
}
```

- `object`：攻击范围罩住对象足迹达到 95% 以上时整对象被毁；未达到 95% 时只局部破坏被覆盖的部分。
- `clip`：按攻击几何裁切，用于城墙、城门、关墙和连续地表，永远只局部破坏。
- `severeOnly: true`：仅当攻击范围开启“严重破坏”时才参与命中；用于基础地表（`ground-terrain`）等不可见但可被弹坑覆盖的对象。
- 道路、水体、文字和坐标层默认不进入可破坏类别。
- `name` 是地物检查面板使用的公开名称；`importance` 为 `primary`、`secondary` 或 `detail`，用于重叠命中排序和地图信息层级。
- 源 SVG 不被永久删除；运行时根据当前场景记录生成隐藏、遮罩、瓦砾和弹坑。

## 存档

标记、角色、攻击范围、当前场景操作记录和用户设置会自动保存，也可导入导出版本化 JSON。角色头像保存为 128×128 WebP Data URL，单张不超过 96 KB、总量不超过 3 MB。破坏与指定恢复会写入场景记录；“撤销”直接删除最后一条记录并回退一步，不另写撤销记录；“重置场景”会清空全部场景记录和破坏结果，且不能再通过场景撤销恢复。导入会校验地图 ID、地图版本、对象引用、坐标、尺寸、颜色、集合规模和数值边界，文件上限为 5 MB。SaveV1 与地图 `1.0.0–1.0.4` 会自动迁移到 SaveV2 / `1.0.5`；浏览器自动存档迁移前会先保留原始备份，备份失败时暂停自动保存。

两点测量、路线测量、当前地物选择、角色移动预览和记录高亮都属于临时状态，不写入 SaveV2。确认角色移动时直接保存最终位置，刷新不会留下半途状态。

## 历史复原说明

当前地图以 1104 年后的兰州城为主体，并融合旧南城遗迹、金城关、浮桥和再利用区。州衙东北侧新增了独立的“州城隍神祠〔位置推定〕”院落：依据后世地方志提供的相对方位约束，以 B 级“合理推定”标注，并替换原地低可信度店铺，避免建筑重复。地图属于“史料约束下的游戏复原”：游戏坐标与工具测距精确，但具体街巷、院落和建筑位置不是考古测绘结论。
