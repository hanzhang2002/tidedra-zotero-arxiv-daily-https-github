/* ==========================================================================
   ArXiv 中文日报 · 阅读版（沉浸极简）
   --------------------------------------------------------------------------
   自包含脚本：不依赖经典版 app.js，读取同一份 data/。
   DATA_BASE 指向仓库根目录（本页面位于 designs/reader/，故为 ../../）。
   仅保留与"阅读"相关的能力：日期导航、搜索高亮、领域筛选、KaTeX、深浅色。
   ========================================================================== */

/* ---------- 常量与状态 -------------------------------------------------- */

const DATA_BASE = "../../";

const PATHS = {
  config: `${DATA_BASE}config/settings.json`,
  manifest: `${DATA_BASE}data/manifest.json`,
  day: (date) => `${DATA_BASE}data/days/${date}.json`,
  month: (month) => `${DATA_BASE}data/months/${month}.json`,
};

const THEME_KEY = "personal-arxiv-daily-reader-theme";
const PAGE_SIZE = 20;

const state = {
  config: null,
  manifest: null,
  selectedDate: null,
  dayPapers: [],
  historyPapers: null,
  filteredPapers: [],
  selectedCategories: new Set(),
  searchQuery: "",
  searchTokens: [],
  searchScope: "day",
  visibleCount: PAGE_SIZE,
};

const elements = {};

/* ---------- 初始化 ------------------------------------------------------ */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  initTheme();
  renderSkeleton(4);
  refreshIcons();

  try {
    const [config, manifest] = await Promise.all([
      fetchJSON(PATHS.config),
      fetchJSON(PATHS.manifest),
    ]);
    state.config = config;
    state.manifest = manifest;

    applyUrlState();
    if (!state.selectedDate) state.selectedDate = manifest.latest_date;
    elements.datePicker.value = state.selectedDate || "";

    await loadDay(state.selectedDate);
    if (state.searchScope === "history") await loadHistory();

    render();
    updateUrlState();
  } catch (error) {
    console.error(error);
    elements.feed.innerHTML = "";
    elements.resultSummary.textContent = "数据读取失败";
    elements.pageTitle.textContent = "无法加载数据";
    elements.emptyState.hidden = false;
    refreshIcons();
  }
}

function cacheElements() {
  const ids = [
    "readingProgress", "searchForm", "searchInput", "themeToggleButton",
    "olderDateButton", "newerDateButton", "datePicker", "pageTitle", "resultSummary",
    "categoryChips", "feed", "emptyState", "resetFiltersButton", "loadMoreWrap", "loadMoreButton",
  ];
  for (const id of ids) elements[id] = document.getElementById(id);
}

function bindEvents() {
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    setSearchQuery(elements.searchInput.value.trim());
    render();
    updateUrlState();
  });
  elements.searchInput.addEventListener("input", (event) => {
    setSearchQuery(event.target.value.trim());
    render();
    updateUrlState();
  });

  elements.olderDateButton.addEventListener("click", () => moveDate(1));
  elements.newerDateButton.addEventListener("click", () => moveDate(-1));
  elements.datePicker.addEventListener("change", () => selectDate(elements.datePicker.value));

  elements.categoryChips.addEventListener("click", handleCategoryClick);
  elements.resetFiltersButton.addEventListener("click", resetFilters);
  elements.loadMoreButton.addEventListener("click", () => {
    state.visibleCount += PAGE_SIZE;
    renderPapers();
  });

  // 摘要展开/收起（事件委托）
  elements.feed.addEventListener("click", handleExpandClick);

  window.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("scroll", updateReadingProgress, { passive: true });
  window.addEventListener("resize", updateReadingProgress);
  window.addEventListener("popstate", () => {
    applyUrlState();
    render();
  });
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape") {
    if (state.searchQuery || elements.searchInput.value) {
      elements.searchInput.value = "";
      setSearchQuery("");
      render();
      updateUrlState();
    }
    elements.searchInput.blur();
    return;
  }
  if (event.key === "/" && !isTypingTarget(event.target)) {
    event.preventDefault();
    elements.searchInput.focus();
    elements.searchInput.select();
  }
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

