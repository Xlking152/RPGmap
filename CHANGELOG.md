# Changelog

## v2.5.5

- 统一运行时 `scene-ruins` 废墟层：局部、整体和严重破坏使用原物体世界位置上的固定纹理与并集遮罩，保留孔洞；废墟图片不产生实体、遮挡或碰撞属性，移除随机切口和逐片装饰碎片。
- 修复开启视野后破坏建筑触发 `SweepEvent` 裁剪错误：建筑外观采用显示遮罩合成，灯光不再计算建筑外观差集；真实墙体和门洞几何仍独立决定遮挡。
- 建筑、独立墙段或门被单次攻击覆盖原始面积至少 95% 时整体破坏；不累计攻击、不扩展相邻墙段，连续地表仍按实际范围处理。检查面板支持选中对象“整体破坏”和“恢复此对象”，新增受损对象列表。
- 单对象恢复保留其他损坏、独立弹坑、门状态和手工 Tag 配置。严重破坏继续沿用弹坑、困难地形及进水规则；旧存档从已有破坏事件派生废墟显示。
- 修复直接破坏／恢复按钮的新事件被旧 World 投影覆盖却提示成功的问题；事件和状态副作用同批权威提交，失败完整回滚。独立 Token 的交互状态只写入自身实例，不污染模板或其他同源 Token。
- 范围编辑、拖动和范围破坏等待权威提交确认；历史或场景已改变时拒绝旧请求，防止并发操作覆盖已确认破坏。地物界面复用当前修订的只读状态，消除逐个地物重复复制整个 World 的开销。
- 内置规则的完整保存校验在独立 Worker 中执行，保留原始输入检查、全部迁移和错误报告；自定义规则、上下文变化或 Worker 故障回退完整本地校验。串行核对当前修订后才写入，取消和销毁阻止旧结果覆盖新状态。减少状态、Fog 和目录同步中的重复复制；连续遮挡变化复用视野 Worker。
- 缓存不变的地图几何签名；内部只读状态复用已校验的 Fog、Actor 和未改变场景内容，减少移动、状态更新与破坏／恢复的重复计算。公开接口、动态遮挡规则和权限校验保持兼容。
- 无视野来源的公共聊天复用已过滤的增量，避免旧缓存元数据触发完整广播投影；仍检查当前权限、地图和非聊天字段，不推进旧缓存的权威前驱。普通 Token 移动复用未变化的灯光来源，实际灯光变化仍重新计算。
- 阴影准备复用不可变轮廓的绕向并减少临时数组；Canvas 在原完整画布栅格化后缓存需要复制的整数像素区域，复用薄雾颜色层，保留边缘精度和分数尺寸回退，像素缓存固定最多三块并在重置／销毁时释放。
- Fog 首次写入规范网格区间时省去重复排序及临时数组；跳过与待探索格子无交集的阴影区间，保留相切射线检查和极大坐标的原始计算；完整视口和灯光合成复用整数像素拷贝，分数尺寸仍保留原重采样。
- 后台探索按版本传输 Fog 变化行，已校验且未改变的历史行不重复复制；待提交行仍完整传输。八队伍缓存有界，重置、版本失配或 Worker 故障后完整重建，不缓存未确认的计算结果。
- 离线探索按任务原场景读取已确认 Fog，跳过已探索格子的重复遮挡计算，仅提交新增区间；空增量完整校验并保存队列进度，避免无效 World 刷新。内置规则复用已经派生的角色视野，自定义规则保留原调用语义；权威批量重置共享不变的只读网格，兼容数据仍完整规范化。
- 网格仅随视口或间距变化重建，Fog 和破坏状态刷新复用已有线段；缩放、平移和窗口变化统一更新网格与标签。独立地图标签批量读取位置，减少交错读写 SVG 导致的重复布局；嵌套轮廓和内联文字保留原测量顺序，没有可见标签时省去障碍物测量。
- 新增可选 `artAssets.ruins` 普通／严重资源与对齐配置，缺失资源使用兼容纹理；项目制图素材库不随安装包发布，也不被运行时扫描。
- 几何清理退化边，已知裁剪异常按局部米制两档有限重试；新破坏提交前严格检查，失败保留原状态并标明对象。旧异常数据保守遮挡且允许恢复。派生几何缓存每地图最多 512 项、每对象两个版本。
- 新增兰州地图复现、破坏／恢复、几何故障、缓存、Chrome 存档重载和连续操作验收；保留 v2.5.4 的精度、采样、权限及延迟门槛。

## v2.5.4

- 修复取整投影导致部分缩放档位全迷雾；实时视野使用连续圆形和真实轮廓阴影，整帧替换遮罩，历史 Fog 继续 5 米网格与每 2.5 米沿途采样。
- 统一遮挡 Tag、场景覆盖和高度规则，修复未声明高度漏挡、修改高度无效、显式关闭被地图默认覆盖及旧遮挡列表压制场景开启 Tag。保留门洞、局部破坏、透视、光照和权限。
- 增加 GM 遮挡编辑器、形状差量同步与配置导入导出；绑定轮廓替代默认几何，门按钮、视线和权威操作共用初始开门状态。Token 仅忽略包含自己的最小建筑，灯光及其他障碍不受豁免影响。
- 联机移动与私有探索任务同条 WAL 落盘后确认，Node Worker 后台轮转补齐 Fog，支持崩溃恢复、世代取消及 Fog 专用差量。本地也原子保存移动和待探索路径，刷新后继续。
- 增加遮挡能力版本检查，阻止旧客户端静默采用不同视野规则；旧 World 存档仍可导入。主机与玩家请统一升级到 v2.5.4。
- 减少逐玩家未变化文档的差量遍历、重复视野描述和后台 Fog 复制；删除未使用的构建插件，不增加运行依赖。
- 阴影逐行扫描复用临时数组和固定边计算，保留精确边界判定；重叠建筑同面积时按固定 ID 次序选择，避免主机与浏览器语言区域差异。
- 周期性快照在移动确认后串行保存最新 World 与探索队列，再截断 WAL；失败保留日志重试，不确定的日志写入或截断失败暂停写入。减少无效增量投影准备及重复状态哈希，缓存保持有界且不复用玩家权限结果。
- 已验证权威聊天提交只复制聊天容器，避免重复复制和校验全部 Token；混合批次和自定义钩子保留兼容路径。修复场景切换裁剪冻结战斗列表时失败的问题，普通联机验收分别检查移动、状态和聊天延迟。
- 固定主机规则集复用已验证的 Actor／状态移动输入，缓存最多 64 项并随场景、Actor、定义和规则变化清空；碰撞、预算、权限和移动能力仍逐次检查。自定义规则、独立实例及时间依赖的旧数据保持完整解析。
- 射线判定复用不可变轮廓的边差值和包围盒，减少重复遍历与分配；保留原浮点运算顺序、孔洞、碎片及稳定首次命中结果。
- 未移动观察者的投影差量复用服务器确认的变更索引，减少重复扫描全部 Token；权限、检测类别、集合顺序或 ID 冲突时保留完整比较，资格仅属于同一玩家的确切前后投影。
- 合并重复的玩家 Token 权限判定，只读检查直接读取当前运行状态，避免移动和重连重绘时逐 Token 复制整个 World；所有权、战斗轮次、实例控制者及放置权限仍逐次判断，公开快照继续返回独立副本。
- Worker 完整遮罩与动画、Fog、视口更新合并到下一帧统一绘制。联机续传指纹按当前接收者完整权限记录确定，其他玩家的记录变化不再迫使全量重载；本人权限、来源、身份、规则 schema 或私有 ID 范围变化仍使旧指纹失效。
- 对齐像素的连续遮罩只清理和混合视野周围区域，分数像素视口保留完整重采样路径；像素对照同时检查每组的两帧，保留边缘、光照与阴影精度。
- 视野与只读权限路径使用轻量连接状态，避免每帧复制完整访问表；完整联机状态接口保持独立副本。增加默认关闭的 Chrome 主线程采样，诊断数据不得用于正式验收。
- Fog 提交复用已验证的不可变棋子集合及 Actor／状态定义依赖；同一玩家来源最多保留两个位置、每个位置最多 1,024 条几何射线，光照、范围与权限仍逐次判定。来源、几何、比例及非位置视野规则变化重建，玩家之间不共享结果。
- 完整投影沿用既有 ID 检查生成同一玩家确切前后集合的变更索引，避免差量层重复建立 ID 映射；成员、顺序或 ID 冲突变化仍执行完整比较，不省略可见性与权限判定。
- 状态完整投影复用确切权威前驱的私有几何和未变化数据，始终重新计算各目标感知与光照；无视野来源的投影同样校验前驱，防止旧 Fog 回写。探索期间状态／聊天版本冲突最多重试三次，保留首次提交计时和同一操作 ID，权限、目标及前置条件重新验证。
- 大范围联机验收新增探索期间其他玩家的状态／聊天响应及 WAL 活跃任务证据；发布流程核对 Chrome 全部 DPR、视野范围与原始耗时、双帧像素及开发／生产审计，拒绝缺失或矛盾的报告。
- 公共聊天纯追加在验证所有非聊天数据与来源描述不变后接续私有投影缓存；达到 500 条裁剪上限、包含受保护数据或条件变化时执行完整投影，修复旧消息残留。

