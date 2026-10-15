# RPGmap v3.0.0 开发与制图说明

应用、地图、规则和存档分别管理版本：应用 3.0.0；World schema 4；无限规则 infinite-horror@1.1.0；兰州 northern-song-lanzhou-1104@1.1.0；地图归档格式 1。正式版本须从最终源提交独立构建并验证，不改名复用候选安装器。

## 1. 四层与运行接口

| 主层 | 实现与职责 |
| --- | --- |
| 整体层 | desktop/ 生命周期；src/app/ 管理首页；src/ui/ 游戏界面；src/hosted-main.js 生产装配 |
| 运行层 | src/runtime/ 会话和地图装配；movement、spatial、vision、damage、render、world、documents 等专用核心与环境适配 |
| 规则层 | src/ruleset/ 契约与注册；src/rulesets/ 具体规则；外部受信任 .rpgrules |
| 地图层 | maps/ 制作项目；src/map-package/ 契约；外部只读 .rpgmap |

src/contracts/、src/adapters/ 和 deployment/local-server/ 支撑共享契约、网络、存储与环境适配，不增加第五个业务层。源码按职责拆分，发布可合并；不以文件越少为目标。

纯会话 src/runtime/core/session-base.js 不依赖 DOM，以显式注入的权威端口提供命令、只读查询、变更订阅和销毁。共享浏览器装配在 map-runtime-base.js，生产装配在 hosted-map-runtime.js。旧路径可转发，不能维护第二份 World 或物理地图。

生产 index.html 只启动服务器管理与运行环境；服务不可用时明确报错，不回退离线裁决。standalone.html、src/main.js 和离线适配继续承担旧兼容回归，不进入桌面生产载荷。新增 UI 通过权威 Document 命令修改数据，不直接改 World。

规则实例由 World 注入；Core 只消费通用能力和规则提供的派生、呈现、操作，不读取无限私有生命或感知字段。地图和规则不依赖 UI。

## 2. 权威数据、权限和空间

World 共享 Actor、规则、聊天和资料，包含多个 Scene；每个 Scene 固定地图 ID 与版本，保存独立 Token、featureStates、sceneEvents、Fog、标记和设置。服务端和浏览器加载相同版本、相同内容指纹的地图。缺失地图明确失败，不用兰州默认尺寸或仅边界地图代替真实碰撞。

同地图多 Scene 也必须隔离缓存身份；跨地图或同 ID 不同版本切换先取消旧输入、预览与 Worker，再重建 Runtime。首版所有玩家共用一个活动 Scene，不自动搬运 Token。

World schema 4 是唯一持久化权威。普通操作为 operation schema 4 的 Document batch，客户端只提交注册的 intent，不接受任意 JSON path。服务器重新校验权限、引用、地图碰撞及 precondition，WAL 持久化完成才 ACK，再按会话发送 Audience-safe create/update/delete/move/append。完整快照只用于初始化、恢复导入、无法续传、权限身份变化或跨地图重载。

保持 operationId 幂等、revision 连续、断线续传和错误边界；未知或损坏载荷必须失败。渲染失效信息是派生提示，不能成为另一份权威状态。受保护实体不能通过聊天、战斗、图片引用或查询旁路泄漏。

Actor 是模板，Token 是场景实例。Linked Token 使用共享 Actor；怪物、NPC、召唤物强制 Unlinked，生命、资源、形态与效果写入自身 actorDelta。实例运行操作缺少 tokenId 必须报错。Actor OWNER 不自动获得非 PC 实例控制权；战斗按当前 tokenId 锁定普通玩家。

空间水平坐标由地图定义并通过 metersPerUnit 换算；高度、距离、速度和范围统一米。障碍判定为 Token 高度严格大于顶部才越过，等高仍受阻。navigation 与 vision 可有不同轮廓与高度；开门不能清除重叠的独立墙体。服务端逐段检查单人和群组路线、能力及回合预算，任一成员失败不提交整组。

