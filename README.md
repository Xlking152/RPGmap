# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器地图工具，目标是逐步发展为类似 Foundry VTT 的可自托管跑团平台。项目本身不绑定某一张地图：地图内容通过独立 `MapPackage` 接入，当前仓库中的北宋兰州地图只是第一张可用地图包和开发验证场景。

当前应用版本：**1.2.0**。

## 当前定位

RPGmap 目前已经具备地图交互、角色与 Token、路径移动、FVTT 风格距离尺、范围、场景破坏和本地服务器测试能力。后续重点将转向多地图 / World 管理、服务器持久化、多人同步、权限以及 CombatSystem。

核心结构：

```text
RPGmap
├─ MapPackage          地图与场景内容
├─ EntitySystem        Actor / Token / Form / Runtime / Effects
├─ MovementSystem      Token 拖动、Waypoint、A*、移动成本与 Ghost
├─ MeasurementSystem   Ruler、Waypoint、纯几何距离
├─ Path UI             Movement / Ruler 共用的距离标签显示层
├─ AppShell UI         选择、测量、范围、场景、角色库与 Inspector
└─ Server              当前为本地 HTTP 测试层，后续升级为正式自托管服务
```

## 主要功能

### 地图与场景

- Leaflet + SVG 地图画布，支持平移、缩放与地图坐标。
- 地图包与通用引擎分离，后续可继续接入其他地图。
- 地物检查、建筑详情、可进入建筑、场景破坏、恢复与撤销。
- 圆形 / 扇形 / 矩形范围工具。
- FVTT 风格 Ruler：一套工具同时完成直线与多拐点路线测距。
- 弹坑、液体连通等现有场景规则作为地图能力保留。

### Actor / Token

- `Actor` 保存角色身份、头像、属性、资源、技能 / 豁免、Forms、Runtime 与 Effects。
- `Token` 负责地图上的位置、选择、移动、锁定、隐藏等场景状态。
- 一个 Actor 可以拥有多个 Form，例如“变身前 / 变身后”。
- HP、精力、意志和自定义资源槽均可实时修改。
- Base / Runtime / Effects 分层，临时伤害、治疗、Buff / Debuff 不直接破坏导入的基础数据。
- XLSX 角色卡导入目前只读取 `角色概览` 与 `具体数值表` 的最终缓存值，不执行 Excel 公式。

### MovementSystem

- 直接拖动 Token 规划路线。
- EasyStar A* 路径规划与道路优先移动。
- Ghost Token 预览。
- Waypoint 分段路线。
- 5 / 10 / 20 / 50 / 100 m 移动吸附档位。
- 分段移动成本与总移动成本显示。
- 固定 waypoint 在切换吸附档位时保持不变。
- Movement 路线绘制在较低图层，距离标签统一绘制在独立高层 `pathLabelPane`，路线不会遮挡数字。

### MeasurementSystem

- 原“两点测距 / 路线测距”合并为一个 Ruler 子功能。
- `R` 可快速开启 / 关闭距离尺，也可以点击顶部“测量”。
- 第一次左键设置起点，移动鼠标实时预览，普通左键结束。
- `Ctrl/Cmd + 左键` 或 `F` 添加 waypoint。
- 右键或 `Alt + F` 撤销最近 waypoint。
- `Esc` 清除当前尺子。
- 0 个 waypoint 就是普通两点测距；1 个以上 waypoint 自动成为折线路线测距。
- Ruler 计算纯几何距离；Movement 仍计算 A* 路线与移动成本，两者不会混用规则。
- Ruler 与 Movement 共用高层距离标签视觉规则，因此测量线和移动路线都不会遮挡距离数字。

## 常用操作与快捷键