## v2.5.3

- 视野遮挡预处理加入有界场景缓存与空间索引；阴影栅格化复用活动边，精确与模糊视野共享遮挡结果，保留原有射线边界、高度、孔洞、门和破坏规则。
- 425 米沿途探索继续每 2.5 米取样、记录 5 米 Fog 网格；已探索区跳过重复判定，新增区间批量合并。长探索分片执行，切换来源、场景、导入或重置时使旧任务失效。
- 实时视野任务按场景版本复用 Worker 几何输入；渲染层按状态版本复用快照和历史 Fog，只绘制视口内行区间，减少重复归约、复制与绘制。
- 联机服务端共享可重建的几何和灯光上下文，探索通过可让出事件循环的异步归约提交；权限与逐用户投影继续独立，WAL 成功后才确认操作。
- 删除重复的行区间合并逻辑，并补充视野精度、异步取消及权威操作回归。存档与客户端通信 schema 不变；联机主机和玩家请统一升级至 v2.5.3。

## v2.5.2

- 包含 v2.5.1 的大范围视野后台计算、逐行建筑阴影与共享角色解析优化。
- 修复并发探索漏记、省略场景 ID 时探索失效，以及完整 World 替换后的旧探索结果回写。
- 修复 Worker 构造、消息读取、发送失败与销毁后的生命周期处理；合并主线程与 Worker 的视野计算。
- 修复照明网格计算未遵守关闭 LOS 配置的问题，删除未使用的旧状态徽章模块。
- 存档与通信 schema 不变；联机主机和玩家请统一升级至 v2.5.2。

## v2.5.1

- 修复大范围视觉遮挡与沿途探索同步计算阻塞主线程的问题；实时视觉及本地探索改为后台计算。
- 地面视野按行栅格化建筑投影阴影，保留逐格射线边界语义和原有 2.5 米探索采样；后台结果不回写旧 Token 坐标。
- 新增千米视野下 Token 放置、425 米连续移动和界面响应验收；首屏与 ZIP 门槛不变，后台计算代码允许增加 16 KiB 压缩 JS。
- 状态更新复用共享角色解析，保留逐 Token 与独立实例判定，减少联机状态同步耗时。
- 存档及通信 schema 不变；联机主机与玩家需统一升级至 v2.5.1。

## v2.5.0

- 单机与联机移动均由已提交路径驱动动画，避免旧位置入队导致 Token 回弹；新路线替换未完成的旧路线。
- 本地探索取消过期角色和地图任务，保持建筑视线遮挡、透视与灵体移动能力分离。
- 支持本地验收候选 ZIP 后由云端核验发布；主机与玩家需统一升级，存档及通信 schema 不变。

## v2.4.5

- 修复城门地图按钮无法打开的问题：GM／单机管理者无需选择 Token 即可直接开关，玩家仍需使用受控且靠近城门的 Token；距离按 Token 外缘到城门轮廓计算，支持城门两侧操作。
- 视觉遮挡现在默认应用于角色的精确与模糊视觉；只有角色具备“透视”时才可在感知范围内看见完整圆形区域。透视不改变范围、光照、移动或碰撞规则。
- 兰州建筑加入视觉遮挡，旧的场景／玩家关闭遮挡配置不再绕过角色视觉；局部破坏、开门、恢复和联机迷雾探索均使用权威角色视觉规则。
- 移除场景及联机用户面板中的关闭视线遮挡入口，保留旧字段兼容读取。应用版本升至 `2.4.5`，存档和通信 schema 不变。
- 总 JS gzip 预算增加 1 KiB 以覆盖城门授权与透视视觉判定，首屏与 CSS 预算保持不变。

## v2.4.4

- 修复兰州建筑完全摧毁或局部破坏后仍阻挡移动的问题；已破坏区域可通行，残余建筑、重叠障碍和 Token 体积限制继续生效。
- 局部破坏缺口现在同时透过视线和光照，保留残余墙体、内部孔洞及遮挡高度；客户端和联机玩家可见性使用同一空间内核。
- 保留爆坑移动消耗、积水和断桥水域规则。恢复、撤销、全局回撤及存档重载后重新计算破坏效果。
- 增加建筑通行、缺口宽度、多次破坏、孔洞、灯光和玩家可见性回归测试。应用版本升至 `2.4.4`，存档和通信 schema 不变。

## v2.4.3

- 修复全图视角下选择角色 Token 后拖拽范围攻击时，保存误报 `Runtime state was based on a stale canonical World snapshot`。范围拖拽现在替换独立的范围列表，不再通过共享数组修改权威地图快照。
- 保留真正的过期状态保护、Token 锚点与其他范围数据；已删除的范围不会被拖拽保存重新创建。
- 增加权威 Document 更新后的共享引用回归测试。应用版本升至 `2.4.3`，存档和通信 schema 不变。

## v2.4.2

- 修复独立“资料页”窗口仅在正文加载成功后显示关闭按钮的问题。窗口顶栏现在始终提供“× 关闭”，覆盖空列表、新建、编辑、读取中及读取失败状态，内容滚动时仍可见，保留 Esc 退出。
- 关闭资料页后使未完成的正文读取失效，避免迟到的读取结果更新已关闭窗口；关闭窗口不会保存未提交的编辑。
- Windows 浏览器验收增加资料页空状态、编辑滚动、关闭重开及 Esc 退出检查。应用版本升至 `2.4.2`，数据与通信 schema 不变。