async function fetchJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Request failed: ${url} (${response.status})`);
  return response.json();
}

/* ---------- 主题 -------------------------------------------------------- */

function initTheme() {
  elements.themeToggleButton.addEventListener("click", toggleTheme);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (event) => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch { saved = null; }
    if (saved !== "dark" && saved !== "light") {
      document.documentElement.setAttribute("data-theme", event.matches ? "dark" : "light");
    }
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", listener);
  else if (typeof media.addListener === "function") media.addListener(listener);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* 隐私模式忽略 */ }
  elements.themeToggleButton.setAttribute(
    "title",
    next === "dark" ? "切换到浅色主题" : "切换到深色主题",
  );
}

/* ---------- URL 状态同步 ------------------------------------------------ */

function applyUrlState() {
  const params = new URLSearchParams(location.search);
  if (params.has("q")) {
    state.searchQuery = params.get("q") || "";
    state.searchTokens = computeSearchTokens(state.searchQuery);
    elements.searchInput.value = state.searchQuery;
  }
  if (params.has("date")) {
    const date = params.get("date") || "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) state.selectedDate = date;
  }
  if (params.has("cat")) {
    const raw = params.get("cat") || "";
    state.selectedCategories = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  }
}

function updateUrlState() {
  const params = new URLSearchParams();
  if (state.searchQuery) params.set("q", state.searchQuery);
  if (state.selectedDate) params.set("date", state.selectedDate);
  if (state.selectedCategories.size) params.set("cat", [...state.selectedCategories].join(","));
  const qs = params.toString();
  const url = qs ? `${location.pathname}?${qs}${location.hash}` : `${location.pathname}${location.hash}`;
  try { history.replaceState(null, "", url); } catch { /* 文件协议下忽略 */ }
}

/* ---------- 数据加载 ---------------------------------------------------- */

async function loadDay(date) {
  if (!date) {
    state.dayPapers = [];
    return;
  }
  try {
    const payload = await fetchJSON(PATHS.day(date));
    state.dayPapers = payload.papers || [];
  } catch {
    state.dayPapers = [];
  }
  state.visibleCount = PAGE_SIZE;
}

async function loadHistory() {
  if (state.historyPapers) return;
  const months = state.manifest.months || [];
  const papers = [];
  await Promise.all(
    months.map(async (month) => {
      try {
        const payload = await fetchJSON(PATHS.month(month));
        papers.push(...(payload.papers || []));
      } catch (error) {
        console.warn(`Failed to load ${month}`, error);
      }
    }),
  );
  state.historyPapers = deduplicatePapers(papers);
}

function deduplicatePapers(papers) {
  const unique = new Map();
  for (const paper of papers) unique.set(paper.id, paper);
  return [...unique.values()].sort((a, b) =>
    String(b.published).localeCompare(String(a.published)),
  );
}

/* ---------- 交互 -------------------------------------------------------- */

function setSearchQuery(query) {
  state.searchQuery = query;
  state.searchTokens = computeSearchTokens(query);
  state.visibleCount = PAGE_SIZE;
}

function handleCategoryClick(event) {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  const category = button.dataset.category;
  if (state.selectedCategories.has(category)) state.selectedCategories.delete(category);
  else state.selectedCategories.add(category);
  state.visibleCount = PAGE_SIZE;
  render();
  updateUrlState();
}

function resetFilters() {
  state.selectedCategories.clear();
  elements.searchInput.value = "";
  setSearchQuery("");
  state.visibleCount = PAGE_SIZE;
  render();
  updateUrlState();
}

function handleExpandClick(event) {
  const button = event.target.closest(".entry-expand");
  if (!button) return;
  const entry = button.closest(".entry");
  const abstract = entry && entry.querySelector(".entry-abstract");
  if (!abstract) return;
  const expanded = abstract.classList.toggle("expanded");
  abstract.classList.toggle("clamped", !expanded);
  button.classList.toggle("open", expanded);
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.querySelector(".entry-expand-label").textContent = expanded ? "收起" : "展开全文";
}

async function selectDate(date) {
  if (!date) return;
  state.selectedDate = date;
  await loadDay(date);
  render();
  updateUrlState();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function moveDate(offset) {
  const dates = (state.manifest.dates || []).map((item) => item.date);
  const currentIndex = dates.indexOf(state.selectedDate);
  const nextIndex = currentIndex + offset;
  if (currentIndex === -1 || nextIndex < 0 || nextIndex >= dates.length) return;
  elements.datePicker.value = dates[nextIndex];
  selectDate(dates[nextIndex]);
}

/* ---------- 过滤 & 高亮 & 数学公式 -------------------------------------- */

function filterPapers(papers) {
  const tokens = state.searchTokens;
  return papers.filter((paper) => {
    const categories = paper.categories || [];
    const categoryMatch =
      state.selectedCategories.size === 0 ||
      categories.some((category) => state.selectedCategories.has(category));
    if (!categoryMatch) return false;

    const haystack = normalizeText([
      paper.title, paper.title_zh, paper.abstract, paper.abstract_zh,
      ...(paper.authors || []), ...categories,
    ].join(" "));
    return tokens.length === 0 || tokens.every((token) => haystack.includes(token));
  });
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function computeSearchTokens(query) {
  return normalizeText(query).split(/\s+/).filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 在已 HTML 转义的文本上高亮命中，跳过数学公式区域避免破坏 KaTeX 解析。 */
function highlightMatches(escapedText, tokens) {
  if (!tokens || !tokens.length || !escapedText) return escapedText;
  const escapedTokens = tokens.map((t) => escapeHTML(t)).filter(Boolean);
  if (!escapedTokens.length) return escapedText;

  const mathSplit = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n<>]+?\$)/g;
  const parts = String(escapedText).split(mathSplit);
  const pattern = new RegExp(`(${escapedTokens.map(escapeRegExp).join("|")})`, "gi");

  return parts
    .map((part, index) => {
      if (index % 2 === 1 || part == null) return part ?? "";
      return part.replace(pattern, '<mark class="search-hit">$1</mark>');
    })
    .join("");
}

function renderMath(container) {
  if (!window.renderMathInElement || !container) return;
  try {
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
      errorColor: "#3a5a78",
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "mark"],
    });
  } catch (error) {
    console.warn("KaTeX rendering failed:", error);
  }
}

/* ---------- 渲染 -------------------------------------------------------- */

function render() {
  const source =
    state.searchScope === "history" && state.historyPapers
      ? state.historyPapers
      : state.dayPapers;
  state.filteredPapers = filterPapers(source);
  renderHeader();
  renderCategoryChips();
  renderPapers();
  updateNavigationState();
  refreshIcons();
  updateReadingProgress();
}

function renderHeader() {
  const title = formatDateTitle(state.selectedDate);
  elements.pageTitle.textContent = title;
  const scopeLabel = state.selectedDate || "当前日期";
  elements.resultSummary.textContent =
    `${scopeLabel} · 找到 ${state.filteredPapers.length} 篇论文`;
  document.title = `${title} · ${state.filteredPapers.length} 篇 · ArXiv 中文日报阅读版`;
}

function formatDateTitle(value) {
  if (!value) return "今日论文";
  const parsed = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "long", day: "numeric", weekday: "long",
  });
  return formatter.format(parsed);
}

function categoryLabel(code) {
  const item = (state.config?.available_categories || []).find((entry) => entry.code === code);
  return item ? item.name : code;
}

function renderCategoryChips() {
  const counts = new Map();
  for (const paper of state.dayPapers) {
    for (const category of paper.categories || []) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  elements.categoryChips.innerHTML = ordered
    .map(([code, count]) => {
      const active = state.selectedCategories.has(code);
      return `
        <button class="cat-chip ${active ? "active" : ""}" type="button"
                data-category="${escapeAttribute(code)}"
                aria-pressed="${active ? "true" : "false"}">
          ${escapeHTML(categoryLabel(code))}<small>${count}</small>
        </button>`;
    })
    .join("");
}

function renderPapers() {
  const visible = state.filteredPapers.slice(0, state.visibleCount);
  if (!visible.length) {
    elements.feed.innerHTML = "";
  } else {
    elements.feed.innerHTML = visible.map((paper, index) => renderPaper(paper, index)).join("");
    renderMath(elements.feed);
  }
  elements.emptyState.hidden = state.filteredPapers.length !== 0;
  elements.loadMoreWrap.hidden = state.visibleCount >= state.filteredPapers.length;
  refreshIcons();
}

function renderPaper(paper, index) {
  const translated = Boolean(paper.abstract_zh);
  const rawAbstract = paper.abstract_zh || paper.abstract || "暂无摘要";
  const rawTitle = paper.title_zh || paper.title || paper.id;
  const authorsText = formatAuthors(paper.authors || []);
  const tokens = state.searchTokens;
  const primaryCategory = paper.primary_category;
  const matchedKeywords = paper.matched_keywords || [];
  const keywordMatch = matchedKeywords.length > 0;
  const publishedDate = paper.announcement_date || String(paper.published || "").slice(0, 10);

  const absHref = escapeAttribute(
    paper.links?.abs || `https://arxiv.org/abs/${paper.arxiv_id || paper.id}`,
  );
  const pdfHref = escapeAttribute(
    paper.links?.pdf || `https://arxiv.org/pdf/${paper.arxiv_id || paper.id}`,
  );
  const arxivId = escapeHTML(paper.arxiv_id || paper.id);

  const titleHtml = highlightMatches(escapeHTML(rawTitle), tokens);
  const abstractHtml = highlightMatches(escapeHTML(rawAbstract), tokens);
  const authorsHtml = highlightMatches(escapeHTML(authorsText), tokens);
  const originalTitleHtml =
    paper.title_zh && paper.title
      ? `<p class="entry-original-title">${highlightMatches(escapeHTML(paper.title), tokens)}</p>`
      : "";

  const catTags = (paper.categories || [])
    .slice(0, 4)
    .map((category) => {
      const isPrimary = category === primaryCategory;
      return `<span class="entry-cat ${isPrimary ? "primary" : ""}">${escapeHTML(category)}</span>`;
    })
    .join("");

  const keywordTags = matchedKeywords
    .map((keyword) => `<span class="entry-cat keyword"># ${escapeHTML(keyword)}</span>`)
    .join("");

  const isLong = rawAbstract.length > 240;
  const abstractId = `entry-abstract-${index}`;
  const abstractBlock = `<div class="entry-abstract ${isLong ? "clamped" : ""}" id="${abstractId}">${abstractHtml}</div>`;
  const expandBlock = isLong
    ? `<button class="entry-expand" type="button" aria-expanded="false" aria-controls="${abstractId}">
         <span class="entry-expand-label">展开全文</span>
         <i data-lucide="chevron-down" aria-hidden="true"></i>
       </button>`
    : "";

  return `
    <article class="entry ${keywordMatch ? "keyword-match" : ""}">
      <div class="entry-meta">
        <span class="entry-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="entry-dot">·</span>
        <span>${escapeHTML(publishedDate)}</span>
        <span class="entry-dot">·</span>
        <span>${escapeHTML(categoryLabel(primaryCategory))}</span>
        <span class="entry-dot">·</span>
        <span class="entry-state ${translated ? "translated" : ""}">${translated ? "已译" : "原文"}</span>
      </div>
      <h2 class="entry-title"><a href="${absHref}" target="_blank" rel="noreferrer">${titleHtml}</a></h2>
      ${originalTitleHtml}
      <p class="entry-authors">${authorsHtml} · <span class="author-id">arXiv:${arxivId}</span></p>
      ${abstractBlock}
      ${expandBlock}
      <div class="entry-cats">${catTags}${keywordTags}</div>
      <div class="entry-links">
        <a href="${absHref}" target="_blank" rel="noreferrer"><i data-lucide="external-link" aria-hidden="true"></i>arXiv 摘要</a>
        <span class="sep">·</span>
        <a href="${pdfHref}" target="_blank" rel="noreferrer"><i data-lucide="file-text" aria-hidden="true"></i>PDF 全文</a>
      </div>
    </article>
  `;
}

