# 小游戏大厅 (Mini-game Arcade)

689 款纯前端网页小游戏，全部静态托管在本目录，由门户首页的「小游戏大厅」卡片进入。

## 结构
- `index.html` — 大厅本体（单文件：搜索 / 随机 / 最近在玩 / 内置播放器 / 深链 `?g=<目录名>`）
- `catalog.json` — 游戏清单（目录名、显示名、入口文件、体积），`index.html` 里内联了同一份数据
- `GAMEZONE-LICENSE.txt` — 上游 Apache-2.0 许可证原文
- `<游戏目录>/` — 每个游戏一个自包含目录，入口统一为 `index.html`

## 来源与筛选
上游：[kunjgit/GameZone](https://github.com/kunjgit/GameZone)（Apache-2.0）。
原仓库 737 个游戏目录，进入本大厅前经过两道自动筛选：
1. 无 `index.html` 的目录剔除（37 个）；
2. **跨目录引用扫描**：解析每个 html/js/css 的 `src|href|poster|url()`，相对路径解析后跑到游戏目录之外的整个剔除（14 个）——
   这类游戏依赖仓库根的 `assets/`、`styles.css`、`sidebar.js`，单独搬运必然白屏，见 `build.py` 的 `escapes()`。

结果：689 个自包含游戏，约 1.9 GB。

## 重建 / 增量更新
```
python3 /opt/data/arcade_build/build.py            # 扫描 GameZone/Games → catalog.json + index.html
```
新增游戏后同步：先在 NAS 放置目录，再重跑 build 并上传 `index.html`（`?v=` 无需改，该页 `no-cache`）。
