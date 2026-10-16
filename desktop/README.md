# RPGmap 桌面构建与服务契约

桌面壳将应用界面及无地图数据的服务端分别打包进 `resources/app`、`resources/server`。主进程和受限 preload 放入 ASAR。应用自身的前端依赖已构建成静态文件，安装版无需系统 Node.js。

## 构建

- `node scripts/package-desktop.mjs --stage-only`：构建并校验桌面程序载荷。
- `node scripts/package-desktop.mjs --dir`：生成可运行的桌面程序目录。
- `node scripts/package-desktop.mjs`：构建 Windows x64 NSIS 安装器，放入 artifact/desktop/；独立地图导出到 artifact/content-packages/。
- `node scripts/verify-desktop-package.mjs --installed=artifact/desktop/win-unpacked`：核对静态载荷、ASAR、资源白名单与全部哈希。
- `powershell -NoProfile -File scripts/desktop-installer-smoke.ps1`：在隔离的 `artifact/` 目录实际执行安装、同版本升级、卸载和重装，记录证据。检测到其他安装位置时拒绝运行。
- `node scripts/desktop-browser-smoke.mjs --reuse-data --screenshots`：显示测试窗口并保存管理首页、游戏截图；默认测试使用隐藏窗口，不依赖截图接口。

构建器读取根 `package.json` 的应用版本及精确 Electron/electron-builder 版本。`INSTALL-MANIFEST.json` 记录源提交、是否有工作区改动、工具版本和应用载荷校验；完整程序清单 `PROGRAM-FILES.txt` 用于卸载及更新清理。地图由独立导出脚本产生，不进入安装器。

Electron 44 的 npm 包不自动下载运行库。`package:desktop` 会调用其内置安装入口，按锁定版本与校验信息准备运行库，干净检出后无需手工补文件；首次构建需要网络或已有运行库缓存。

## 服务进程接口

主进程通过 Electron `utilityProcess.fork` 启动 ESM 服务，提供以下环境变量：

- `RPGMAP_DATA_DIR`：独立用户数据目录，默认 `%LOCALAPPDATA%\RPGmap\UserData`。
- `RPGMAP_STATIC_DIR` / `RPGMAP_PUBLIC_DIR`：安装后的前端目录。
- `RPGMAP_PACKAGE_ROOT`：安装后的服务目录。
- `RPGMAP_MANAGER_SECRET` / `RPGMAP_GM_SECRET`：每次启动生成的不同随机秘密。
- `RPGMAP_DESKTOP=1`、`HOST=0.0.0.0`、`PORT`：本地服务及 LAN 接入。首页可保存端口到 `UserData/config/settings.json` 并重启服务。`RPGMAP_PORT` 可覆盖启动器端口，默认 30000，测试可以设为 0。
- `RPGMAP_WORLD_ID`：启动指定 World；没有覆盖时由持久化目录恢复活动 World。

服务开始监听后，发送 `process.parentPort.postMessage({ type: 'rpgmap:ready', port })`。正常退出接受 `{ type: 'rpgmap:shutdown' }`，完成写入并关闭端口。切换 World 或恢复当前 World 时，先发 `{ type: 'rpgmap:restart', worldId }`，正常退出；修改端口时此消息增加 `port`。桌面壳等待旧进程退出后启动新进程。

管理 API 使用 loopback、同源检查和 HttpOnly `rpgmap_manager` Cookie。秘密只在主进程与服务之间流动；主进程导入请求使用同源 `Origin` 和固定 `X-RPGmap-Manager`。`/api/manage/catalog` 的 `connection.localUrl` 或 `hostUrl` 提供当前 GM 地址。

preload 只暴露启动 World、选择并导入内容、打开指定数据目录、返回首页、打开指定游戏地址、选择校验过的安装器和退出。每个 IPC 操作验证发送者为当前窗口的同源主 frame；不暴露任意路径、任意 URL、命令执行或原始 IPC。窗口启用 sandbox/contextIsolation，禁用 Node 集成、新窗口、WebView、跨来源导航和权限请求。

旧版数据目录导入由主进程打开原生目录选择框，再向 `POST /api/manage/worlds/import-directory` 提交选中的绝对路径。网页不能提供路径参数；服务器只接受本机桌面管理秘密，普通 GM 会话没有读取任意本机目录的权限。成功前保留原目录，由服务端复制、回放 WAL 并校验。

## 更新与恢复

管理页可选择符合命名规范的本地安装器。必须存在同目录 `SHA256SUMS.txt` 对应记录且哈希匹配；该校验保证文件完整性，不认证发布者。用户确认后先保存并停服，再运行安装器。

NSIS 更新仅按旧程序的 `PROGRAM-FILES.txt` 删除程序文件，并先完整复制旧载荷到 `%LOCALAPPDATA%\RPGmap\ProgramRecovery`；复制失败则终止删除。该目录内包含旧程序及原安装目录记录，可用于人工恢复。它不代替 World 格式升级前的存档恢复点。用户存档、地图/规则、上传和备份位于独立 UserData，卸载也保留。

直接运行安装器或卸载器时，先通过 `--rpgmap-exit-existing` 单实例消息请求当前启动器正常保存并退出，最多等待 30 秒；仍在运行就停止安装，不调用强制终止进程。

每次启动先根据安装清单校验前端、服务端与桌面壳的 SHA-256；不完整的程序不会启动服务或写入游戏状态。窗口和管理 API 就绪后才更新 `UserData/config/last-successful-program.json`。更新中断后可使用完整的旧程序恢复目录或重新运行安装器；首版尚不自动回滚 NSIS 文件替换，也没有将同版本覆盖测试作为跨版本或中断测试的证据。

本机安装、覆盖升级、卸载重装与独立浏览器玩家主流程已有候选基线验证；干净 Windows、真实安装中断和 VPN 多机未执行。正式构建须针对实际产物另行检查，不能用目录构建或单元测试替代安装行为。当前验证边界见 [CHANGELOG](../CHANGELOG.md)。

## 正式发布

Release 仅提供安装器、Lanzhou-1.1.0.rpgmap、SHA256SUMS.txt 和 README.md（使用说明），地图和说明使用中文显示标签。node scripts/desktop-release.mjs assemble 汇总正式文件并写冻结凭据，verify 校验清单、源提交和载荷；构建记录保留在 artifact/，不作为下载资产。完整参数见[开发与制图说明](../文档/RPGmap-v3.0.0-开发与制图说明.md)。

程序包不复制 maps/、素材库、测试、候选报告或用户存档。正式发布使用验收后的相同字节，不能在上传前重新构建或改名复用 RC 安装器。
