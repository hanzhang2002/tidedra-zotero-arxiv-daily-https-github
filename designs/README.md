# 界面设计实验区（designs/）

本目录存放主站之外的**备选前端设计**，用于对比取舍。当前包含一套「沉浸极简阅读版」（`reader/`）。

> 状态：**实验性、暂不定稿**。主人计划之后合适时机再在「经典版」与「阅读版」之间二选一，本文件用于记录决策背景与续作清单，方便未来接手时快速理解现状。

## 为什么放在仓库子目录，而不是父级同级目录

GitHub Pages 的部署工作流（`.github/workflows/deploy-pages.yml`）用 `actions/upload-pages-artifact` 且 `path: .`，即**把整个仓库根目录发布为站点**，并带有 `.nojekyll`。由此有两个硬约束：

- 仓库内任意子目录都会成为一个可访问 URL。`designs/reader/index.html` 对应 `https://<user>.github.io/<repo>/designs/reader/`。
- **父级同级目录（仓库之外）不会被部署**，Pages 根本抓不到；而且那会复制一份 `data/`（当前 900+ 篇），更新工作流只写一处，两份数据必然失同步。

因此备选设计必须放在仓库内、且**共享同一份 `data/`**，而不是做一份独立副本。

## 目录与文件

```text
designs/
  README.md          # 本说明文档
  reader/            # 沉浸极简阅读版（自包含，删除本目录即彻底移除该设计）
    index.html       # 阅读版骨架
    reader.css       # 阅读版样式（衬线 / 单栏 / 墨蓝强调 / 深浅色）
    reader.js        # 自包含数据层 + 渲染，不依赖经典版 assets/app.js
```

经典版（主站）仍是仓库根的 `index.html` + `assets/styles.css` + `assets/app.js`，**其逻辑未被改动**。唯一的增量是 `index.html` 顶栏多了一个羽毛图标的「切换到沉浸阅读版」链接（复用既有 `.icon-button` 样式，无新增 CSS）。

## 数据如何共享

`reader.js` 顶部有常量：

```js
const DATA_BASE = "../../";   // 本页面位于 designs/reader/，回退两级到仓库根
```

所有取数走 `DATA_BASE + "data/..."` 与 `DATA_BASE + "config/settings.json"`，读取的是与经典版**完全相同**的 JSON。`data/`、`scripts/`、`config/`、`tests/` 均未被本设计改动，阅读版直接吃现有数据，无需重跑抓取工作流。

相对路径 `../../data/...` 已实测：GitHub Pages 与本地 `python -m http.server` 下都能正确解析，不会被当作路径穿越拦截。

## 本地预览

在仓库根目录启动（绑定回环地址可避免 Windows 防火墙弹窗）：

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

- 经典版：`http://127.0.0.1:8000/`
- 阅读版：`http://127.0.0.1:8000/designs/reader/`

也可在经典版右上角点羽毛图标跳到阅读版；阅读版顶栏「经典版」按钮与页脚「返回经典版」链接可跳回。

## 阅读版设计取向

对标 Medium / Substack 的沉浸阅读体验，与经典版（卡片 / 红色点缀 / 上浮阴影）刻意拉开区分度：

- 单条居中窄栏（正文约 44rem），衬线标题与摘要，大行高、大留白。
- 论文之间用极细分隔线区隔，而非卡片盒子；hover 用下划线/变色，不用阴影上浮。
- 近单色配色 + 墨蓝强调（`#3a5a78`，深色模式 `#8fb4d6`），替代经典版的红。
- 顶栏细阅读进度条；摘要超长按「展开全文/收起」；`/` 聚焦搜索、`Esc` 清空搜索。
- 保留：日期导航、领域 chip 筛选、搜索命中高亮（跳过公式区域）、KaTeX 公式、深浅色（独立存储键 `personal-arxiv-daily-reader-theme`，与经典版互不干扰）。
- 字体走**本地衬线栈**（Source Han Serif / Noto Serif CJK / Songti SC / SimSun + 西文 Georgia），不引 Google Fonts，避免大陆网络加载卡顿，也守住零外部依赖红线。

## 已知差距与续作清单（按优先级）

二选一之前，若要让阅读版成为**公平的**候选，建议补齐：

1. **历史检索（最高优先）**：经典版有「当前日期 / 历史数据」范围切换，可跨月检索 900+ 篇；阅读版目前只做当日浏览。`reader.js` 里已保留 `loadHistory()`、`state.historyPapers`、`state.searchScope` 作为脚手架但**尚未接 UI**（属有意的预留，非遗漏）。续作需加一个克制的范围切换入口 + 历史加载进度反馈，并把 `scope` 同步进 URL。
2. **设置/自动化入口**：阅读版按极简定位**未搬**经典版的设置对话框（领域/关键词配置、导出）。若阅读版最终胜出，需决定是补一个精简设置入口，还是引导用户回经典版配置。
3. **沉浸阅读增强（可选）**：点击论文进入全宽专注阅读视图、正文宽度/字号可调、阅读进度记忆等。
4. **细节打磨（可选）**：键盘 `j/k` 在条目间跳转、返回顶部按钮、深色模式下公式配色微调。

## 定稿后的收尾路径

- **若保留经典版**：删除整个 `designs/` 目录，并还原 `index.html` 顶栏那一个羽毛图标链接（`class="icon-button design-switch"` 的 `<a>`）。干净退出，无其他残留。
- **若保留阅读版**：将 `designs/reader/` 提升为根——把 `reader.js` 的 `DATA_BASE` 改回 `""`，用阅读版三件套替换根 `index.html` / `assets/styles.css` / `assets/app.js`（或调整部署入口），并把经典版转存或删除。提升前务必先补齐上面第 1、2 项，避免功能倒退。

## 与主站文档的关系

主站的抓取/翻译/部署/数据结构说明见仓库根 [`README.md`](../README.md)。本文件只覆盖「备选前端设计」这一实验分支。
