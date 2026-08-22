# RPGmap MapPackage / Reference Map 规范

本目录保存 **地图源码参考包**。它不是 `world` 数据目录，也不是运行时由 Server 扫描的外部 `maps/` 目录。

当前设计原则：

```text
MapPackage 源码（reference/）
        ↓ build
RPGmap Core + 选中的 MapPackage
        ↓
app/index.html
        ↓
server.mjs
        ↓
Browser
```

因此，打包完成后的 `app/index.html` 是完整可运行客户端；`reference/` 只是给开发者、地图作者和后续维护使用的源码/规范参考。删除发布包里的 `reference/` 不应影响已经 build 好的 RPGmap 运行。

---

## 1. 四层职责

### MapPackage：世界“是什么”

地图包只描述地图内容：

- 地图尺寸与坐标系；
- 基底、地面、液体、特殊表现、可破坏对象、标签；
- Feature 的几何、名称、类别、素材；
- Navigation 数据；
- Liquid 数据；
- Feature 是否可检查、进入、破坏等能力声明。

地图包 **不实现** 玩家点击、攻击结算、破坏状态机、多人同步、权限、存档。

### RPGmap Core：世界“如何运行”

通用逻辑位于 `src/`：

- Selection / Inspect；
- Movement / Navigation；
- Damage / Restore / Undo；
- Scene State；
- Actor / Health / Combat；
- Multiplayer / Ownership；
- Rendering / UI。

Core 不应该出现 `if (map === lanzhou)` 之类地图特判。

### Scene Instance：这一张地图“现在怎样”

以后 Scene Manager 落地后，同一个 MapPackage 可以实例化为多个 Scene。破坏、角色位置、开关状态等都属于 Scene Instance，而不是写回 MapPackage。

### World：这一场 Campaign“发生了什么”

World 保存 Scene Instance、Users、Actors、Combat、Chat 等运行状态。MapPackage 本身应保持只读模板语义。

---

## 2. Reference Map 目录样式

推荐每张源码地图采用：

```text
reference/maps/my-map/
├─ manifest.js       # id / 版本 / 逻辑 Layer Plan
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

物理 SVG Layer 与逻辑 Layer 不必一一相同。老地图可以通过 `layerPlan` 做兼容映射。例如兰州城当前 Terrain 仍绘制在历史 `base` SVG Group 中，但在逻辑层已经声明为 `terrain`，以后可以逐步物理拆开而不修改 Core API。

示例：

```js
export const MY_LAYER_PLAN = [
  { id: 'base', role: 'base', sourceLayers: ['base'] },
  { id: 'terrain', role: 'terrain', sourceLayers: ['terrain'] },
  { id: 'liquid', role: 'liquid', sourceLayers: ['liquid'] },
  { id: 'special', role: 'special', sourceLayers: ['effects', 'damage'] },
  { id: 'destructible', role: 'destructible', sourceLayers: ['destructible'] },
  { id: 'labels', role: 'labels', sourceLayers: ['labels'] },
];
```

---

## 4. Feature + Capability

地图对象统一视为 Feature。Feature 描述自身，不编写游戏规则：

```js
{
  id: 'house-001',
  name: '木屋',
  category: 'building',
  geometry: {
    type: 'polygon',
    points: [[100,100], [300,100], [300,260], [100,260]],
  },
  center: [200,180],
  enterable: true,
  destructible: {
    enabled: true,
    maxHp: 100,
    material: 'timber-earth',
  }
}
```

`src/map-package/contract.js` 会把旧字段与新声明统一归一成：

```text
feature.capabilities.inspectable
feature.capabilities.interactive
feature.capabilities.enterable
feature.capabilities.destructible
```

当前 Engine 为保持 V1.4.1 兼容仍可读取旧字段；后续重构应逐步统一读取 Capability。

---

## 5. 可破坏逻辑的边界

地图包负责：

```text
“house-001 是 building，几何在这里，可以破坏，材质是 timber-earth。”
```

Core 负责：

```text
攻击区域命中
→ Damage Preview
→ Damage Event
→ Scene State
→ damaged / destroyed
→ Renderer / Navigation 更新
→ Multiplayer 同步
```

因此制作第二张可破坏地图时 **不得复制兰州城的 DamageSystem**。只需提供符合 Contract 的 Feature。

---

## 6. 新地图 DIY 流程

1. 复制 `reference/maps/minimal/` 为新目录。
2. 修改 Map ID、名称、版本、尺寸。
3. 设计 Layer Plan。
4. 添加 Feature 几何与 Capability。
5. 添加素材并在 `assets.js` 绑定（如果需要）。
6. 保证 `createSvg()` 输出与 Feature ID 对应的 `data-feature-id`。
7. 用 `prepareMapPackage()` 做 Contract 校验。
8. 运行 `npm test`。
9. 运行 `npm run build`。
10. 将默认地图工厂切换到新 MapPackage 后做浏览器运行测试。

当前默认地图选择集中在：

```text
src/map-package/default-map.js
```

主程序 `src/main.js` 不再认识“兰州城”，以后更换默认地图不应修改 Main / Damage / Movement / Scene Engine。

---

## 7. 禁止重新引入的模式

为避免 V1.4.2 / V1.4.3 的路径冲突，当前阶段禁止：

- 同一地图同时存在“前端 bundle 版本”和“Server 外部 maps 版本”两个 Source of Truth；
- Launcher 解析地图文件；
- PowerShell / BAT 负责映射地图目录；
- Browser 读取 Windows 文件系统路径；
- MapPackage 保存 Campaign 当前破坏状态。

未来真正做 Scene Manager / External Map Import 时，应由 **唯一 Game Server** 统一管理 Data Path，再通过 HTTP API 向 Client 提供，不改变这一职责边界。

---

## 8. 当前 Reference

### `maps/lanzhou/`

完整参考地图。包含大地图、道路、建筑、城墙、桥梁、黄河、Navigation、可破坏对象、Generated Art 等复杂情况。

### `maps/minimal/`

极简地图。只有基础地面、水体、一栋可进入可破坏木屋和一堵可破坏墙，用来证明通用 Core 不依赖兰州城。
