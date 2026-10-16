# RPGmap

RPGmap 是面向桌面跑团的自托管战术地图工具。v3.0.0 使用 Windows x64 桌面启动器管理 World、地图、规则、备份与后台服务，玩家通过浏览器加入。安装器自带运行环境，无需安装 Node.js。

“北宋兰州城”以独立 .rpgmap 文件提供。启动器不携带兰州运行资源，首次安装时地图列表为空；通过管理首页导入后才能创建使用该地图的场景。无引用的地图可以卸载，升级程序不会自动重新安装它。

## 安装与游玩

从同一正式 Release 下载：

- RPGmap-Setup-3.0.0.exe
- Lanzhou-1.1.0.rpgmap
- SHA256SUMS.txt
- README.md（使用说明）

1. 运行安装器，再打开桌面 RPGmap 图标。
2. 在管理首页点击“导入地图 / 随附兰州地图”，选择地图文件并确认。
3. 选择规则和起始地图，创建 World，再点击“启动”。
4. 将管理首页显示的玩家地址和加入码提供给玩家，在游戏“联机”面板批准身份和分配权限。

同一 World 固定规则版本，包含多个独立 Scene；GM 可为不同地图创建场景并带全体玩家切换。角色模板在 World 共享，Token、门、破坏、探索和场景设置分别保存。v3.0.0 保留 World schema 4、米制空间、Document 权威操作、权限裁剪、WAL 和断线恢复。

用户数据默认保存在 %LOCALAPPDATA%\RPGmap\UserData，与程序目录分离。覆盖安装和卸载保留用户数据。旧版 map/ 通过桌面导入向导复制和校验，原目录不改动。

详细操作见[操作指南](文档/操作指南.md)，分层、包契约及构建见[开发与制图说明](文档/RPGmap-v3.0.0-开发与制图说明.md)，版本摘要见[CHANGELOG](CHANGELOG.md)。

## 源码与资源

| 目录 | 职责 |
| --- | --- |
| desktop/、src/app/、src/ui/ | 桌面生命周期、管理首页、游戏界面 |
| src/runtime/ 及各专用核心 | 运行会话、移动、视野、破坏和渲染调度 |
| src/ruleset/、src/rulesets/ | 规则契约、版本注册与具体规则 |
| maps/ | 地图制作源与实际依赖资源 |
| 素材库/ | 公共制图素材和稳定资源索引 |
| src/contracts/、src/adapters/、deployment/local-server/ | 共享契约、环境适配、网络与存储 |
| tests/、scripts/ | 回归测试、必要夹具和构建检查 |
| 文档/ | 当前用户和开发说明 |

生产入口为 src/hosted-main.js。旧离线入口 standalone.html 与 src/main.js 保留兼容回归，不进入桌面生产载荷。地图和规则包不能反向依赖 UI，UI 不直接改写 World。

## 本地开发

构建基线为 Node.js 24.19.0、npm 11.17.0，依赖严格使用 package-lock.json。

~~~powershell
npm ci
npm test
npm run dev
npm run build
npm run check:bundle -- . --strict-budget
npm run package:desktop
npm run export:maps
~~~

地图默认导出到 artifact/content-packages；正式交付汇总到 release/RPGmap-v3.0.0。桌面运行库单独统计，原应用 JS/CSS 门槛继续执行。完整构建、汇总和校验命令见开发说明。

v3.0.0 的发布范围是分层整理、桌面启动和独立内容包交付；多人后端尾延迟与七浏览器长任务超标仍保留为已知问题，按用户决定暂缓优化。没有特殊说明时只测本地 GM 单人操作延迟，浏览器默认 Chrome；多人功能回归继续保留。干净 Windows、真实 VPN 多机及安装中断等未测范围见 CHANGELOG。源码中不保留候选包、截图、性能 trace 或阶段验收报告。
