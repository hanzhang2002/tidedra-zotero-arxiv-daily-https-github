# ArXiv 中文日报

面向单人使用的静态 arXiv 论文阅读站。GitHub Actions 定时抓取指定领域的新论文，通过 DeepSeek 翻译标题和完整摘要，并把按日、按月归档的 JSON 数据提交到仓库；GitHub Pages 负责展示中文主页和历史检索。

## 已实现

- 按 arXiv 分类抓取论文，支持交叉分类
- 自定义英文关键词，可选择仅标记或抓取时过滤
- DeepSeek 自动翻译标题和完整摘要
- 中文标题与完整摘要，保留英文标题、原摘要、PDF 和 arXiv 链接
- 按日期浏览、领域筛选、当前日期搜索和历史归档搜索
- 按日及按月保存数据，自动去重并复用已有翻译
- GitHub Actions 工作日定时更新，GitHub Pages 自动部署
- 网页可设置领域和关键词，配置保存在浏览器并可导出为 `settings.json`

## arXiv 领域分类

领域编号来自 [arXiv Category Taxonomy](https://arxiv.org/category_taxonomy)，不是自定义论文标签。默认关注范围以统计学为主：

- 统计学：`stat.AP`、`stat.CO`、`stat.ME`、`stat.ML`、`stat.OT`、`stat.TH`
- 数学：`math.PR`、`math.OC`、`math.NA`，并提供组合数学和动力系统作为可选类别
- 数据与计算：从 arXiv Computer Science 中整理 `cs.DB`、`cs.LG`、`cs.IR` 等数据相关类别

arXiv 没有单独的 “Big Data” 顶层分区，因此“数据与计算”是本站对官方类别的导航分组；每篇论文仍保留原始 arXiv 分类编号。`stat.TH` 是官方对 `math.ST` 的别名，本站只列一次以避免重复。

## 本地预览

```powershell
python -m http.server 8000
```

打开 `http://localhost:8000/`。不能直接双击 `index.html`，浏览器会阻止页面读取本地 JSON 文件。

不调用 AI 接口测试抓取：

```powershell
python scripts/update_papers.py --no-translate
```

指定 arXiv UTC 投稿日期：

```powershell
python scripts/update_papers.py --date 2026-07-14 --no-translate
```

## GitHub 配置

1. 将代码推送到 GitHub 仓库的 `main` 分支。
2. 在仓库 `Settings > Secrets and variables > Actions` 添加 Secret：`OPENAI_API_KEY`。
3. 在 `Settings > Pages` 中将 Source 设为 `GitHub Actions`。
4. 打开 Actions，手动运行一次“更新 arXiv 数据”和“部署 GitHub Pages”。

工作流默认在工作日 `10:30 UTC`（北京时间 `18:30`）运行。第一次运行会创建真实论文数据。

工作流会实时输出每篇论文的翻译进度。单篇翻译最多尝试 2 次；连续 3 篇失败时会暂停后续 AI 调用，但仍保存此前成功结果和未翻译论文，避免接口异常时持续消耗 API。后续运行会自动重试尚未翻译的论文。整个任务最长运行 30 分钟。

## DeepSeek

默认的非敏感配置位于 [`config/settings.json`](config/settings.json)：

```json
{
  "ai": {
    "api_base": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "target_language": "简体中文",
    "thinking": "disabled",
    "max_tokens": 4096
  }
}
```

API Key 不应写入配置文件或前端，只由 GitHub Secret `OPENAI_API_KEY` 提供。

网页设置面板只提供领域和关键词配置，不暴露模型接口或密钥。“保存到本机”只影响当前浏览器；“导出配置”会下载完整 `settings.json`；“打开 GitHub 配置”会进入仓库中的实际配置文件，提交后下一次 GitHub Action 就会采用新配置。

## 数据结构

```text
data/
  manifest.json          # 日期、月份和总数索引
  days/YYYY-MM-DD.json   # 单日完整论文数据
  months/YYYY-MM.json    # 历史检索用月度数据
```

`fetch.retention_months` 控制归档保留月数，默认 24 个月。`fetch.max_results` 是一次 API 查询的最大论文数量；领域较多时应适当增大。

## 测试

```powershell
python -m unittest discover -s tests -v
```
