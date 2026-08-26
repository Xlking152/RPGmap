# RPGmap

RPGmap 是面向 TRPG / VTT 的自托管地图与跑团工具。当前版本为 **v1.7.0**，Windows 仅支持本机与局域网（Local / LAN）联机。

## 快速开始

从发布 ZIP 解压后双击 `start-rpgmap.bat`。启动器使用系统默认浏览器打开 GM 页面，并显示：

- Local URL（主机 GM 使用）；
- LAN URL 与 Join Code（发送给 Player）；
- GM Secret（仅 GM 自己使用）。

完整步骤见 [操作指南](文档/操作指南.md)。请不要将 Local/LAN 服务或 GM Secret 暴露到公网。

## 当前能力

- Actor / Form / Token、角色卡导入与 GM 放置 Token；
- 1m 格子中心的直线移动、Ctrl/Cmd 手动拐点、受阻红线、Token 高度与尺寸；
- 普通 HP 与 B/L/A 伤势生命槽、伤害、恢复、角色卡直接编辑伤势；
- Actor / Token 状态与 Buff、地图徽章、派生昏迷/死亡，以及灵体、定身、失能等机械效果；
- 先攻表、回合锁定、聊天与共享战斗记录；
- LAN WebSocket 同步、GM / OWNER / OBSERVER 权限，以及服务器权威 World；
- 原子保存、滚动备份、损坏存档隔离与 Windows 打包启动器。

## 文档入口

| 文档 | 用途 |
| --- | --- |
| [操作指南](文档/操作指南.md) | GM 建房、Player 加入、权限、移动、战斗、生命、存档与故障排查。 |
| [开发说明](文档/开发说明.md) | 目录边界、数据模型、测试和发布约定。 |
| [未来规划](文档/未来规划.md) | 已知边界与后续架构方向。 |
| [变更日志](CHANGELOG.md) | 版本级别变更。 |
| [地图参考](reference/README.md) | 自定义 MapPackage 与参考地图资料。 |

## 本地开发

```bash
npm ci
npm test
npm run dev
```

生产构建与 Windows 包：

```bash
npm run build
npm run package:local-server
```

生成物位于 `artifact/RPGmap-vX.Y.Z.zip`，并附带 SHA256 校验文件。运行数据只存在于发布包的 `map/` 目录；升级前请备份整个该目录。
