# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器地图工具，目标是逐步发展为类似 Foundry VTT 的可自托管跑团平台。项目本身不绑定某一张地图：地图内容通过独立 `MapPackage` 接入，当前仓库中的北宋兰州地图只是第一张可用地图包和开发验证场景。

当前应用版本：**1.3.0**。

## 1.3.0 核心能力

```text
RPGmap
├─ MapPackage          地图与场景内容
├─ EntitySystem        Actor / Token / Form / Runtime / Effects
├─ SelectionSystem     单选、多选、矩形框选
├─ MovementSystem      Token 拖动、Waypoint、A*、移动成本与 Ghost
├─ MeasurementSystem   Ruler、角色测距、Waypoint、纯几何距离
├─ CombatSystem        参战者、先攻、顺序、轮次与当前回合
├─ HealthSystem        SimpleHP / WoundTrack
├─ DamageSystem        向所选 Token 应用最终伤害
├─ HealingSystem       向所选 Token 应用实际恢复量
├─ ChatSystem          聊天、战斗 / 伤害 / 恢复 Game Log、未来 Roll 接口
├─ Path UI             Movement / Ruler 共用高层距离标签
├─ AppShell UI         顶栏、左侧先攻表、右侧聊天 / 角色库 / Inspector
└─ Server              本地 HTTP 测试层，后续升级正式自托管服务
```

## 操作指南

### 1. 启动

需要 Node.js `^20.19.0 || >=22.12.0`。

发布 / 测试包：

- Windows：双击 `start-rpgmap.bat`。
- Linux / macOS：执行 `./start-rpgmap.sh`。
- 默认地址：`http://127.0.0.1:30000`。
- 同一局域网设备可使用启动窗口显示的 Network 地址访问。

源码开发：

```bash
npm ci
npm test
npm run dev
```

生产构建：

```bash
npm run build
```

### 2. 导入与查看角色

- 使用顶栏“导入角色”导入 XLSX 角色卡。
- 当前模板只读取 `角色概览` 和 `具体数值表` 中 Excel 已保存的最终缓存值，不执行公式。
- 双击地图 Token 或通过 Token 右键菜单打开角色卡。
- 多 Form 角色选中 Token 后按 `V` 快速切换形态。
- `鉴定` 页显示技能鉴定与意志 / 反射 / 强韧豁免。
- `不良状态` 页可直接修改 21 种不良状态当前点数；阈值随 Form 切换，当前点数保留。

### 3. Token 选择与框选

- 左键点击 Token：单选。
- 从地图空白处左键拖动：矩形框选。
- `Shift + 点击 / 框选`：追加选择。
- `Alt + 点击 / 框选`：从当前选择移除。
- 点击空白：清空选择。
- `Space + 左拖`：平移地图。
- 从 Token 本身开始拖动始终交给 MovementSystem，不会误触框选。

SelectionSystem 是战斗、角色测距、伤害和恢复生命的统一目标来源。

### 4. Token 移动

- 直接拖动 Token：规划移动路线。
- Movement 使用 A* 路线和移动成本，与纯测距 Ruler 分离。
- `Ctrl/Cmd` 拖动并松开：进入 Waypoint 规划。
- `Ctrl/Cmd + 左键` 或 `F`：添加 Waypoint。
- 右键或 `Alt + F`：删除最近 Waypoint。
- `Enter`：确认移动。
- `Esc`：取消移动规划。
- 规划移动时滚轮：切换 5 / 10 / 20 / 50 / 100 m 吸附档位。

距离数字绘制在独立高层 `pathLabelPane`，移动路线不会遮挡数字。

### 5. 测距

- 点击顶栏“测量”或按 `R`：开启 / 关闭 Ruler。
- 左键设置起点，移动鼠标实时查看距离，再次左键结束。
- `Ctrl/Cmd + 左键` 或 `F`：增加测距 Waypoint。
- 右键或 `Alt + F`：撤销最近 Waypoint。
- `Esc`：清除当前 Ruler。
- 选中 Token 后点击“角色测距”，或按 `Shift + R`：以该 Token 中心为起点开始测距。

Ruler 计算纯几何距离；Movement 计算实际移动路线与移动成本。

### 6. 进入战斗与先攻

1. 单选或框选准备参战的 Token。
2. 点击顶栏“进入战斗”。只有当前已经选择的 Token 会进入战斗。
3. 左侧先攻表展开，在每个参战者旁手动输入先攻。
4. 输入先攻后默认按数值从大到小排序；空白先攻放在末尾。
5. 可以拖动先攻表中的拖动柄手动确定最终顺序。
6. 点击“开始战斗”进入第 1 轮；手动拖动后的顺序不会在开战时被重新排序。
7. 点击“下一回合”依次推进；最后一个角色结束后自动进入下一轮。
8. 点击“结束战斗”清除当前 Combat。

战斗建立以后，新出现或后来选中的 Token **不会自动加入**。需要明确选中新角色，再点击“加入所选”。点击先攻表中的角色可选中并定位其地图 Token。

### 7. 聊天与 Game Log

右侧栏包含：

```text
聊天 | 角色库 | 当前
```

“聊天”页支持：

- 普通聊天消息。
- Combat 事件记录。
- 伤害记录。
- 恢复记录。
- 预留 `roll` 类型，后续投骰和检定结果直接复用同一 Game Log。

### 8. 伤害

