# 地图制作项目

`lanzhou/` 是兰州地图的唯一制作源：历史声明、固定的 v2.5.5 几何/SVG，以及实际绑定的贴图。`minimal/` 是通用接口验收地图。地图运行版本分别保持 1.1.0 和 1.2.0；`.rpgmap` 归档格式版本为 1。

地图项目只负责地图声明和资源。人物、Token、开门与破坏的当前状态、Fog 和进度保存在用户 Scene 中。导出不会把游玩存档写进地图包。

```powershell
npm run export:maps -- --out artifact/RPGmap-v3.0.0-rc.2-验收
```

兰州导出使用固定的 `runtime.json`、`runtime.svg` 和 `assets.js` 依赖清单，仅读取实际引用的资源。公共制图素材见 `../素材库/资源索引.json`，只将所需素材复制到各地图项目的 `assets/`。安装器构建不读取制图项目或整个素材库。

新增地图可以使用 `buildMapArchive({data,svg,assets,metadata})`；导出前、导入时都使用同一个 `inspectMapArchive` 验证器。地图 ID 与地物 ID 要稳定；内容改变必须升地图版本。门洞、阻挡多边形、视线轮廓、门的宿主、废墟资源须显式声明。不可用可执行脚本描述地图。

原 `reference/maps/` 已迁入本目录。`src/maps/` 与 `src/map-package/default-map.js` 仅保留旧制作/测试 API 的转发，不在正式运行入口装配地图。
