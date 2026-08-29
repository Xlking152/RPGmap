# RPGmap Windows 本机 / 局域网运行时

这是 Windows 发布包的唯一启动入口。双击 `start-rpgmap.bat`；启动器会启动服务器、使用系统默认浏览器打开 GM 页面，并显示 Local URL、LAN URL、Join Code 与 GM Secret。

- 把 LAN URL 与 Join Code 发给 Player；GM Secret 只由 GM 保留。
- 数据保存在 `map/world.json` 与 `map/users.json`；写入前会生成滚动备份到 `map/backups/`。
- JSON 损坏时服务会隔离文件并停止，避免空状态覆盖原存档。
- 不支持 Internet/Public、Quick Tunnel 或 cloudflared。

完整操作、权限与故障排查请打开 `docs/OPERATION-GUIDE.md`。

源码仓库中的 `reference/` 不会复制进发布 ZIP；默认兰州地图已经编译到 `app/` 的动态 chunk 与 assets 中。运行时根目录由 package verifier 严格限制，除 `map/uploads/`、`map/backups/` 外不应增加临时或开发文件。