## v2.4.1

- 修复 NPC、怪物 XLSX 导入后模板列表不立即显示的问题：监听权威 Actor 更新，无需切换面板或额外点击，不自动放置 Token。
- 顶部新增 GM 专用“全局回撤”，确认后通过单个原子操作清除当前地图全部 Token 和破坏效果；保留角色卡、NPC／怪物模板、迷雾探索、普通指示物及其他地图。同步清理失效选择、移动预览和战斗引用，并刷新导航与视线。
- 资料库右上角提供明确的“× 关闭”按钮，标题栏滚动时保持可见，保留 Esc 退出。
- 新增模板刷新、百个 Token 回撤、取消／失败、联机权限与同步回归测试；总 JS gzip 预算增加 1 KiB，首屏预算不变。
- 应用版本升至 `2.4.1`，World、operation、Status、Access schema 均保持 `4`；Ruleset 与 MapPackage 版本不变。联机主机和玩家应使用同一版本。

## v2.4.0

- 将持久化升级到 World schema `4`、operation schema `4`、Access schema `4`，Infinite Horror Ruleset 升至 `1.1.0`，Lanzhou MapPackage 升至 `1.1.0`；旧 WAL 先按原语义重放，再以包含 World、Access、WAL 和内容依赖的事务备份执行升级，已知英尺字段严格乘 `0.3048`。
- 普通离线与 LAN 写入统一为 Audience-safe Document changes；客户端按地址增量更新 Collection，Fog 携带局部失效边界，字段草稿与并发冲突不再被整页重绘或服务器值静默覆盖。
- 增加不可变图片/正文存储、GM 模板资料库、带依赖 ZIP 与安全 Markdown Journal。浏览器离线使用 IndexedDB，LAN 使用重新鉴权的 HTTP 内容读取；图片二进制和私有正文不进入 WebSocket 投影。
- 增加步行、游泳、水上行走、飞行、起飞/降落、困难地形成本与可选回合移动预算。服务端对能力、三维路径、高度边界、重叠障碍和整组移动进行一次原子验证，失败不会移动或重复扣除预算。
- 增加球形精确/模糊感知、有限高度 LOS、静态/Token 光源及 GM/Scene LOS 覆盖。兰州只为可靠的墙、门和院墙声明遮挡，不把普通碰撞体推断为无限高墙。
- 增加 Ruleset 结算解释、授权门交互和 Journal Audience 裁剪。门操作校验控制权、目标可见性、锁、默认 2 米三维距离及排除门自身后的 LOS。
- 构建保持 World Manager 首屏轻量，地图 Runtime、Leaflet、角色卡、状态编辑器、资料库和 Journal 按需加载；正式候选继续受全量测试、bundle、包清单、Windows smoke 与真实 Radmin 验收约束。
- 500 Token、GM + 6 Player 的本地候选验收通过正常视野与 LOS/光源各 60 秒的前台浏览器门槛，并于 3 秒故障后在 13 秒上限内恢复全部会话；真实 Radmin Direct/Relay 多机验收仍是合并和发布前的外部门槛。

## v2.3.4

- 怪物与 NPC 模板库改为稳定的单列布局：长名称最多显示两行，操作按钮移到名称下方并允许换行，避免窄侧栏中名称被挤成竖排。
- 已探索但当前不可感知区域的深色遮罩由 `0.82` 调整为 `0.70`，让道路、房屋和地形轮廓更容易辨认；未探索区域仍接近纯黑，当前模糊范围的透明薄雾与匿名目标裁剪规则保持不变。
- 应用版本升至 `2.3.4`。World schema 与 operation schema 保持 `3`，Status schema 与 Access schema 保持 `4`，Lanzhou MapPackage 保持 `1.0.6`。

## v2.3.3

- 兰州州衙沿原虚线院界新增五段低矮夯土院墙，并连接既有州衙仪门；南侧墙线避开仪门通道与 `yamen-lane`，墙体始终在房屋素材下方渲染，不遮盖正堂、后堂和东西廊房。
- 五段州衙院墙均为独立、可检查的实体 `wall` Feature，阻挡高度为 `12 ft`，支持局部破坏形成通路及整段摧毁后恢复通行；既有仪门继续权威控制院落入口的开关与碰撞。
- Lanzhou MapPackage 升至 `1.0.6` 并兼容 `1.0.5` World；原有 Feature State 通过稳定 ID 保留，新增院墙按完整状态初始化，无需 World schema 迁移。
- 应用版本升至 `2.3.3`。World schema 保持 `3`，operation schema 保持 `3`，Status schema 与 Access schema 保持 `4`，Infinite Horror Ruleset 保持 `1.0.0`。

## v2.3.2

- 修复 Ctrl/Cmd 连续路径规划：移动预览改用高于 Fog 的独立图层，规划态终点随鼠标更新，并显示已保存拐点、分段距离、累计距离与验证状态；快速连续添加拐点会串行验证，不再乱序或重复。
- 修复首次从指示物列表导入怪物/NPC XLSX 无响应：文件选择器在原始用户点击中同步打开，选定文件后才懒加载解析器；指示物列表与角色库共用同一导入入口。
- 怪物、NPC 和召唤物模板卡的 GM Edit 模式可修改“默认生命规则（新实例）”。该值只供之后放置的 Unlinked Token 继承，现有实例的生命规则与当前生命保持隔离。
- 指示物模板列表与模板卡危险区增加“删除模板”。GM 必须输入模板名称确认，服务器再通过 Document Protocol 3 原子删除 Actor、所有 Scene 关联 Token 及战斗引用，不再克隆和提交整份 World。
- 新增轻量 Document Operation Protocol 3：Actor、Token、Scene、ChatMessage、Combat、Status 与 Fog 通过带 Document 地址、白名单 intent、precondition 和原子 batch 的统一入口提交。普通交互只返回 Audience-safe create/update/delete/move/append 差量，不再导入完整 World；旧 `performOperations()` 仅作为迁移中的兼容包装器。
- Local/LAN 会话携带协议版本、resume revision 与 Audience 指纹。服务端保留最近 256 次或 5 分钟安全提交，断线后优先补发缺失 Document commit，历史不足或权限身份改变时才回退 snapshot；未确认请求沿用 `operationId`，重复移动、聊天、伤害和状态不会再次执行。
- 服务端 AudienceProjection 使用写时复制投影与受影响 Document 快速路径。移动、普通聊天和非视野源的安全状态变更只更新相关 Token/Actor/Chat；权限、视野源、隐身、跨 Scene 等安全边界变化仍执行完整投影。500 Token、GM+6 Player 的本机回环基准综合 p95 从首轮约 `291 ms` 降至 `60 ms` 以下，普通请求/响应保持差量。
- Local Server 增加 `world.operations.ndjson` WAL：每条记录包含连续 revision、operationId、权威 patch、时间与 SHA-256 checksum，刷盘成功后才 ACK；尾部不完整记录可安全截断，中间损坏会停止加载并进入恢复流程。每 100 revision、60 秒或 8 MB 压缩为原子 `world.json`。
- Token 移动改为一次性 `token.movePath` Document 事务。单个和群组 Token 的所有 waypoint 由服务端逐段复验控制权、锁定、战斗回合、状态能力、边界与内置 MapPackage 碰撞；全局 revision 变化但目标起点未变时可安全 rebase，目标已移动则返回 `entity_conflict`。WASD 以 50 ms/最多 8 步合并且保留逐步路径。
- 恢复 FVTT 风格路径操作：普通拖放直线移动；Ctrl/Cmd 拖放进入规划但不把释放点误记为 waypoint；Ctrl/Cmd+点击或 `F` 添加点，右键或 `Alt+F` 撤销，普通点击或 `Enter` 提交，`Esc` 取消。拖动、WASD 与路径规划立即显示本地 visual state，确认后无跳变衔接，拒绝或断线时平滑回滚。
- Token 图片、幽灵和摘要头像禁用浏览器原生拖图，Pointer 生命周期覆盖 pointerup、pointercancel、窗口失焦与销毁。Token Renderer、状态徽章、选择摘要和 Actor Sheet Part 在同一 RAF 内按 ID 合并更新，普通 Document 变更不替换整张角色卡或整场 Token DOM。
- Fog 拆分为静态探索层和动态感知层。模糊范围取消灰度和重度压暗，仅叠加 `rgba(218,226,228,0.20)` 冷灰透明薄雾；未探索区域仍接近纯黑，历史探索保持极暗。预测位置可以驱动临时视野，但永久探索只接受服务器确认路径，匿名轮廓与零泄漏规则不变。
- Windows 发布 smoke 同时覆盖 Microsoft Edge 与 Google Chrome，并使用隔离临时浏览器配置。README 增加 Radmin VPN 的 `26.x.x.x:30000`、Direct/Relay、可信网卡、防火墙放行、Ping 和同版本要求。
- 应用版本升至 `2.3.2`。World schema 保持 `3`，operation schema 升至 `3`，Status schema 与 Access schema 保持 `4`，Infinite Horror Ruleset `1.0.0` 和 Lanzhou MapPackage `1.0.5` 不变。

