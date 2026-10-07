# 制图用废墟素材

这里是独立制图素材库，运行时不会扫描或整体导入，Windows Release 不包含此目录。地图实际使用的图片仍按现有地图资源流程提供。

- `房屋/rubble-atlas.webp`：复用兰州现有图集，1536×1024，3 列×2 行。适用于瓦木土混合房屋，可选一格或按原对象 ID 稳定选择。
- `城墙/`：普通碎石与严重破坏的深色碎石静态贴图。
- `植被/`：枝叶残留与严重破坏的焦土静态贴图。
- `地表/`：普通裸土地表与严重破坏地表静态贴图。

所有文件都是纯图片。图片没有遮挡、阻挡、寻路、实体或伤害 Tag；图片里的 SVG 颜色与图案也是美术信息。物体是否被破坏、剩余墙体和独立弹坑的规则仍由原场景数据决定。

## 地图调用

把使用的素材复制进该地图自己的资源目录，按地图原有方法得到可访问 URL，再添加样式表。例如（这里的 URL 由地图提供）：

```js
artAssets: {
  ruins: {
    'tile-timber-earth-rubble': {
      normal: {
        url: mapHouseRubbleUrl,
        width: 1536, height: 1024, columns: 3, rows: 2,
      },
      severe: mapSevereHouseRubbleUrl,
    },
    wall: { normal: mapWallRubbleUrl, severe: mapSevereWallRubbleUrl },
    vegetation: { normal: mapVegetationRubbleUrl, severe: mapSevereVegetationRubbleUrl },
    terrain: { normal: mapGroundRubbleUrl, severe: mapSevereGroundRubbleUrl },
  },
}
```

在原物体上设置 `ruinStyle: 'tile-timber-earth-rubble'`。先按 `ruinStyle` 查找，未命中则按 `category` 查找。未提供严重素材时可沿用普通素材；未配置新样式的房屋沿用 `rubbleAtlas`，其他物体及图片加载失败使用通用静态纹理。

图集资源可选 `column`、`row` 指定一个格子。可选 `align: { offsetX, offsetY, scaleX, scaleY }` 调整对齐；offset 使用地图世界坐标单位，scale 为原物体外接框的比例。默认以原物体外接框固定对齐，不会因破坏区域变小而缩小图片。

绘制时用原物体轮廓（包括孔洞）与破坏范围遮罩露出对应部分。多次重叠只扩大遮罩，贴图保持一次绘制；达到整体破坏条件则显示整个物体轮廓。修改图片不会生成或改变任何 Feature、Token、遮挡形状或破坏事件。

## 添加自制素材

新增图片时保留透明通道或使用无缝平面纹理，并提供普通／严重两种外观。宽窄城墙宜使用适合原物体比例的图片或显式对齐配置。不要在图片里画独立可交互物体；需要门、墙或可交互对象时，在地图数据中单独定义。

这里只收纳素材，应用入口不得直接导入整个目录。仅将地图当前实际使用的优化图片接入该地图的资源配置。
