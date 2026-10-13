# RPGmap v3 开发与制图说明

应用当前为 `3.0.0-rc.1`；正式版必须另行构建并验收。存档仍使用 World schema 4，无限规则 1.1.0、兰州地图 1.1.0 分别固定版本。

## 依赖与职责

| 主层 | 实现入口 |
| --- | --- |
| 整体 | `desktop/` 桌面生命周期；`src/app/` 启动与管理 UI；现有 `src/ui/` 游戏界面；`src/main.js` 装配 |
| 运行 | `src/runtime/core/session.js` 无 DOM 命令、查询、订阅、销毁；`src/runtime/map-runtime.js` 浏览器装配；`engine/movement/vision/render/world/documents` 中的各专用核心与适配实现 |
| 规则 | `src/rulesets/` 与 `src/ruleset/` 版本注册；受信任的 `.rpgrules` 包 |
| 地图 | `maps/` 制作项目；`src/map-package/` 契约；`.rpgmap` 导出；UserData 版本目录 |

`src/contracts/` 给出稳定支持契约；`src/adapters/` 负责浏览器读取包目录；`deployment/local-server/` 负责网络、WAL、磁盘、内容注册和管理接口。它们不是额外业务层。旧导入路径按职责逐步转发，不维护第二份 World 或地图几何。运行核心通过权威 Document 操作提交，不允许 UI 直接改写 World。

规则是 World 的实例依赖，Scene 固定地图 ID 与版本。运行时、服务器都读取安装包的同一内容指纹。跨地图或同 ID 不同版本会重建浏览器 Runtime；同地图切换 Scene 保留独立状态，并先取消输入和 Worker。首版所有玩家共享活动 Scene，不搬运 Token。

## 制作与素材

资源索引位于 `素材库/资源索引.json`，记录稳定 ID、尺寸、SHA-256、用途、来源和废墟对应。索引是制图资料，不是运行属性。阻挡、遮挡、高度、破坏和门状态在 `map.json`；外观和废墟通过相同地物 ID 绑定。地图本身只读，当前状态在 Scene 中。

地图 ZIP 根目录需要 manifest.json、map.json、map.svg，附带实际引用的 assets。可选 preview.webp 和 README.md。现有导出器保持兰州画面和几何；地图包与安装器是独立交付文件。规则包也是独立版本，执行入口仅面向受信任本项目契约，不能作为任意第三方脚本的沙箱。

包内 SVG 使用静态格式：标准 SVG 默认 namespace，必要时使用标准 `xlink`、`xml` 前缀；其他 namespace 别名、编辑器扩展、脚本、动画、外部资源和带转义的 CSS 会被拒绝。制图工具应先导出不含编辑器扩展的普通 SVG；图片和 CSS 引用必须指向包内资源。

应用内置的无限规则 `infinite-horror@1.1.0` 由应用维护；导入同 ID、同版本的 `.rpgrules` 会明确提示已内置，并拒绝覆盖。更新规则内容必须使用新版本，已有 World 不会自动改用新版。外部规则允许 `entry.mjs` 引用包内 `modules/*.mjs`；服务端按内容指纹隔离整个模块图，避免使用旧模块缓存。卸载外部规则先检查 World 和恢复点引用，并保留版本指纹记录；再次导入相同内容可安装，同版本不同内容仍被拒绝。

## 构建与检查

环境：Node 24.19.0/npm 11.17.0；所有 npm 依赖按 lockfile 固定。用户运行 Windows 安装版无需安装这些工具。

```powershell
npm ci
npm test
npm run build
npm run check:bundle -- . --strict-budget
npm run package:desktop
npm run export:maps -- --out artifact/RPGmap-v3.0.0-rc.1-验收
npm run export:rulesets -- --out artifact/RPGmap-v3.0.0-rc.1-验收
node scripts/desktop-browser-smoke.mjs --map=artifact/RPGmap-v3.0.0-rc.1-验收/北宋兰州城-1.1.0.rpgmap
```

桌面产物白名单与 SHA 在 `INSTALL-MANIFEST.json`，构建元数据包含源提交及 dirty 状态。最终候选应从可审查提交构建；报告必须对应实际文件 SHA。发行只采用下载新版安装器覆盖，不自动在线更新。数据默认位于 `%LOCALAPPDATA%/RPGmap/UserData`，安装目录仅有程序文件。

旧 map/ 目录导入只在桌面文件选择接口开放：复制原始 World、WAL、权限、uploads 和备份，校验并迁移副本后登记为新 World；原目录保留。普通网页及远程 GM 无任意磁盘读取接口。JSON 存档导入与地图导入分别提供。

恢复环境保留 Token、标记、模板及战斗，恢复门、破坏、覆盖和探索；清空场景还删除 Token、标记、模板、关联战斗并恢复 Scene 设置。两者先备份、后权威提交；恢复点还原使用可恢复的多文件事务。冲突 Token 交给 GM 处理，不移动到猜测位置。

实际进度与限制请读交付目录验收报告，不把这些规范视作已验收结论。