## v2.3.1

- 收口 v2.3.0 发布后的角色/怪物卡权限修复（起点 `15cda37`）：Actor Sheet V3 正式接入运行时组合入口，移除 `<pre>` 占位 renderer 与 V2 DOM decorator；角色卡继续支持多窗口、Scene+Token 独立身份、拖动缩放、焦点顺序、本地几何记忆和窄屏单列布局。
- 卡片上下文显式使用 NONE/LIMITED/OBSERVER/OWNER/GM 权限。OWNER/GM 的 Play 模式只处理 HP、资源、检定、战斗与状态等运行数据，Edit 模式才编辑名称、头像、类型、队伍、形态等结构；OBSERVER 完整只读，LIMITED 只进入专用最小卡，Token 控制权仍单独按实例规则判定。
- Actor 增加向后兼容的 `publicProfile`：GM 可维护公共简介、外观、最多 20 条已知情报和允许公开的状态定义，并在模板卡预览 LIMITED 结果。`actor.publicProfile.update` 由服务器权威标准化、校验状态白名单并通过 Actor changeSet 增量同步；旧 Actor 默认为空，不会隐式公开 Ruleset 私有简介。
- LIMITED AudienceProjection 只下发最小 Actor、规范化公共档案和当前 Token 的安全 `publicStatuses`。状态摘要仅包含名称、图标、颜色、分类和层数；不包含真实状态 ID、实例 ID、备注、持续时间、来源、能力、changes、生命、资源或权限。Linked 状态正常同步，Unlinked 怪物实例按各自 Synthetic Actor 隔离。
- Actor 权限编辑改用 `api.multiplayer.updateActorOwnership()` 原子批量请求，服务端验证 GM、Actor、User、Access revision 与默认角色 OWNER 约束，并返回逐项结果；移除通过隐藏旧管理表单模拟提交的路径。
- 应用版本升至 `2.3.1`。World schema 保持 `3`，operation schema 保持 `2`，Status schema 与 Access schema 保持 `4`，Infinite Horror Ruleset `1.0.0` 和 Lanzhou MapPackage `1.0.5` 不变。

## v2.3.0

- Operation Protocol 升至 schema `2`：Token、Actor、Status、Chat、Health、Combat、Feature 与 Fog 统一使用 `world.operation`，提交消息包含连续 revision、Audience-safe patch、细粒度 `changeSet` 和裁剪后的 results。完整 snapshot 仅用于启动、显式恢复/导入、revision 缺口、Audience 身份变化和跨 MapPackage Scene。
- Access schema 升至 `4`，Actor 权限明确区分 NONE、LIMITED、OBSERVER 与 OWNER；Token 可见性、Actor 查看/编辑、实例控制权和视野授权分别判断。公开怪物使用合法 LIMITED 投影，模糊敌影使用每 Session opaque ID，不泄漏真实 ID、精确坐标或私有 Actor/Token 数据。
- Status schema 升至 `4`：定义增加 buff/debuff/neutral 分类与默认持续时间，实例保存 turns/rounds 剩余时间；服务器权威 `combat.advance` 原子推进战斗和状态计时，到期状态自动停用。右键 Token 或点击徽章可打开快捷 HUD，自定义状态导入采用全量校验和冲突拒绝。
- Token 实例页改为基础、视野、权限、高级四区，支持精确/模糊范围分别继承 Ruleset、按显示名选择控制者/授权用户、字段级 pending/confirmed/error 和危险操作确认；390px 布局无横向溢出。
- 恢复完整分段移动：普通拖放保持直线，`Ctrl`/`Cmd` 进入 waypoint 规划，支持点击、`F`、`Alt+F`、右键、`Enter` 与 `Esc`；服务器逐段复验碰撞、控制权、Token lock、Combat 回合和群组原子性。
- 聊天 composer 默认折叠为消息、伤害、恢复三种模式，切换不重建日志；失败保留输入，未激活标签显示未读角标。普通 Player 只能提交文本，消息 ID、时间与发送者由服务器生成。
- Fog 使用独立去饱和与暗度 Canvas：normal/dim/dark 按感官能力区分精确、模糊、历史探索和未探索区域。dirty bounds 与 RAF 合并避免 Chat、普通 Status 和非视觉属性更新触发全量 Fog 重绘。
- Reducer 改为 batch 单次克隆和细粒度 copy-on-write，Token/状态/聊天/生命 UI 使用 keyed 更新；每个 LAN Session 缓存 AudienceProjection，普通提交从裁剪后的 patch 生成安全 changeSet。Node 22.12 固定 fixture 的三类 operation 中位数均降低超过 25%，三会话 LAN 聚合 p95 降低 31.5%。
- World Manager 首屏继续保持不增长；兰州地图 SVG 与数据改为选择地图后才请求的编译资源，重型角色卡与状态工具首次打开才加载。相对 v2.2.6，总 JS gzip 从 `256,689 B` 降至不超过 `251,555 B`。
- 应用版本升至 `2.3.0`。World schema 保持 `3`，Infinite Horror Ruleset 保持 `1.0.0`，Lanzhou MapPackage 数据版本保持 `1.0.5`；正式包记录 operation `2`、status `4` 和 access `4`。

