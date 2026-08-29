# RPGmap MapPackage / Reference Map 规范

本目录保存 **地图源码参考包**。它不是 `world` 数据目录，也不是运行时由 Server 扫描的外部 `maps/` 目录。

当前设计原则：

```text
MapPackage 源码（reference/）
        ↓ Vite build
app/ 动态 chunk + assets
        ↓ World/Scene 选择后加载
Map Runtime
        ↓
Browser
```

因此，打包完成后的 `app/` 是完整可运行客户端；`reference/` 只是给开发者、地图作者和后续维护使用的源码/规范参考。正式 ZIP 不复制 raw `reference/`，兰州代码和素材只以编译 chunk/assets 存在。

---

## 1. 四层职责

### MapPackage：世界“是什么”

地图包只描述地图内容：

- 地图尺寸与坐标系；
- 基底、地面、液体、特殊表现、可破坏对象、标签；
- Feature 的几何、名称、类别、子类型、素材；
- `featureTaxonomy` 中地图自己的类别/子类型/详情字段显示名；
- Navigation 数据；
- Liquid 数据；
- Feature 是否可检查、进入、破坏、开关等 Capability 声明。

地图包 **不实现** 玩家点击、攻击结算、破坏状态机、多人同步、权限、存档或操作按钮回调。

### RPGmap Core：世界“如何运行”

通用逻辑位于 `src/`：

- Selection / Inspect；
- Feature Operations / Feature State；
- Movement / Navigation；
- Damage / Restore / Undo；
- Scene State；
- Actor / Health / Combat；
- Multiplayer / Ownership；
- Rendering / Generic Feature UI。

Core 不应该出现 `if (map === lanzhou)`，也不应该为了支持一张新地图而新增 `if (feature.category === '某地图类型')` 的操作规则。

### Scene Instance：这一张地图“现在怎样”

以后 Scene Manager 落地后，同一个 MapPackage 可以实例化为多个 Scene。破坏、角色位置、开关状态等都属于 Scene Instance，而不是写回 MapPackage。

### World：这一场 Campaign“发生了什么”

World 保存 Scene Instance、Users、Actors、Combat、Chat 等运行状态。MapPackage 本身应保持只读模板语义。

---

## 2. Reference Map 目录样式

推荐每张源码地图采用：

```text
reference/maps/my-map/
├─ manifest.js       # id / 版本 / 逻辑 Layer Plan / 可选 Feature taxonomy
├─ package.js        # 地图几何、Feature、SVG 生成等地图专属内容
├─ assets.js         # 素材绑定；只有需要图片素材时才需要
├─ presentation.js   # 可选；地图专属展示清理
├─ assets/           # 图片等静态资源
├─ index.js          # 组装并导出 MapPackage
└─ README.md         # 地图作者说明
```

`lanzhou/` 是完整复杂参考；`minimal/` 是最小可运行/测试参考。

---

## 3. 标准逻辑 Layer

RPGmap MapPackage API V1 约定以下语义角色：

```text
base          基础背景
terrain       地面 / 山体 / 道路地表
liquid        河流 / 湖泊 / 水域
structure     建筑 / 城墙 / 桥梁等结构（可选独立层）
special       火焰 / 洪水 / 毒区 / Damage Overlay 等特殊表现
destructible  可被破坏系统索引的 Feature 表现
labels        地名 / 标注 / 文字
```

物理 SVG Layer 与逻辑 Layer 不必一一相同，可以通过 `layerPlan.sourceLayers` 做映射。

兰州城目前已经给 `terrain / ruins / roads / parcels / vegetation` 等物理子层设置独立 `data-layer` 标签；出于历史 SVG 结构兼容，这些子层仍嵌套在 `base` 父层中。逻辑 `terrain` 通过 Layer Plan 映射这些物理子层，Core 不依赖它们在 SVG 中的具体嵌套方式。

示例：

```js
export const MY_LAYER_PLAN = [
  { id: 'base', role: 'base', sourceLayers: ['base'] },
  { id: 'terrain', role: 'terrain', sourceLayers: ['terrain', 'roads'] },
  { id: 'liquid', role: 'liquid', sourceLayers: ['liquid'] },
  { id: 'structure', role: 'structure', sourceLayers: ['structure'] },
  { id: 'special', role: 'special', sourceLayers: ['effects', 'damage'] },
  { id: 'destructible', role: 'destructible', sourceLayers: ['destructible'] },
  { id: 'labels', role: 'labels', sourceLayers: ['labels'] },
];
```

---

## 4. Feature + Capability + Taxonomy

地图对象统一视为 Feature。Feature 描述自身，不编写游戏规则：