| 操作 | 快捷方式 |
| --- | --- |
| 选择 Token | 左键单击 |
| 打开角色卡 | 双击 Token，或右键菜单 |
| 普通移动 | 直接拖动 Token，松开后确认 |
| 进入 Waypoint 规划 | 按住 `Ctrl` / macOS `Cmd` 拖动并松开 |
| 添加移动 Waypoint | `Ctrl/Cmd + 左键`，或 `F` |
| 删除最近移动 Waypoint | 右键，或 `Alt + F` |
| 确认移动 | `Enter` |
| 取消移动规划 | `Esc` |
| 切换移动吸附档位 | 规划移动时滚轮 |
| 开启 / 关闭距离尺 | `R`，或点击顶部“测量” |
| 设置 Ruler 起点 / 终点 | 左键 |
| 添加 Ruler Waypoint | `Ctrl/Cmd + 左键`，或 `F` |
| 撤销 Ruler Waypoint | 右键，或 `Alt + F` |
| 清除当前 Ruler | `Esc` |
| 切换角色 Form / 变身 | 选中多 Form Token 后按 `V` |
| Token 上下文菜单 | 右键 Token |

> `Ctrl/Cmd` 拖动 Token 松开的地点只用于进入 Movement Waypoint 规划，不自动记为第一个拐点；之后第一次左键才是 waypoint 1。

## 界面结构

顶层 UI 当前收口为：

```text
选择 | 测量 | 范围 | 场景 | 导入角色 | 存档
```

“测量”不再提供“两点测距 / 路线测距”两个历史入口，而是直接切换统一 Ruler。

右侧主要使用“角色库 / 当前对象”两种上下文；完整 Actor Sheet 独立打开。Movement 相关吸附与确认 UI 只在移动规划期间显示，避免长期占用地图空间。

## 本地开发

需要 Node.js：`^20.19.0 || >=22.12.0`。

```bash
npm ci
npm test
npm run dev
```

生产构建：

```bash
npm run build
```

## 本地服务器测试

仓库的 `deployment/local-server/` 提供当前服务器化过渡阶段的启动器。GitHub Release 发布包会包含预编译的 Web Client 与零第三方运行依赖的 Node HTTP Server。

Windows：

```text
start-rpgmap.bat
```

Linux / macOS：

```bash
./start-rpgmap.sh
```

默认地址：`http://127.0.0.1:30000`。同一局域网设备可通过服务器控制台显示的 Network 地址访问。

当前服务器层仍属于过渡阶段：Actor / Token / Scene 的长期状态暂时仍以浏览器存储为主。正式 World Store、REST、WebSocket、GM / Player 权限和多人同步见未来规划。

## 项目目录

```text
src/
├─ app/           持久化与应用辅助
├─ engine/        地图核心、几何、导航、场景状态
├─ entities/      Actor / Token / Form / XLSX
├─ maps/          独立 MapPackage
├─ measurement/   FVTT 风格 Ruler
├─ movement/      Token MovementSystem
├─ path/          Movement / Ruler 共用的路径显示辅助
├─ render/        场景与地图表现
└─ ui/            AppShell UI

tests/            自动化测试
deployment/       本地服务器与发布设施
文档/             工作日志、未来规划、开发说明
```

## 文档

- `文档/工作日志.md`：按应用版本记录重要更新，不再记录每次小提交或 CI 构建编号。
- `文档/未来规划.md`：服务器化、多地图、多人同步和后续系统路线。
- `文档/开发说明.md`：代码结构、系统边界、MapPackage 与开发约定。

## 版本规则

RPGmap 使用语义化的 `1.x.x` 应用版本：

- Patch，例如 `1.2.1`：Bug 修复、小交互调整、兼容性修正。
- Minor，例如 `1.3.0`：新增较完整功能或子系统，同时尽量保持已有数据兼容。
- Major，例如 `2.0.0`：存在明显不兼容的数据、服务器协议或核心架构变化。

**版本号不会因普通提交或测试包自动增长。** 当开发内容达到新的版本节点时，先提出建议版本和理由，经确认后再修改版本号并写入工作日志。

GitHub Release 也以应用版本为准，例如 `v1.2.0`，不再使用连续的 Server 构建编号作为产品版本。