function formatAuthors(authors) {
  if (!authors.length) return "作者信息缺失";
  if (authors.length <= 5) return authors.join("、");
  return `${authors.slice(0, 4).join("、")} 等 ${authors.length} 位作者`;
}

function updateNavigationState() {
  const dates = (state.manifest.dates || []).map((item) => item.date);
  const currentIndex = dates.indexOf(state.selectedDate);
  elements.olderDateButton.disabled = currentIndex === -1 || currentIndex >= dates.length - 1;
  elements.newerDateButton.disabled = currentIndex <= 0;
}

function renderSkeleton(count = 4) {
  const entry = `
    <div class="skeleton-entry" aria-hidden="true">
      <div class="skeleton-line xs skeleton-shimmer"></div>
      <div class="skeleton-line lg skeleton-shimmer"></div>
      <div class="skeleton-line sm skeleton-shimmer"></div>
      <div class="skeleton-line md skeleton-shimmer"></div>
      <div class="skeleton-line md skeleton-shimmer"></div>
    </div>`;
  elements.feed.innerHTML = entry.repeat(count);
}

/* ---------- 阅读进度条 -------------------------------------------------- */

function updateReadingProgress() {
  if (!elements.readingProgress) return;
  const doc = document.documentElement;
  const scrollable = doc.scrollHeight - doc.clientHeight;
  const ratio = scrollable > 0 ? doc.scrollTop / scrollable : 0;
  elements.readingProgress.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(2)}%`;
}

/* ---------- 图标 & 转义 ------------------------------------------------- */

function refreshIcons() {
  if (!window.lucide || typeof window.lucide.createIcons !== "function") return;
  try {
    window.lucide.createIcons({ attrs: { "stroke-width": 1.7 }, nameAttr: "data-lucide" });
  } catch {
    /* 忽略图标渲染异常 */
  }
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll("`", "&#096;");
}