## v2.2.2

- 实时视野改为保存服务器确认的视野源 Token ID，并在每次渲染与 World commit 后从当前 Scene 解析最新权威坐标；Token 移动、重连、Scene 切换、删除、进入 Feature 或失去控制权时不再残留旧位置视野。
- 离线与 Local/LAN 迷雾探索统一使用模糊侦测范围，移动按起终点连续 sweep；精确范围外但模糊范围内的实际可见区域也会永久写入 Scene Fog，离开后继续显示淡色记忆迷雾，只有 GM 的重新隐藏或重置探索会清除。
- Actor 正式增加 `monster` 类型。怪物、NPC 与召唤物均强制使用独立 Token/`actorDelta`；旧 `npc` 不迁移，仍保持 NPC，`summon/other` 继续保留。
- 指示物库将模板拆分为“怪物”“NPC”“其他模板”三块；怪物与 NPC 各有独立 XLSX 导入入口，新建模板自动分类，同名追加形态不会改写现有 Actor 类型。
- 应用版本升至 `2.2.2`；World schema 保持 `3`，operation schema 保持 `1`，Infinite Horror Ruleset 与 Lanzhou MapPackage 数据版本不变。

## v2.2.1

- Token 移动预览与提交共用结构化校验，并增加 WASD 单格移动；Local/LAN 仍由服务器复验控制权、战斗回合、状态和碰撞。未配置的简单 Health `0/0` 不再被误判为耗尽或死亡。
- Infinite Horror 增加精确/模糊侦测范围、感官能力、环境亮度降级与 Token 实例覆盖；AudienceProjection 只向模糊范围内的敌对 Token 下发量化位置的匿名轮廓，不泄露 Actor/Token ID、名称、图片、Health、Effect 或其他私有数据。
- XLSX 导入器按规则表标签读取侦测数值与布尔感官，支持缓存公式值、中英单位、多种勾选形式、工作表容错和结构化警告；新增 `npm run test:xlsx` 生产导入校验命令。
- 角色库只显示 PC，“其他指示物”管理 NPC/召唤物/其他模板与当前 Scene 实例；每个实例使用稳定编号名称，GM 可在抽屉中批量施加/移除状态。
- GM 专属与隐身 Token 在 GM 视角显示独立半透明徽章；选中摘要固定在地图容器右下角。移除旧“图层”面板并始终显示网格，侧栏收敛为四个等宽主标签。
- 应用版本升至 `2.2.1`；World schema 保持 `3`，operation schema 保持 `1`，Infinite Horror Ruleset 与 Lanzhou MapPackage 数据版本不变。

## v2.2.0

- World schema 升级到 `3`，旧 schema 2 World 在写回前备份并幂等迁移；Actor 增加 `pc / npc / summon / other` 分类与队伍，Token 增加控制者、可见性和视野配置，Scene 增加 5 米网格迷雾数据。operation schema 保持 `1`。
- Actor 成为可复用模板；NPC 与召唤物 Token 强制使用独立实例，当前生命、B/L/A 伤势、状态、资源和形态只写入该 Token 的 `actorDelta`。模板的静态属性与生命上限仍动态继承，降低上限时仅截断超出的实例当前生命。
- 新增实例化放置、运行时操作、旧共享 Token 原子拆分、Token 访问控制、Marker 和 Fog operation；Health、Status、Effect、聊天伤害、Combat 与批量结算统一传递 `tokenId`，拒绝含义不明的 NPC/召唤物 `actorId` 运行时写入。
- Local/LAN 新增逐会话 `AudienceProjection`。服务器保留完整权威 World，并按 GM、控制权、队伍、指定用户、可见性、隐身和当前实时视野裁剪快照、补丁、Combat、Chat、Effect、Status、Access 目录及查询结果；隐藏目标的拒绝或冲突不会携带 canonical World。
- Infinite Horror 新增通用隐身能力和视野描述：默认范围为 `30 + 感知 × 10m`，缺失感知时 `40m`，限制在 `20–120m`。玩家每次只使用一个受控 Token 的实时圆形视野，已探索区域按 `sceneId + partyId` 持久化共享，GM 可重置或重新隐藏。
- 新增轻量“其他指示物”、模板卡/实例卡标识、Token 控制与可见性编辑、迷雾控制、GM 全图/Token 视角切换，以及右下角稳定尺寸的圆形 Token 摘要；桌面和 390px 移动端均通过无溢出验证。
- World Manager 改用轻量 Ruleset 元数据，选择 World 后才加载完整 Ruleset 与地图 Runtime。相对正式 v2.1.6 基线，首屏 JS gzip 降低约 `75%`，总 JS gzip 增长约 `6.6%`，CSS gzip 不变，均通过 v2.2.0 bundle budget。
- Windows packaged-server smoke 现在覆盖 GM/Player 身份授权、逐用户投影、视野来源、迷雾持久化、隐藏目标拒绝零泄漏、动态地图与真实 Canvas 遮罩；正式包 `VERSION.json` 明确校验应用版本、完整 commit、World schema `3` 与 operation schema `1`。

## v2.1.6

- 新增 FVTT 风格的 Group Token Movement：拖动多选集合中的任意已选 Token 时保留 selection，并将被拖 Token 作为 leader；其他成员按开始规划时的相对 `dx/dy` 保持队形。
- 群组规划只绘制 leader 路线，但终点为每个成员显示独立 Token 幻影；确认后 Renderer 为每个成员使用平移后的 waypoint 队列进行同步平滑移动，不产生中间 World 坐标写入。
- 每个成员都使用自己的直径、高度和 Status collision context 独立校验整条路线；任意成员受阻、越界、被锁定或失去移动能力时，整个 formation 都视为无效。
- 最终提交前重新读取 canonical Scene Token 并重新校验全部成员；全部通过后只执行一次 `movement:group` canonical World commit，同时更新全部最终 `x/y` 和 Token-bound AoE anchor，保证全有或全无。
- Group Movement 只是一次 transient movement context，不新增 `TokenGroup` / Formation 文档或第二套持久化权威；World schema 仍为 `2`，operation schema 仍为 `1`。
- 非战斗 Player 可群移自己拥有 OWNER 权限的 Token；Active Combat 中普通 Player 一次只能移动一个 Scene Token，即使多个 Token 共享当前 Actor 也不能借群移绕过 Combat Turn Lock；GM 保持完整权限。
- bundle budget 基线滚动到正式 v2.1.5 release commit `d31840247fba4d850f6f47054588686d747c60dd`：已达成的首屏 JS 体积不允许回退，总 JS/CSS 相对正式基线最多增长 5%。
- 应用版本提升到 `2.1.6`；Infinite Horror Ruleset 继续为 `1.0.0`，Lanzhou MapPackage 数据版本继续为 `1.0.5`，Character Runtime 继续保持退役。

## v2.1.5