Fog 按 Scene/队伍保存历史，每个会话仅一个实时视野来源；移动确认后才保存沿途探索。权限投影和视野来源不写回 canonical World。迷雾不承诺隐藏已经下载的地图底图。

## 3. 地图与素材契约

地图包是 ZIP 格式的 .rpgmap，单包对应一个只读模板，可创建多个 Scene：

~~~text
manifest.json
map.json
map.svg
assets/
preview.webp    可选
README.md       可选
~~~

manifest 记录身份、版本、兼容信息、文件清单及校验。map.json 保存稳定 featureId、几何、能力、导航、视线、高度、默认门状态、宿主和废墟绑定；map.svg 按同一地物 ID 绑定画面。不包含 Actor、Token、探索、战斗和进度，不执行制图脚本。

地物的 capabilities.destructible、navigation.blocks / blockingPolygon / blockingHeightMeters、vision.occluder 及对应轮廓、高度应显式声明；实际嵌套结构以 src/map-package/contract.js 与 maps/minimal/package.js 为准。门洞必须贯穿宿主阻挡几何。外观、碰撞、视线轮廓可以不同，不能仅凭一张扁平 PNG 自动补出破坏后的地面。

默认声明在地图包，临时门状态和 GM 覆盖在 Scene featureStates，破坏/恢复/撤销在 sceneEvents，Token/探索在 Scene。剩余几何、导航和当前视野为可重建缓存。废墟和原物体沿用同一个地物 ID，不创建第二游戏实体。

SVG 中地物使用稳定 data-feature-id，图层使用 data-layer；运行时状态钩子包括 data-feature-state、data-feature-damaged 和 data-interaction-open。地图自己的中文分类在 featureTaxonomy 中提供，Core 对未知分类显示原 ID，不按兰州类别分支处理。

常用逻辑层为 base、terrain、liquid、structure、special、destructible、labels，可通过 layerPlan.sourceLayers 映射真实 SVG 层。兰州历史 terrain 子层可嵌套于 base，不要求扁平重排画面。

SVG 必须静态，使用标准 SVG namespace 和必要的 xlink/xml 前缀。脚本、动画、外部资源、非标准 namespace 和带转义的 CSS 会被拒绝；从绘图工具导出普通 SVG，资源引用仅指向包内。导入检查路径、哈希、兼容性、重复 ID、几何、门宿主和废墟绑定，再暂存、原子安装与注册。

地图注册按 ID+版本+指纹管理：同版本同内容复用，同版本不同内容拒绝，多版本并存。Scene 固定版本，安装新版不自动迁移。卸载检查 World、Scene 和恢复点引用，不自动删存档。制作内容改变必须升地图版本；不要把游玩状态导出为新默认。

maps/lanzhou/ 是唯一兰州制作源，导出使用固定 runtime.json、runtime.svg 和 assets.js；maps/minimal/ 为解耦、多地图及包导入的长期夹具。公共素材索引为 素材库/资源索引.json，记录稳定 ID、尺寸、SHA-256、用途、来源和废墟对应；只将实际依赖复制进地图，不打包素材全集。

新地图从最小项目参考制作，使用 buildMapArchive({data,svg,assets,metadata}) 导出，inspectMapArchive 校验。包内 Feature 只声明内容与能力，不复制 Movement、Damage、Navigation 或 Interaction 系统。地图行为由共用 Runtime 执行。

## 4. 规则包、恢复与更新

规则 .rpgrules 由清单、契约兼容要求、规则入口、必要资源及迁移声明组成。首版仅支持信任作者的本项目契约代码，不提供第三方沙箱或 FVTT 插件兼容。

