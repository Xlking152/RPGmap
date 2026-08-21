# RPGmap

RPGmap 是一个面向 TRPG / VTT 的浏览器端自托管跑团平台，目标是逐步发展为类似 Foundry VTT 的可扩展地图、角色、战斗与多人联机系统。

当前开发版本：**V1.4.3 Candidate**。稳定 `main` 在该 Candidate 合并前仍保持 V1.4.0；V1.4.1 的 Player Identity / Ownership 与 V1.4.2 的 `app / world / maps` 结构均继续继承。

> 本 README 只负责项目整体说明。发布 ZIP 内实际操作文档为根目录 `操作说明.md`。

## V1.4.3：单 BAT + PowerShell Runtime + Web Launcher

Windows 发布包唯一入口：

```text
RPGmap.bat
```

启动链路：

```text
RPGmap.bat
    ↓
PowerShell Runtime 信息窗口
    ↓
Node.js launcher/launcher.mjs
    ↓
浏览器 Web Launcher / GM Control Center
```

### PowerShell Runtime 信息窗口

PowerShell 只承担最简单、最稳定的 Runtime Host：

- 查找 Node.js；
- 保持 Launcher Node 进程运行；
- 显示 Launcher / Server / Tunnel 实时输出；
- Server 启动后直接显示：
  - Local URL；
  - LAN / Network URL；
  - Internet Public URL；
  - Join Code / 房间号；
  - GM Secret；
  - World / Maps 路径；
  - Build / READY；
- 显示后续 Server / Tunnel 日志。

该窗口可以最小化，但运行 RPGmap 时应保持打开。

### Web Launcher / GM Control Center

真正的交互全部留在浏览器：

- Local / LAN / Internet Server 启停；
- Local / LAN / Public URL；
- Join Code；
- GM Secret；
- Player Invite；
- Server / Tunnel 日志；
- pending Player approve；
- User create / update / delete；
- Default Actor；
- NONE / OBSERVER / OWNER；
- Player Key rotation。

Launcher 不直接修改 `world/users.json`，而是使用隐藏的本机 GM WebSocket Session 复用 Server `access.*` 权限协议。

## 为什么撤回 Native EXE

V1.4.3 Candidate 曾实现轻量 `RPGmap Launcher.exe`。虽然自动化 Windows 环境能够运行，但真实设备出现启动反馈不直观、端口冲突诊断成本高等问题。

因此当前明确采用：

```text
RPGmap.bat + PowerShell Runtime + Web Launcher
```

Native EXE 不进入发布包，也不再维护额外 Windows C 启动壳。

## Node.js

当前要求：

```text
^20.19.0 || >=22.12.0
```

PowerShell Runtime 查找顺序：

```text
tools/node/node.exe
→ 根目录 node.exe
→ 系统 PATH node.exe
```

因此未来可以直接把 Portable Node 放入 `tools/node/`，而无需改变启动架构。

## 动态 Launcher 端口

Launcher 只绑定 `127.0.0.1`。

首选：

```text
29999
```

冲突时自动尝试：

```text
29998 → 29997 → 29996 → 29995
```

仍不可用时交给 Windows 自动分配一个空闲 loopback 端口。浏览器会自动打开最终地址，不需要强制关闭其他进程。

Game Server 默认仍为：

```text
0.0.0.0:30000
```

Cloudflare Tunnel 只转发 Game Server，不转发 Launcher 管理端口。

## 未来管理中心

Launcher 首页已经预留三个禁用模块：

- **World Manager**：World 选择 / 创建 / 复制 / 归档 / 启动；
- **Scene Manager**：Map Registry / MapPackage / Scene 切换；
- **Backup Center**：Snapshot / 自动备份 / 恢复 / 导入导出。

完整完成状态见 `文档/未来规划.md`。

## 发布包结构

```text
RPGmap-v1.4.3/
├─ RPGmap.bat
├─ 操作说明.md
├─ app/
├─ launcher/
│  ├─ rpgmap-runtime.ps1
│  ├─ launcher.mjs
│  ├─ admin-client.mjs
│  ├─ index.html
│  ├─ launcher.js
│  └─ launcher.css
├─ server/
├─ world/
├─ maps/
├─ tools/
├─ docs/
└─ VERSION.json
```

发布包根目录固定为 **1 个 BAT、0 个 EXE**。

## app / world / maps

长期语义：

- `app/`：程序是什么；
- `maps/`：地图 / Scene 本身是什么；
- `world/`：这一场游戏里发生了什么。

### world/

```text
world/
├─ state.json
├─ users.json
├─ uploads/
└─ backups/
```

World / User 默认不会写入 AppData 或其他隐藏用户目录。

### maps/

`maps/` 留给真实 Map / Scene 资源。地图模板中的建筑、碰撞、破坏阶段属于 `maps/`；某场 Campaign 中建筑当前 HP、燃烧、坍塌等实例状态属于 `world/state.json`。

## Player Identity / Ownership

```text
Session → Persistent User → Default Actor / Ownership
```

Player 首次进入为 pending；GM approve 后创建持久 User。Actor 权限为 NONE / OBSERVER / OWNER；GM 对全部 Actor 隐式拥有完整权限。Combat active 时 Player 只能修改当前 Turn 对应的 OWNER Actor。

## Multiplayer

当前包括原生 WebSocket、World Snapshot、revision / baseRevision、Presence、Persistent User、Actor Ownership、Combat Turn Lock、Cloudflare Quick Tunnel 和 Launcher GM Admin Session。

当前 Ownership 是控制权限，不等于数据隐私；未来 GM-only / 隐藏 NPC 数据需要 per-user filtered snapshot 或 document-level visibility。

## 未来推荐顺序

```text
1. V1.4.3 实机验收
2. World Manager
3. Map Registry + Scene Manager
4. Scene Instance
5. Backup Center
6. 可破坏建筑 / 环境状态
7. Snapshot → operation / patch
8. Dice / Target / Fog / Vision
9. Named Tunnel / 固定公网部署
```

V1.4.3 当前保持 Candidate / Draft，完成实际设备验证后再进入 `main`。