- 新增 Combat Turn Origin Ghost：每回合开始时把当前 combatant 的 canonical Scene Token `x/y/elevationFt` 存入共享 Combat State；Token 离开起点后 Renderer 在原位显示半透明不可交互的起点幻影。
- 起点幻影不是第二个 Scene Token，不进入 Selection、碰撞、AoE、伤害或 World 写入；刷新和 Local/LAN 重连后可由共享 Combat State 重建。
- 下一回合会替换旧起点，结束战斗会清除；Token 回到完全相同的起点时幻影隐藏，再次离开仍使用本回合同一 origin。
- Combat preference schema 从 `1` 提升到 `2` 并自动向前归一化；World schema `2`、operation schema `1`、Ruleset 和 MapPackage 数据版本不变。

## v2.1.4

- 恢复更接近 v1.6.3 的 Token 移动观感：规划时显示终点 Token 幻影，确认后 canonical World 仍只提交最终位置，Renderer 再沿已确认路径执行平滑插值。
- 多 waypoint 会按路径段顺序显示，视觉动画不会产生中间 World 写入；`prefers-reduced-motion` 继续受支持。
- Token 移动期间临时隐藏独立 Health/Status overlay，避免覆盖层先跳到服务器终点，动画结束后恢复。
- Token 上方标签改为“高度 → 名称”，生命条继续位于 Token 下方。

## v2.1.3

- 修复 Local/LAN 普通聊天发送者看不到自己消息的问题：`chat.append` / `chat.clear` 属于服务器独占写入，即使快照来自当前 Session 也会重新载入权威 World；普通自己发出的 World operation 仍避免重复 import。
- 聊天发送请求被 WebSocket 接受后才清空输入并重新 focus；连接不可用时保留原输入并给出错误提示。
- 删除顶部重复的“检查地物”按钮；“选择”模式继续同时负责 Token 选择和建筑、城墙、城门、桥梁等 Feature 的直接检查，Feature Interaction / 门开关逻辑保持不变。
- 修复 Scene Token 绑定范围无法“预览影响 / 应用破坏”：实时 Scene Area 继续保存 canonical Token anchor，破坏计算只接收当前已解析坐标的一次性 free geometry snapshot，历史 damage event 不会随着 Token 后续移动而漂移。
- 修复切换范围绑定对象时 fallback origin 仍按旧 anchor 计算的问题，新 Token/Marker 绑定会立即使用新对象当前位置。
- 新增 v2.1.3 聊天、选择/检查和 Token-bound AoE 回归测试；World schema 2、operation schema 1、Infinite Horror Ruleset `1.0.0` 与 Lanzhou MapPackage 数据版本 `1.0.5` 均保持不变。

## v2.1.2

- 在保留 World V2 / Scene Token / Ruleset 架构的前提下恢复 v1.6.3 的 Token 实时拖动路线、waypoint、滚轮吸附和阻挡反馈。
- 恢复圆形、扇形、矩形范围的地图拖拽手柄，同时保持 drag 过程本地预览、dragend 后才提交 World。
- Token 名称固定到 Token 上方，HP bar 保持下方，避免尺寸变化后重叠。
- 恢复选择/浏览状态下直接点击 inspectable Feature 打开地物详情；门继续使用现有通用 FeatureControlLayer 直接开关。
- 扩展 Character Runtime retirement 测试覆盖新的 movement / inspector / area adapter；不重新引入旧 Character Runtime。

## v2.1.1

- 修复地图 Runtime 在 Leaflet 设置中心和缩放前注册 Feature 控件，导致启动抛出 `Set map center and zoom first.` 并显示空白地图的问题。
- Feature 控件现在只在地图 ready 后计算屏幕坐标；Runtime 在注册任何工具前先建立初始视野。
- Windows packaged-server smoke 现在要求地图已有中心/缩放、兰州基础 SVG 已挂载且具有非零尺寸和地图图片，并捕获浏览器 `console.error`。
- 新增地图初始化顺序与 Feature 控件 ready 边界测试；World schema 2、operation schema 1、Infinite Horror Ruleset `1.0.0` 与 MapPackage 数据版本 `1.0.5` 均保持不变。

## v2.1.0

- `Scene.featureStates` 成为门、机关、阻挡高度与扩展状态的唯一持久化权威；旧全局 Feature State 只在迁移入口读取，冲突会停止迁移而不覆盖原存档。
- World Manager 首屏与地图 Runtime 分离；Leaflet、地图 CSS、兰州逻辑和 29 张 WebP 在选择 World/Scene 后动态加载，首屏静态 JS gzip 相对 PR #21 基线降低 78.75%。
- Built-in Registry 在地图未加载时即可列出兰州城的 id、version 与 title；MapPackage 数据版本仍为 `1.0.5`。
- Windows 发布包改为严格白名单，不再复制 raw `reference/`，统一 verifier 校验目录、版本、commit、Vite manifest、兰州资源、ZIP SHA-256 与 30% 体积门槛。
- Windows smoke 现在验证 BAT、`/api/health`、World Manager、创建 World、动态 Runtime 与全部兰州 WebP；candidate/release 统一运行 audit、tracked syntax、bundle budget 和 package verifier。
- 应用版本提升到 `2.1.0`；World schema 2、operation schema 1、Infinite Horror Ruleset `1.0.0` 和现有存档语义保持不变。

## v2.0.0

- World schema 2 成为唯一持久化权威，Actor、Scene、Token、Combat、Effect 与状态通过通用 World operation schema 1 原子提交；完整 World 只保留在初始化、显式导入和恢复边界。
- Actor 使用稳定通用外壳，规则数据统一进入 `actor.system`；Ruleset Contract 负责默认值、旧存档迁移、规范化、验证、派生、展示、属性路径和运行时操作。
- Infinite Horror 的 Health、B/L/A、状态与角色形态语义已移入规则包，同时兼容旧 SaveV1/V2、旧 Actor 字段和 Synthetic Actor Delta，不丢失角色、Token、伤势、状态或自定义定义。
- Runtime、角色卡、Token、聊天、导入器、Effect 与多人服务器改为使用显式 Ruleset 上下文和通用 Actor/Ruleset 接口；最小假 Ruleset 与源码边界测试防止 Core 注入 Infinite Horror 语义。
- Local/LAN 使用服务器权威、带 revision 与幂等 operation ID 的通用操作协议；Player ownership、Combat 回合锁和 GM-only 状态权限继续由服务器验证。
- 应用发行版本提升到 `2.0.0`；World schema 保持 2、operation schema 保持 1、`world.ruleset.id` 保持 `infinite-horror`，Infinite Horror Ruleset 版本保持 `1.0.0`。

## v1.7.0

- Entity System 升级为 schema v3：World 保存自定义状态定义，Actor 状态跨形态和 Token 生效，Token 状态只影响单个地图实例；旧 effects 会确定性迁移。
- 角色卡增加独立“状态”页、标题状态带和 Token 地图徽章；GM 可创建定义、施加、移除、调层、启停和批量操作，OWNER / OBSERVER 保持只读。
- 首批机械状态包含“灵体”“定身”“失能”；昏迷、死亡和 B/L/A 伤势徽章由生命系统只读派生，恢复后立即解除对应限制。
- “灵体”只绕过 `structure` 碰撞组，仍受水域、弹坑、地图边界、Token 尺寸和高度规则约束；定身、失能、昏迷和死亡会在规划与提交两个阶段阻止移动或交互。
- Feature Capability 支持结构化状态前置条件和成功副作用；Feature 状态、角色位置与状态变化在同一次 World 提交中原子完成，失败或取消不会留下部分结果。
- 局域网新增服务器权威 `status.apply/remove/setStacks/batch/definition.*` 操作；使用 `operationId` 去重，批量操作全成全败，并在 schema 校验、备份和原子写盘成功后才确认及广播。
- Player 无法通过伪造状态消息或 `world.push` 改写状态定义及 Actor / Token effects；断线、权限下降或写盘失败会清理待提交状态和移动预览，并以服务器 World 恢复界面。

