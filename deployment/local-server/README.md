# RPGmap Local Server

这是 RPGmap 当前自托管服务器路线的本地 / 局域网测试启动包。

## Windows

1. 安装 Node.js 20.19+ 或 22.12+。
2. 双击 `start-rpgmap.bat`。
3. 浏览器会打开 `http://127.0.0.1:30000`。
4. 同一局域网设备可以使用控制台中显示的 `Network` 地址访问。

> Windows 启动脚本使用纯 ASCII 文件名和纯英文控制台提示，避免 ZIP 解压和系统代码页造成 BAT 文件名或内容乱码。

## Linux / macOS

```bash
chmod +x start-rpgmap.sh
./start-rpgmap.sh
```

## Release 包内容

版本化 Release ZIP 只包含运行所需内容：

- `public/`：GitHub Actions 预编译的 Web Client。
- `server.mjs`：当前零第三方运行依赖的 Node HTTP Server。
- `start-rpgmap.bat` / `start-rpgmap.sh`：启动入口。
- `data/`：未来 World Store、上传和备份的数据目录。
- `docs/FUTURE-ROADMAP.md`：服务器化后续规划。
- `VERSION.json`：应用版本与 Commit 信息。

不会包含 `.git`、`node_modules`、npm cache、tests、源码、构建缓存、历史参考或日志。

## 当前限制

当前 Server 仍属于服务器化过渡阶段：

- HTTP Server 已真实运行，不依赖 `vite dev` 或 `vite preview`。
- `/api/health` 与 `/api/version` 可访问。
- Actor / Token / Scene 长期状态暂时仍主要使用浏览器 localStorage。
- World Store、WebSocket、GM / Player 权限和多人同步尚未接入。

完整路线见仓库 `文档/未来规划.md`。

GitHub Release 使用应用版本号，例如 `v1.2.0`，不再使用连续 CI / Server 构建编号作为产品版本。