无限规则 infinite-horror@1.1.0 随应用维护，拒绝同 ID/版本的外部覆盖。新增内容用新版本，World 固定引用，不自动迁移。外部 entry.mjs 可引用包内 modules/*.mjs，服务端按内容指纹隔离整个模块图；卸载检查 World 与恢复点引用，卸载后保留同版本指纹冲突保护。

地图“恢复环境”和“清空场景”分别使用 scene.environment.reset 与 scene.clear；正式 UI 不使用旧 scene.reset。先成功建立恢复点再权威提交，备份失败不执行。恢复环境保留实例、标记、模板、战斗和设置，重置门/破坏/覆盖/探索；清空还移除场景内容和关联战斗并恢复设置。二者保留 Scene 身份、地图版本及其他 World 数据；重置后取消旧任务并重建空间缓存，冲突 Token 由 GM 调整。

用户数据在 %LOCALAPPDATA%\RPGmap\UserData，程序目录仅保存安装清单列出的程序文件。旧 map/ 导入只允许桌面受限接口选择目录，复制原 World、WAL、权限、上传和备份，在副本迁移校验后登记；不修改原目录。网页没有任意磁盘路径权限。

需要格式迁移时先完整恢复点，在副本迁移与校验后切换；恢复使用可恢复多文件事务。安装更新只按 PROGRAM-FILES.txt 清理旧程序，并保留旧程序恢复副本，不删用户数据。首版下载安装器覆盖更新，没有在线自动下载或 NSIS 自动回滚。

## 5. 构建与正式交付

固定构建基线 Node.js 24.19.0/npm 11.17.0；Electron、electron-builder、Vite 等精确版本由 lockfile 锁定。安装版用户无需这些开发工具。

~~~powershell
npm ci
npm test
npm run build
npm run check:bundle -- . --strict-budget
npm run package:desktop
npm run export:maps
~~~

地图和规则默认输出 artifact/content-packages；导出夹具时额外传 --fixtures，最小地图和规则放 fixtures/，不进入正式 Release。地图制作脚本不会在安装器内嵌运行地图。

正式交付使用以下入口，源提交必须是完成测试与审查的干净提交：

~~~powershell
node scripts/desktop-release.mjs assemble --installer=artifact/desktop/RPGmap-Setup-3.0.0.exe --map=artifact/content-packages/北宋兰州城-1.1.0.rpgmap --instructions=文档/操作指南.md --receipt=artifact/desktop-build-receipt.json --stage=artifact/desktop-stage --output=release/RPGmap-v3.0.0 --frozen-receipt=artifact/desktop-release-receipt.json
node scripts/desktop-release.mjs verify --directory=release/RPGmap-v3.0.0 --receipt=artifact/desktop-release-receipt.json --stage=artifact/desktop-stage --version=3.0.0 --commit=<完整源提交>
~~~

最终目录恰好包含安装器、兰州地图、SHA256SUMS.txt、使用说明.md。构建记录和冻结凭据放 artifact/，测试附件和报告不随 Release 分发。INSTALL-MANIFEST.json 记录源提交、dirty 状态、工具版本及载荷校验，PROGRAM-FILES.txt 约束清理范围。先验证实际构建文件并冻结，再发布同一字节；发布阶段不能重新构建。

测试保留核心权限、碰撞、Actor/Token、多地图版本、导入安全、恢复、WAL、幂等和升级回归。应用 JS/CSS 使用原严格门槛，Electron 运行库单独统计。七会话后端确认、广播与真实浏览器帧率是不同指标，本机回环不能称为 VPN 多机。长任务失败和未测环境的当前说明见 CHANGELOG。

增量失效从权威 Document changes 与提交前后数据推导受影响对象和区域，聊天及名称变化不触发空间更新；未知变化完整重建。视野按真实影响区域计算，不能仅局部重画门周围。缓存键包含 World、Scene、地图 ID、版本、内容及相关计算版本，销毁时释放 Worker、监听器和资源。

过程日志、旧候选目录、性能 trace 和一次性诊断数据不属于源码。长期回归测试、夹具、性能门槛和构建校验工具必须保留。清理目录链接或基线工作树前先核对路径和 Git 登记，不递归跟随目录链接删除目标。