## v1.6.3

- 修复“放置 Token”时角色卡遮罩拦截地图的问题，提供可取消的放置 HUD。
- 联机服务端现在验证 World 结构和重复 ID、要求 GM Secret、拒绝跨站 WebSocket，并在写盘成功后才广播 revision。
- World/User 写入保留滚动备份；损坏存档会隔离并停止启动，不再静默清空。
- Windows 发布仅支持 Local/LAN；移除 Quick Tunnel、cloudflared 和 shell 启动说明。
- Token 移动改为 1m 稀疏分块直线碰撞检测：受阻立即标红，不再自动绕行或运行 A*。
- Token 支持 GM 专用的 1 / 5 / 10 / 20m 直径；尺寸、血条、预览与路线宽度同步缩放。
- 加入 Worker 硬时限回归，覆盖旧浮点遍历卡死坐标、长线、障碍和角点；连续拖拽复用分块占用缓存。
- 修复局域网中“进入战斗后先攻表立即消失”：战斗状态在战斗日志前同步提交给服务器，不再触发整份 World 导入。
- 修复角色血量/伤势变更的即时保存与同步：生命值、资源调整会立即写入本地状态并推送到局域网服务器，同时刷新角色卡与地图生命条。
- 战斗流程会等待关联 World 写入确认后再追加日志，修复连续点击“下一回合”时 Player 回合被回滚，以及“结束战斗”无法清空先攻表的问题。
- 当前回合以 Token 的实时 Actor 绑定为准，兼容旧先攻记录缺失或过期 actorId 的 Player 控制权。
- 清空共享聊天只删除聊天日志；当前战斗、B/L/A 伤势和恢复结果保持不变。
- 角色卡伤势生命槽新增 B / L / A 直接编辑；Player 仅可在自己当前回合编辑自己的角色，恢复会明确提示没有对应伤势或目标已死亡。
- 收敛用户文档为 README、操作指南、开发说明、未来规划和变更日志；移除过期工作日志与重复联机测试/使用说明。
- 发布包随附 `docs/OPERATION-GUIDE.md`，覆盖 Local/LAN 启动、Player 审批、权限、Token、移动、战斗、B/L/A、备份与排障。

RPGmap 使用语义化版本号；详细提交历史请通过 Git 查看。历史条目可能记录已移除的 Internet/Public 功能，不代表当前支持范围。

## 1.5.5 — Candidate · 2026-08-23

V1.5.5 将服务器 World 设为本地启动时的唯一状态来源，并完成了角色卡规范化模块的接入。

### Token / Startup Stability

- 在本地 RPGmap Server 模式下，浏览器启动时不再读取历史 `localStorage` World；客户端会在检测到 `/api/health` 后使用内存存储，随后以 `map/world.json` 的服务器快照为准。
- 自动 GM 连接前会让地图完成首帧绘制，避免连接与完整 World 导入抢占启动渲染。
- 空白、缺字段或结构异常的角色卡会在创建 Actor 前补齐安全默认值，防止 `undefined` 进入 Token 绑定与渲染链路。
- 新增空角色卡回归测试，覆盖 Actor / Form / Token 所需的默认数据。

## 1.5.4 — Candidate · 2026-08-22

V1.5.4 继续收口单入口 Launcher 的主机体验，不改变 MapPackage / Feature / Elevation / Navigation 数据模型。

### Startup / Multiplayer UX

- Local/LAN 与 Internet/Public 两种模式都会生成并显示 Join Code（房间号）与 GM Secret（GM 密码）。
- READY 信息集中显示本机地址、可用 LAN 地址、Internet 模式的 Cloudflare Public URL、Join Code 与 GM Secret。
- Internet 模式下主机不再通过 Public URL 访问自己的地图，而是直接打开 `127.0.0.1`，减少 Tunnel 往返和公网波动对主机加载的影响。
- Launcher 打开的 localhost URL 使用 hash 携带一次性 GM bootstrap；Client 读取后立即清除 hash，并自动以 GM 身份连接。
- GM bootstrap 只允许 localhost / 127.0.0.1 消费，不把 GM Secret 放进玩家使用的 Public URL 或普通 HTTP 查询参数。
- LAN Player 现在同样使用 Join Code 进入房间，使 Local/LAN 与 Internet/Public 的加入流程保持一致。

### CI

- Candidate workflow 名称改为版本无关的 `Build RPGmap Candidate`，实际 ZIP / VERSION.json 继续从 `package.json` 动态读取版本。
- Windows BAT smoke 额外验证 Local/LAN Server 已启用 Join Code。

## 1.5.3 — Candidate · 2026-08-22

V1.5.3 在 V1.5.2 端口互斥修复基础上进一步收口启动架构，不改变 MapPackage、Feature Interaction、Elevation 或 Navigation 数据模型。

### Single-entry launcher

- Windows 发布包只保留一个 `start-rpgmap.bat`。
- 双击后选择 `Local / LAN` 或 `Internet / Public`；也支持 `start-rpgmap.bat local|internet`。
- 新增统一 `launcher.mjs`，集中负责端口检查、Server 启动、`/api/health` READY 等待、浏览器打开、Internet Tunnel 和凭据生成。
- 删除 `local-launcher.mjs`、`internet-launcher.mjs`、`launcher-guard.mjs`，避免多套启动逻辑分叉。
- 删除 `start-rpgmap-internet.bat`、`setup-cloudflared.bat`、`run-rpgmap-public-server.bat`。
- Internet 模式自动查找 `cloudflared`；Windows 缺少时自动尝试官方下载，失败后尝试 Winget。
- Internet 模式不再额外打开 Multiplayer Info 命令行窗口，Local / Network / Public / Join Code / GM Secret 统一打印在当前 Launcher 窗口。

### Packaging / CI

- Candidate ZIP 根目录强制只能存在一个 Windows BAT：`start-rpgmap.bat`。
- CI 明确禁止旧 Split Launcher / Setup / Public Server BAT 重新进入源码和安装包。
- Windows smoke 改为执行 `start-rpgmap.bat local`，验证单入口 Launcher 能启动 `publicMode=false` Runtime。
- Linux no-reference Runtime、source separation、Node tests、syntax 与 Vite build 验证继续保留。

## 1.5.2 — Candidate · 2026-08-22

V1.5.2 修复 V1.5.1 人工验收中发现的 Local/LAN 与 Internet 启动生命周期冲突风险，不改变 MapPackage、Feature Interaction 或 Elevation 数据模型。

### Local / LAN startup

