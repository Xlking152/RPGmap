# RPGmap Feature Map Controls

V1.5 的地图控件不是独立 DoorSystem，而是 **Feature Operations 的地图端 UI 入口**。

```text
MapPackage Feature
  ↓ Capability: open / close
Feature Control Layer
  ↓ click
api.interaction.open / close
  ↓
Feature State
  ↓
Navigation / SVG / Save / Multiplayer
```

## 当前行为

任何声明 `openable` 或 `actions.open / actions.close` 的 Feature 默认会得到一个固定屏幕尺寸的地图开关。控件位置默认使用 `feature.center`，没有 center 时尝试 `feature.entrance`。

地图可以覆盖展示信息：

```js
presentation: {
  control: {
    type: 'toggle',
    anchor: [500, 400],
    style: 'door',
    label: '北门',
    size: 28
  }
}
```

如果某个可开关 Feature 只希望从 Inspector/API 操作：

```js
presentation: { control: false }
```

当前 V1.5 只实现 `toggle`。关闭时点击执行 `open`，打开时点击执行 `close`；Feature destroyed 后控件隐藏。控件不维护第二份状态，不按 `door / gate / building` category 判断。

## 多人权限边界

本地模式和 GM 可以直接操作地图控件。当前 Player 端暂不允许直接改变 World 级 Feature State，以避免绕过既有 Server 权限校验；控件层已经预留 `permissions.interactFeatures === true` 的读取位置，但 Server 权限与 operation-level 同步尚未实现。

锁门、秘密门、Player Feature 权限、右键菜单、声音/动画和更多 control action 统一记录在 `文档/未来规划.md`，不进入 V1.5 首版控件范围。
