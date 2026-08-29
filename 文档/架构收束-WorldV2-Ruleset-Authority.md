# RPGmap V2 架构收束：World V2 / Ruleset / Authority

本文记录 2026-08 的架构收束结果，作为后续开发不可逆的默认边界。详细开发规范仍以《开发说明》为准。

## 1. 唯一权威

- **World V2**：Actor / Scene / Token 的持久化唯一权威。
- **Ruleset**：Actor.system、Health、伤害/治疗与游戏规则语义的权威。
- **StatusDefinition**：Buff / Debuff / Status 规则数据的唯一权威。
- **EffectInstance**：只保存 definitionId、stacks、enabled、source、note、时间戳等运行态数据。
- **Token.actorDelta**：Unlinked Token / Synthetic Actor 的实例差异唯一持久化位置。
- **World Operation**：普通 Actor / Token / Health 业务修改的持久化与联机提交入口。
- **EntityStore**：只读 projection / Ruleset context / 显式 legacy migration 适配器，不是普通业务写入权威。

## 2. Health 边界

HP 不再属于 Generic Resource。

Infinite Horror 中：

```text
Form.healthBase.baseMax
        ↓
system.runtime.health
        ↓
Ruleset Health resolve / damage / healing
        ↓
derived.health
```

禁止新代码重新创建：

```text
form.resourceBases.hp
system.runtime.resources.hp
resource.set-current('hp')
resource.set-max('hp')
```

旧 HP Resource 字段只能作为 import / normalize / migration 输入，规范化后必须消失。

Linked Actor 的 Health 修改使用 `actor.upsert`；Unlinked Token 的 Health 修改使用 `token.actorDelta.replace`。多目标伤害/治疗使用同一个 World Operation batch，成功后才发送 `health:change` 并写入聊天/战斗记录。

## 3. Status / Effect 边界

StatusDefinition 保存规则：

```text
name / icon / category / scopes / maxStacks / capabilities / changes
```

EffectInstance 只保存运行状态。禁止把 `definition.changes` 复制回 Actor.effects / Token.effects。

已退休的 inline `addEffect()` API 不得重新引入。Ruleset 可通过 writable attribute surface 约束 StatusDefinition 的数值写入目标。

## 4. Actor / Token 写入边界

普通 Actor 创建、XLSX 导入、形态切换、名称/头像修改和 Ruleset Actor Operation 都直接提交 `actor.upsert`。

Token 位置、实例状态与 Synthetic Actor delta 由 Token / World Operation 管理。

禁止重新建立：

```text
EntityStore.state
  → preferences.entitySystem
  → commitState
  → 再反推 World
```

作为普通 Actor / Health 写入路径。

## 5. EntityStore 边界

`EntityStore.load({ migrateLegacy: false })` 必须严格只读。Normalizer 可以在内存中形成安全 read view，但不得静默写回 projection。

只有显式 legacy migration / repair 边界允许持久化 Entity projection。

## 6. 后续架构方向

本轮 authority 收束完成后，不再继续无目的重构 Health / Status / EntityStore。下一阶段按以下方向发展：

1. World Manager：启动时先选择/创建 World。
2. MapPackage Registry：按 `Scene.mapPackage` 解析和加载地图包。
3. 启动链：World → Ruleset → ActiveScene → MapPackage → Runtime。
4. Scene 跨 MapPackage 切换与 runtime reload。
5. 新 World 创建时绑定 Ruleset，而不是使用浏览器级默认规则偏好。
6. Core Actor 增加 `img` / `prototypeToken`，Ruleset Form 只提供可选外观覆盖。

核心原则保持不变：

> Core 提供能力；Ruleset 提供规则；MapPackage 提供地图内容；World 组织规则与 Actor；Scene 组织地图与 Token。