```js
{
  id: 'portal-001',
  name: '传送门 A',
  category: 'mechanism',
  subtype: 'portal',
  geometry: {
    type: 'polygon',
    points: [[100,100], [300,100], [300,260], [100,260]],
  },
  center: [200,180],
  entrance: [200,260],
  capabilities: {
    inspectable: true,
    interactive: true,
    enterable: true,
    openable: true,
    actions: {
      inspect: true,
      enter: true,
      exit: true,
      open: true,
      close: true,
    },
  },
}
```

`src/map-package/contract.js` 会统一归一成：

```text
feature.capabilities.inspectable
feature.capabilities.interactive
feature.capabilities.enterable
feature.capabilities.destructible
feature.capabilities.openable
feature.capabilities.actions.*
feature.capabilities.navigation
```

地图自己的显示词汇放在 MapPackage：

```js
featureTaxonomy: {
  categories: {
    mechanism: '机关',
  },
  subtypes: {
    portal: '传送门',
  },
  detailFields: {
    purpose: '用途',
    structure: '构造',
  },
}
```

Core 对未知 category/subtype 直接显示原始 ID，不需要修改代码。因此 `building / wall / portal / vehicle / chest / mechanism` 都可以使用同一套 UI 和 Interaction API。

---

## 5. SVG Feature 标签

需要参与选择、状态同步或交互的可见 Feature，应在 `createSvg()` 中提供与 MapPackage Feature 对应的稳定 ID：

```xml
<g
  id="feature-portal-001"
  data-feature-id="portal-001"
  data-category="mechanism"
  data-subtype="portal"
>
  ...
</g>
```

Core 使用 `data-feature-id` 把 MapPackage Feature 与 SVG 图形关联，并统一写入：

```text
data-feature-state="intact|partial|destroyed"
data-feature-damaged="true|false"
data-interaction-open="true|false"
interaction-open / interaction-closed
```

地图作者可以使用这些标准状态钩子改变表现，但不能在地图包中实现状态机。

---

## 6. 可破坏逻辑的边界

地图包负责：

```text
“这个 Feature 的几何在这里，它可以破坏，材质/表现信息是这些。”
```

Core 负责：

```text
攻击区域命中
→ Damage Preview
→ Damage Event
→ Feature State / Scene State
→ damaged / destroyed
→ Renderer / Navigation 更新
→ Multiplayer 同步
```

因此制作第二张可破坏地图时 **不得复制兰州城的 DamageSystem**。只需提供符合 Contract 的 Feature。

---

## 7. 新地图 DIY 流程

1. 复制 `reference/maps/minimal/` 为新目录。
2. 修改 Map ID、名称、版本、尺寸。
3. 设计 Layer Plan，并给物理 SVG Group 设置 `data-layer`。
4. 添加 Feature 几何与 Capability。
5. 按需声明 `featureTaxonomy`，提供地图自己的中文/显示标签。
6. 添加素材并在 `assets.js` 绑定（如果需要）。
7. 保证 `createSvg()` 输出与 Feature ID 对应的 `data-feature-id`。
8. 用 `prepareMapPackage()` 做 Contract 校验。
9. 运行 `npm test`。
10. 运行 `npm run build`。
11. 将默认地图工厂切换到新 MapPackage 后做浏览器运行测试。

当前默认地图加载器集中在：

```text
src/map-package/default-map.js
```

主程序 `src/main.js` 不再认识“兰州城”，以后更换默认地图不应修改 Main / Damage / Movement / Scene / Interaction Core。

---

## 8. 禁止重新引入的模式

为避免 V1.4.2 / V1.4.3 的路径冲突，当前阶段禁止：

- 同一地图同时存在“前端 bundle 版本”和“Server 外部 maps 版本”两个 Source of Truth；
- Launcher 解析地图文件；
- PowerShell / BAT 负责映射地图目录；
- Browser 读取 Windows 文件系统路径；
- MapPackage 保存 Campaign 当前破坏状态；
- MapPackage 注入自己的 InteractionSystem / DamageSystem / NavigationSystem；
- 为某张地图的 category 在 Core 增加操作特判。

未来真正做 Scene Manager / External Map Import 时，应由 **唯一 Game Server** 统一管理 Data Path，再通过 HTTP API 向 Client 提供，不改变这一职责边界。

---

## 9. 当前 Reference

### `maps/lanzhou/`

完整复杂参考地图。包含大地图、道路、建筑、城墙、桥梁、黄河、Navigation、可破坏对象、Feature taxonomy、Generated Art 等复杂情况。

### `maps/minimal/`

极简参考地图。包含基础地面、水体、一栋可进入可破坏木屋、一扇可开关并影响通行的门和一堵可破坏墙，用来证明通用 Core/UI 不依赖兰州城。
