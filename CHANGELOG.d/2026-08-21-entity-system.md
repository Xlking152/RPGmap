# Entity / Actor / Token System

- 新增统一 `EntitySystem`：Actor 负责角色身份、形态、属性、资源与鉴定，Token 继续复用现有地图角色实体承担位置与移动，从而与已完成的 `MovementSystem` 直接兼容。
- 旧 Character 首次载入时自动迁移为 `Actor + Token`；旧 Marker 数据与入口退役，迁移时清空 Marker，并将以 Marker 为锚点的攻击范围安全解除绑定。
- 新增 XLSX 角色卡导入器，只读取 `角色概览` 与 `具体数值表`，直接读取工作簿缓存后的最终值，不执行、不保存 Excel 公式，也不读取购买清单、特性与技能、计算器。
- XLSX 导入支持姓名/基础信息、生命、精力、意志、9 项属性、技能鉴定、豁免/抵抗鉴定以及 `具体数值表` 内嵌头像；攻击/防御仅保留空数据接口。
- Actor 支持多个 Form；同名角色可继续导入为“变身前 / 变身后”等形态。选中 Token 后按 `V` 循环切换 Form，Token 位置、ID 与地图关系保持不变，头像与角色数据同步刷新。
- 资源数据分为 Base / Runtime / Effects：Excel 重新导入不会直接覆盖当前 HP、精力、意志；核心资源当前值与最大值可实时修改，并可自行添加、修改或删除特殊能量槽。
- 属性支持 Runtime 临时修正；Effects 底层已预留 `add / multiply / set / min / max` 修改模式，为后续特殊能力、Buff/Debuff 与战斗系统保留统一扩展路径。
- 新增 Actor Sheet：概览、属性、鉴定、战斗留白、Token 五个页签；支持角色改名、头像更换、导入新形态、资源修改、特殊能量槽和双击 Token 打开角色卡。
- 新增轻量 XLSX ZIP/XML 读取实现，不引入额外第三方依赖；真实“银（变身前/后）”角色卡已验证能够区分两个 Form 并读取最终缓存数值与头像。
