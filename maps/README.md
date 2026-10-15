# 地图制作项目

lanzhou/ 是兰州唯一制作源，包含固定的 v2.5.5 几何/SVG、声明与实际贴图，地图版本保持 1.1.0。minimal/ 是验证通用接口、导入和多地图的长期夹具，版本为 1.2.0。两者使用地图归档格式 1。

地图项目只负责画面、地物几何、物理能力和默认声明；Actor、Token、当前门状态、破坏、Fog 与进度属于 Scene，不写回地图包。

~~~powershell
npm run export:maps
npm run export:maps -- --fixtures
~~~

默认只导出正式兰州到 artifact/content-packages。--fixtures 额外导出最小地图到 fixtures/，供开发检查，不随 Release 交付。可用 --out 指定其他输出目录。

兰州导出使用固定 runtime.json、runtime.svg 和 assets.js，仅读取实际引用资源。公共制图素材在[素材索引](../素材库/资源索引.json)；安装器不读取制图项目或整个素材库。

新地图参考 minimal/，用 buildMapArchive({data,svg,assets,metadata}) 导出并经 inspectMapArchive 校验。保持地图 ID、地物 ID 稳定，内容变化升级地图版本，明确门洞、宿主阻挡、视线轮廓、高度与废墟资源。包中不执行脚本。

完整契约见[开发与制图说明](../文档/RPGmap-v3.0.0-开发与制图说明.md)。src/maps/ 与 src/map-package/default-map.js 仅保留旧源码兼容转发，不是桌面生产地图来源。