1. 在地图上选择一个或多个 Token。
2. 打开右侧 `聊天 → 伤害`。
3. 输入已经完成防具、硬度、DR、免疫、临时生命等前置结算后的**最终伤害值**。
4. WoundTrack 角色选择 `B 冲击 / L 严重 / A 恶性`。
5. 点击应用，伤害同时作用于所有明确选择的目标，并写入 Game Log。

当前规则的 WoundTrack 使用：

```text
完好 / B 冲击 / L 严重 / A 恶性
```

伤害溢出会按规则升级。没有完好生命时标记昏迷；全部生命槽成为 A 时标记死亡；无完好且存在 A 时提示伤势恶化。伤势恶化目前只提示，不自动逐轮扣除。

### 9. 恢复生命

1. 选择一个或多个 Token。
2. 打开右侧 `聊天 → 恢复`。
3. 输入已经按具体技能 / 能力规则换算好的**实际恢复生命槽数**。
4. WoundTrack 选择要恢复的 `B / L / A` 伤势，然后应用。
5. SimpleHP 模式直接增加当前 HP，最高不超过上限。

HealingSystem 不把“治疗点数 / 医疗点数”写死成统一兑换率，因为不同规则效果可以采用不同换算比例。普通恢复也不作为复活接口：已经全部为 A、处于死亡状态的 WoundTrack 角色不会被普通恢复直接复活。

### 10. Token 血条

地图 Token 上方常驻生命条，并随伤害、恢复和状态变化刷新：

- SimpleHP：绿色表示当前 HP / 最大 HP。
- WoundTrack：绿色 = 完好，黄色 = B，橙色 = L，深红 = A。

血条不接管鼠标事件，不会妨碍 Token 选择、拖动或框选。

## 快捷键速查

| 操作 | 快捷方式 |
| --- | --- |
| 单选 Token | 左键单击 |
| 框选 Token | 空白地图左键拖动 |
| 追加选择 | `Shift + 点击 / 框选` |
| 从选择中移除 | `Alt + 点击 / 框选` |
| 平移地图 | `Space + 左拖` |
| 打开角色卡 | 双击 Token / 右键菜单 |
| 普通移动 | 直接拖动 Token |
| Movement Waypoint 模式 | `Ctrl/Cmd` 拖动并松开 |
| 添加移动 Waypoint | `Ctrl/Cmd + 左键` / `F` |
| 删除最近移动 Waypoint | 右键 / `Alt + F` |
| 确认移动 | `Enter` |
| 取消移动 | `Esc` |
| 切换移动吸附档位 | 移动规划时滚轮 |
| 开启 / 关闭 Ruler | `R` |
| 从所选角色测距 | `Shift + R` |
| 添加 Ruler Waypoint | `Ctrl/Cmd + 左键` / `F` |
| 撤销 Ruler Waypoint | 右键 / `Alt + F` |
| 清除 Ruler | `Esc` |
| 切换角色 Form | `V` |
| Token 上下文菜单 | 右键 Token |

## 数据与系统边界

### Actor / Token / Combatant

```text
Actor
  ↑
Token
  ↑
Combatant
```

- Actor 保存角色真实数据。
- Token 保存地图实例状态。
- Combatant 只保存战斗引用、先攻与顺序，不复制角色 HP、资源或属性。

### HealthSystem

RPGmap 保留两种生命模式：

- `SimpleHP`：传统 `current / max`，用于其他游戏。
- `WoundTrack`：完好 / B / L / A，当前 XLSX 角色默认采用。

DamageSystem 与 HealingSystem 只提供通用“应用到所选目标”的能力，具体游戏规则通过 Health Adapter 扩展。

## 项目目录

```text
src/
├─ app/           持久化与应用辅助
├─ chat/          ChatSystem / Game Log
├─ combat/        先攻与回合 CombatSystem
├─ damage/        DamageSystem
├─ engine/        地图核心、几何、导航、场景状态
├─ entities/      Actor / Token / Form / XLSX
├─ healing/       HealingSystem
├─ health/        SimpleHP / WoundTrack / Token 血条
├─ maps/          独立 MapPackage
├─ measurement/   FVTT 风格 Ruler
├─ movement/      Token MovementSystem
├─ path/          Movement / Ruler 共用路径显示辅助
├─ render/        场景与地图表现
├─ selection/     Token 单选、多选与框选
└─ ui/            AppShell UI

tests/            自动化测试
deployment/       本地服务器与发布设施
文档/             工作日志、未来规划、开发说明
```

## 本地服务器当前限制

当前 Server 仍属于服务器化过渡阶段：

- HTTP Server 已真实运行，不依赖 `vite dev` 或 `vite preview`。
- `/api/health` 与 `/api/version` 可访问。
- Actor / Token / Scene / Combat 等长期状态暂时仍主要使用浏览器存储。
- World Store、WebSocket、GM / Player 权限和多人同步尚未接入。

## 文档

- `文档/工作日志.md`：按应用版本记录重要更新。
- `文档/未来规划.md`：服务器化、多地图、多人同步和后续系统路线。
- `文档/开发说明.md`：代码结构、系统边界、MapPackage 与开发约定。
- `deployment/local-server/README.md`：发布 / 测试包内使用的启动和操作指南；后续打包应同步携带该 README。

## 版本规则

RPGmap 使用语义化版本：

- Patch，例如 `1.3.1`：Bug 修复、小交互调整、兼容性修正。
- Minor，例如 `1.4.0`：新增较完整功能或子系统，同时尽量保持已有数据兼容。
- Major，例如 `2.0.0`：存在明显不兼容的数据、服务器协议或核心架构变化。

普通提交和测试包不会自动提升应用版本。GitHub Release 使用应用版本号，例如 `v1.3.0`。