- 新增 `local-launcher.mjs`，本地入口不再先打开浏览器再启动 Server。
- 本地启动顺序改为：端口检查 → 启动 Server → `/api/health` READY → 打开 `127.0.0.1`。
- 本地启动显式清除 Public URL / Join Code / GM Secret，并强制 `RPGMAP_PUBLIC=0`，避免继承公网模式环境。
- `start-rpgmap.bat` 与 `start-rpgmap.sh` 统一通过 guarded local launcher 启动。

### Local / Internet mutual exclusion

- 新增 `launcher-guard.mjs` 检查 30000 端口占用。
- 若已有 RPGmap Local/LAN 或 Internet/Public Server，占用信息会被识别并直接报错，不再继续创建第二个 Server。
- 若端口被其他程序占用，也会给出明确错误。
- Internet launcher 在创建 Quick Tunnel 前先检查本地 origin 端口，避免等到 Tunnel 创建后才发现 Server 无法绑定。
- Local/LAN 与 Internet 是两种互斥启动方式；Internet 模式本身仍同时提供 Local、Network 与 Public URL，不需要再额外启动本地 Server。

### Validation

- 新增 launcher port-guard 自动测试。
- Windows package smoke 额外确认 `start-rpgmap.bat` 启动的是 `publicMode=false` 的 Local/LAN Server。
- Package 继续执行 Node、syntax、source separation、Vite build、Linux no-reference Runtime 与 Windows BAT no-reference Runtime 验证。

## 1.5.1 — Candidate · 2026-08-22

V1.5.1 是 V1.5.0 MapPackage / Feature Interaction / Elevation Candidate 的人工验收修订版，保持 V1.5 架构边界不变。

### Token UI / Elevation

- Token 名称固定在正上方。
- HealthSystem 保持唯一 HP 条并放在 Token 下方。
- `elevationFt` 标签移到 Token 右上角，避免与名称 / 血条冲突。
- Character Marker 直接绑定 `contextmenu`，同时保留 DOM capture 与 Map fallback；右键高度 HUD 不再依赖某一次 DOM 扫描时序。
- 高度 HUD 保持直接输入与 `-5 / +5 ft` 调整。

### Packaging / Validation

- Package version 更新为 `1.5.1`。
- Windows package smoke 使用 Linux package job 输出的实际版本，不再写死 `1.5.0`。
- `VERSION.json`、归档目录、ZIP 与 Artifact 的版本一致性继续由 CI 验证。
- 继续执行 Node、JavaScript syntax、源码独立性、Vite build、Linux no-reference Runtime、Windows BAT no-reference Runtime 全链路验证。

## 1.5.0 — Candidate · 2026-08-22

V1.5.0 从 V1.4.1 已验证的 Multiplayer / User / Ownership / Portable Runtime 基线上重新建立地图框架，目标是让“换地图”只替换 MapPackage，不复制 Damage / Movement / Scene / Multiplayer 逻辑。

### MapPackage Framework

- 新增 `src/map-package/contract.js`。
- MapPackage 进入 Engine 前统一验证 ID、Version、尺寸、SVG Renderer、Feature ID、Layer Plan。
- 增加 MapPackage API V1 与逻辑 Layer Role：`base / terrain / liquid / structure / special / destructible / labels`。
- Feature 归一出 `inspectable / interactive / enterable / destructible` Capability。
- 主入口 `src/main.js` 不再直接 import 兰州城代码与 Generated Art，只依赖 `createDefaultMapPackage()`。

### Lanzhou Reference Map

兰州城实现从 Core 目录实际迁移到：

```text
reference/maps/lanzhou/
├─ manifest.js
├─ package.js
├─ capabilities.js
├─ assets.js
├─ presentation.js
├─ assets/
├─ index.js
└─ README.md
```

职责：

- `manifest.js`：Map ID / Layer Plan；
- `package.js`：兰州专属 Feature / Navigation / SVG；
- `assets.js`：素材绑定；
- `presentation.js`：兰州专属展示处理；
- `index.js`：MapPackage 组装。

旧 `src/maps/lanzhou.js` 与 `src/maps/presentation-cleanup.js` 仅保留兼容 re-export，实际地图源码不再属于 Core。

### Minimal Reference Map

- 新增 `reference/maps/minimal/`。
- 仅包含 Base / Terrain / Liquid / Special / Destructible / Labels、一栋木屋和一堵墙。
- 自动测试将 Minimal 地图交给与兰州相同的 `createDamagePreview / commitDamageEvent / deriveSceneState`。
- 测试要求 `demo-house` 正常进入 destroyed Scene State，证明可破坏逻辑属于通用 Core。

### DIY Map Documentation

新增 `reference/README.md`，记录：

- MapPackage / Core / Scene Instance / World 四层职责；
- Reference Map 目录样式；
- Layer Plan；
- Feature + Capability；
- 可破坏地图边界；
- 新地图 DIY 流程；
- 禁止重新引入外部 `maps/` 双 Source of Truth、Launcher 文件解析、Junction 等 V1.4.2/V1.4.3 实验模式。

### Runtime Model

V1.5.0 **不改变** V1.4.1 已验证的稳定 Runtime：

```text
Reference MapPackage source
        ↓ Vite build
app/index.html
        ↓
server.mjs
        ↓
Browser
```

- 当前默认兰州地图在 build 时被打入 `app/index.html`。
- `reference/` 是开发 / DIY 参考，不是 Server Runtime 数据源。
- Server 不扫描 `reference/`，不创建根 `maps/`，不创建 Junction。
- World/User 仍沿用 `map/world.json` 与 `map/users.json`；此次故意不同时做 Storage Migration。

### CI Validation

V1.5.0 CI 增加：

- 兰州源码与素材必须真实位于 `reference/maps/lanzhou/`；
- `src/assets/generated` 必须不存在；
- `src/main.js` 不允许直接出现 Lanzhou / generated asset 引用；
- production build 必须包含默认兰州 Map ID；
- 打包后完整复制 Runtime 并删除测试副本中的整个 `reference/`；
- 删除后重新启动 `server.mjs`，`/api/health` 和 `/` 仍必须成功；
- 最终 ZIP 同时包含完整 `app/` Runtime 和 `reference/` DIY 参考。

## 1.4.1 — Candidate · 2026-08-21

- Persistent Player User / Player Key；
- Actor Ownership：NONE / OBSERVER / OWNER；
- Default Actor；
- Server-authoritative Ownership 校验；
- Combat Turn Lock；
- Client Ownership preflight；
- `app/ + map/` 便携 Runtime；
- `map/world.json` / `map/users.json`；
- Quick Tunnel 身份恢复与旧 `data/worlds/default/` 兼容迁移。

## 1.4.0 — 2026-08-21

- Multiplayer V1；
- 原生 WebSocket `/ws`；
- World Snapshot + revision / baseRevision；
- GM / Player；
- Join Code / GM Secret；
- Cloudflare Quick Tunnel。

## 1.3.0 — 2026-08-21

- Selection / Measurement；
- Combat；
- Health / Damage / Healing；
- Chat / Game Log；
- Actor XLSX / Form；
- 本地 HTTP Server。

## 1.2.0 — 2026-08-21

- Actor / Token / Form EntitySystem；
- XLSX 角色导入；
- Movement / Waypoint / A*；
- AppShell；
- 初版 MapPackage。

## 1.1.0 及更早

早期版本完成基础地图浏览、Marker / Token 原型和地图数据验证。
