/* ==========================================================================
   ArXiv 中文日报 · 前端应用
   --------------------------------------------------------------------------
   模块：
     1. 常量与状态
     2. 初始化 & DOM 缓存 & 事件绑定
     3. 主题（浅色/深色）切换
     4. URL 状态同步（可分享/可回退）
     5. 数据加载（当日 & 历史归档）
     6. 过滤 & 搜索高亮 & 数学公式渲染
     7. 渲染（骨架屏、侧栏、论文卡片、活动筛选）
     8. 设置对话框
     9. 工具函数
   ========================================================================== */

/* ---------- 1. 常量与状态 ---------------------------------------------- */

const PATHS = {
  config: "config/settings.json",
  manifest: "data/manifest.json",
  day: (date) => `data/days/${date}.json`,
  month: (month) => `data/months/${month}.json`,
};

const STORAGE_KEY = "personal-arxiv-daily-settings-v3";
const THEME_KEY = "personal-arxiv-daily-theme";
const PAGE_SIZE = 20;

const state = {
  config: null,
  manifest: null,
  selectedDate: null,
  dayPapers: [],
  historyPapers: null,
  filteredPapers: [],
  selectedCategories: new Set(),
  automationCategories: [],
  keywords: [],
  keywordMode: "highlight",
  searchQuery: "",
  searchTokens: [],
  searchScope: "day",
  visibleCount: PAGE_SIZE,
};

const elements = {};

/* ---------- 2. 初始化 --------------------------------------------------- */

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

    applySavedSettings();
    applyUrlState();

    if (!state.selectedDate) state.selectedDate = state.manifest.latest_date;
    elements.datePicker.value = state.selectedDate || "";

    await loadDay(state.selectedDate);
    if (state.searchScope === "history") await loadHistory();

    populateSettingsDialog();
    updateGlobalMeta();
    render();
    updateUrlState();
  } catch (error) {
    console.error(error);
    elements.paperList.innerHTML = "";
    elements.resultSummary.textContent = "数据读取失败";
    elements.pageTitle.textContent = "无法加载数据";
    elements.emptyState.hidden = false;
    elements.syncText.textContent = "读取失败";
    refreshIcons();
  }
}

function cacheElements() {
  const ids = [
    "searchForm", "searchInput", "syncText", "mobileFilterButton", "mobileBackdrop",
    "themeToggleButton", "settingsButton", "filterSidebar", "olderDateButton", "newerDateButton",
    "datePicker", "clearCategoryButton", "categoryList", "keywordList", "dayPaperCount",
    "archivePaperCount", "translatedPaperCount", "pageTitle", "resultSummary", "demoBadge",
    "scopeControl", "activeFilters", "historyProgress", "historyProgressText", "historyProgressBar",
    "paperList", "emptyState", "resetFiltersButton", "loadMoreWrap", "loadMoreButton",
    "settingsDialog", "settingsForm", "closeSettingsButton", "settingsCategoryGrid",
    "settingsKeywords", "exportSettingsButton", "toast",
  ];
  for (const id of ids) elements[id] = document.getElementById(id);
}

function bindEvents() {
  elements.searchForm.addEventListener("submit", handleSearch);
  elements.searchInput.addEventListener("input", handleSearchInput);
  elements.settingsButton.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
  elements.settingsDialog.addEventListener("click", handleDialogBackdropClick);
  elements.settingsForm.addEventListener("submit", saveSettings);
  elements.exportSettingsButton.addEventListener("click", exportSettings);
  elements.clearCategoryButton.addEventListener("click", clearCategories);
  elements.resetFiltersButton.addEventListener("click", resetFilters);
  elements.loadMoreButton.addEventListener("click", () => {
    state.visibleCount += PAGE_SIZE;
    renderPapers();
  });
  elements.olderDateButton.addEventListener("click", () => moveDate(1));
  elements.newerDateButton.addEventListener("click", () => moveDate(-1));
  elements.datePicker.addEventListener("change", () => selectDate(elements.datePicker.value));
  elements.categoryList.addEventListener("click", handleCategoryClick);
  elements.keywordList.addEventListener("click", handleKeywordClick);
  elements.scopeControl.addEventListener("change", handleScopeChange);
  elements.mobileFilterButton.addEventListener("click", toggleMobileSidebar);
  elements.mobileBackdrop.addEventListener("click", closeMobileSidebar);
  window.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("popstate", () => {
    applyUrlState();
    render();
  });
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape") closeMobileSidebar();
  // "/" 快捷键聚焦搜索框，除非已经在输入控件里
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

function applySavedSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    saved = {};
  }
  const research = state.config.research || {};
  state.automationCategories = saved.categories || research.categories || [];
  state.selectedCategories = new Set(state.automationCategories);
  state.keywords = saved.keywords || research.keywords || [];
  state.keywordMode = saved.keywordMode || research.keyword_mode || "highlight";
}

/* ---------- 3. 主题切换 ------------------------------------------------- */

function initTheme() {
  elements.themeToggleButton.addEventListener("click", toggleTheme);
  // 用户没有显式偏好时，跟随系统主题变化
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

/* ---------- 4. URL 状态同步 --------------------------------------------- */

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
    state.selectedCategories = new Set(
      raw.split(",").map((s) => s.trim()).filter(Boolean),
    );
  }

  if (params.has("scope")) {
    const scope = params.get("scope");
    if (scope === "history" || scope === "day") {
      state.searchScope = scope;
      const radio = elements.scopeControl.querySelector(`input[value="${scope}"]`);
      if (radio) radio.checked = true;
    }
  }
}

function updateUrlState() {
  const params = new URLSearchParams();
  if (state.searchQuery) params.set("q", state.searchQuery);
  if (state.searchScope === "history") {
    params.set("scope", "history");
  } else if (state.selectedDate) {
    params.set("date", state.selectedDate);
  }
  if (state.selectedCategories.size) {
    params.set("cat", [...state.selectedCategories].join(","));
  }
  const qs = params.toString();
  const url = qs ? `${location.pathname}?${qs}${location.hash}` : `${location.pathname}${location.hash}`;
  try {
    history.replaceState(null, "", url);
  } catch {
    /* 文件协议下 history API 可能受限，忽略 */
  }
}

/* ---------- 5. 数据加载 ------------------------------------------------- */

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
  elements.historyProgress.hidden = false;
  elements.historyProgressBar.max = Math.max(months.length, 1);
  elements.historyProgressBar.value = 0;
  elements.historyProgressText.textContent = `0/${months.length}`;
  const papers = [];

  const requests = months.map(async (month) => {
    try {
      const payload = await fetchJSON(PATHS.month(month));
      papers.push(...(payload.papers || []));
    } catch (error) {
      console.warn(`Failed to load ${month}`, error);
    } finally {
      elements.historyProgressBar.value += 1;
      elements.historyProgressText.textContent =
        `${elements.historyProgressBar.value}/${months.length}`;
    }
  });

  await Promise.all(requests);
  state.historyPapers = deduplicatePapers(papers);
  elements.historyProgress.hidden = true;
}

function deduplicatePapers(papers) {
  const unique = new Map();
  for (const paper of papers) unique.set(paper.id, paper);
  return [...unique.values()].sort((a, b) =>
    String(b.published).localeCompare(String(a.published)),
  );
}

/* ---------- 6. 交互处理 ------------------------------------------------- */

async function handleSearch(event) {
  event.preventDefault();
  setSearchQuery(elements.searchInput.value.trim());
  if (state.searchScope === "history") await loadHistory();
  render();
  updateUrlState();
  closeMobileSidebar();
}

function handleSearchInput(event) {
  setSearchQuery(event.target.value.trim());
  render();
  updateUrlState();
}

function setSearchQuery(query) {
  state.searchQuery = query;
  state.searchTokens = computeSearchTokens(query);
  state.visibleCount = PAGE_SIZE;
}

async function handleScopeChange(event) {
  if (!event.target.matches('input[name="searchScope"]')) return;
  state.searchScope = event.target.value;
  state.visibleCount = PAGE_SIZE;
  if (state.searchScope === "history") await loadHistory();
  render();
  updateUrlState();
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

function handleKeywordClick(event) {
  const button = event.target.closest("[data-keyword]");
  if (!button) return;
  const keyword = button.dataset.keyword;
  elements.searchInput.value = keyword;
  setSearchQuery(keyword);
  render();
  updateUrlState();
}

function clearCategories() {
  state.selectedCategories.clear();
  state.visibleCount = PAGE_SIZE;
  render();
  updateUrlState();
}

function resetFilters() {
  state.selectedCategories.clear();
  elements.searchInput.value = "";
  setSearchQuery("");
  state.searchScope = "day";
  const scopeInput = elements.scopeControl.querySelector('input[value="day"]');
  if (scopeInput) scopeInput.checked = true;
  state.visibleCount = PAGE_SIZE;
  render();
  updateUrlState();
}

async function selectDate(date) {
  if (!date) return;
  state.selectedDate = date;
  if (state.searchScope !== "day") {
    state.searchScope = "day";
    const scopeInput = elements.scopeControl.querySelector('input[value="day"]');
    if (scopeInput) scopeInput.checked = true;
  }
  await loadDay(date);
  render();
  updateUrlState();
}

function moveDate(offset) {
  const dates = (state.manifest.dates || []).map((item) => item.date);
  const currentIndex = dates.indexOf(state.selectedDate);
  const nextIndex = currentIndex + offset;
  if (currentIndex === -1 || nextIndex < 0 || nextIndex >= dates.length) return;
  elements.datePicker.value = dates[nextIndex];
  selectDate(dates[nextIndex]);
}

/* ---------- 7. 过滤 & 高亮 & 数学公式 ----------------------------------- */

function filterPapers(papers) {
  const tokens = state.searchTokens;
  return papers.filter((paper) => {
    const categories = paper.categories || [];
    const categoryMatch =
      state.selectedCategories.size === 0 ||
      categories.some((category) => state.selectedCategories.has(category));
    if (!categoryMatch) return false;

    const haystack = normalizeText([
      paper.title,
      paper.title_zh,
      paper.abstract,
      paper.abstract_zh,
      ...(paper.authors || []),
      ...categories,
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

/**
 * 在已 HTML 转义的文本上高亮搜索命中，跳过数学公式区域避免破坏 KaTeX 解析。
 */
function highlightMatches(escapedText, tokens) {
  if (!tokens || !tokens.length || !escapedText) return escapedText;
  const escapedTokens = tokens.map((t) => escapeHTML(t)).filter(Boolean);
  if (!escapedTokens.length) return escapedText;

  const mathSplit = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n<>]+?\$)/g;
  const parts = String(escapedText).split(mathSplit);
  const pattern = new RegExp(`(${escapedTokens.map(escapeRegExp).join("|")})`, "gi");

  return parts
    .map((part, index) => {
      // split 用一个外层捕获组时，奇数索引恰好是被捕获的数学区域，需要跳过
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
      errorColor: "#b8322d",
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "mark"],
    });
  } catch (error) {
    console.warn("KaTeX rendering failed:", error);
  }
}

/* ---------- 8. 渲染 ----------------------------------------------------- */

function render() {
  const source =
    state.searchScope === "history" && state.historyPapers
      ? state.historyPapers
      : state.dayPapers;
  state.filteredPapers = filterPapers(source);
  renderHeader();
  renderCategoryList();
  renderKeywords();
  renderActiveFilters();
  renderPapers();
  updateNavigationState();
  refreshIcons();
}

function renderHeader() {
  const isHistory = state.searchScope === "history";
  elements.pageTitle.textContent = isHistory ? "历史检索" : formatDateTitle(state.selectedDate);
  const scopeLabel = isHistory ? "历史归档" : state.selectedDate || "当前日期";
  elements.resultSummary.textContent =
    `${scopeLabel} · 找到 ${state.filteredPapers.length} 篇论文`;
  elements.demoBadge.hidden = !state.manifest.demo;
  elements.dayPaperCount.textContent = `${state.dayPapers.length} 篇`;
  elements.archivePaperCount.textContent = `${state.manifest.stats?.total || 0} 篇`;
  elements.translatedPaperCount.textContent = `${state.manifest.stats?.translated || 0} 篇`;
}

function formatDateTitle(value) {
  if (!value) return "今日论文";
  const parsed = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  return formatter.format(parsed);
}

function renderCategoryList() {
  const counts = new Map();
  for (const paper of state.dayPapers) {
    for (const category of paper.categories || []) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }
  const available = state.config.available_categories || [];
  const visible = available.filter(
    (item) => counts.has(item.code) || state.automationCategories.includes(item.code),
  );
  elements.categoryList.innerHTML = groupCategories(visible)
    .map((group) => `
      <section class="category-group">
        <h3>${escapeHTML(group.name)}</h3>
        <div class="category-group-items">
          ${group.items
            .map((item) => {
              const active = state.selectedCategories.has(item.code);
              const count = counts.get(item.code) || 0;
              return `
                <button class="category-button ${active ? "active" : ""}" type="button"
                        data-category="${escapeAttribute(item.code)}"
                        aria-pressed="${active ? "true" : "false"}">
                  <span class="category-name">${escapeHTML(item.name)}<small>${escapeHTML(item.code)}</small></span>
                  <span class="category-count">${count}</span>
                </button>
              `;
            })
            .join("")}
        </div>
      </section>
    `)
    .join("");
}

function groupCategories(categories) {
  const groups = new Map();
  for (const item of categories) {
    const group = item.group || "其他";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  return [...groups].map(([name, items]) => ({ name, items }));
}

function renderKeywords() {
  elements.keywordList.innerHTML = state.keywords.length
    ? state.keywords
        .map(
          (keyword) =>
            `<button class="keyword-chip" type="button" data-keyword="${escapeAttribute(keyword)}" title="搜索 ${escapeAttribute(keyword)}">${escapeHTML(keyword)}</button>`,
        )
        .join("")
    : '<span class="category-count">未设置</span>';
}

function renderActiveFilters() {
  const chips = [];
  if (state.searchQuery) {
    chips.push(`<span class="filter-chip">搜索 <strong>${escapeHTML(state.searchQuery)}</strong></span>`);
  }
  if (state.selectedCategories.size) {
    const groups = new Set([...state.selectedCategories].map(categoryGroup));
    chips.push(
      `<span class="filter-chip">领域 <strong>${escapeHTML([...groups].join("、"))}</strong> · ${state.selectedCategories.size}</span>`,
    );
  }
  if (state.searchScope === "history") {
    chips.push('<span class="filter-chip">范围 <strong>历史归档</strong></span>');
  }
  elements.activeFilters.innerHTML = chips.join("");
  elements.activeFilters.hidden = chips.length === 0;
}

function categoryName(code) {
  const item = (state.config.available_categories || []).find((entry) => entry.code === code);
  return item ? item.name : code;
}

function categoryGroup(code) {
  const item = (state.config.available_categories || []).find((entry) => entry.code === code);
  return item ? item.group || item.name : categoryName(code);
}

function renderPapers() {
  const visible = state.filteredPapers.slice(0, state.visibleCount);
  if (!visible.length) {
    elements.paperList.innerHTML = "";
  } else {
    elements.paperList.innerHTML = visible.map((paper, index) => renderPaper(paper, index)).join("");
    renderMath(elements.paperList);
  }
  elements.emptyState.hidden = state.filteredPapers.length !== 0;
  elements.loadMoreWrap.hidden = state.visibleCount >= state.filteredPapers.length;
  refreshIcons(elements.paperList);
}

function renderPaper(paper, index) {
  const translated = Boolean(paper.abstract_zh);
  const rawAbstract = paper.abstract_zh || paper.abstract || "暂无摘要";
  const rawTitle = paper.title_zh || paper.title || paper.id;
  const authorsText = formatAuthors(paper.authors || []);
  const categories = (paper.categories || []).slice(0, 4);
  const primaryCategory = paper.primary_category;
  const matchedKeywords = paper.matched_keywords || [];
  const keywordMatch = matchedKeywords.length > 0;
  const publishedDate =
    paper.announcement_date || String(paper.published || "").slice(0, 10);
  const tokens = state.searchTokens;
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
      ? `<p class="paper-title-original">${highlightMatches(escapeHTML(paper.title), tokens)}</p>`
      : "";
  const originalBlock = paper.abstract
    ? `<div class="original-abstract"><strong>Abstract</strong>${highlightMatches(
        escapeHTML(paper.abstract),
        tokens,
      )}</div>`
    : "";

  const categoryTags = categories
    .map((category) => {
      const isPrimary = category === primaryCategory;
      return `<span class="paper-tag ${isPrimary ? "primary" : ""}" title="${
        isPrimary ? "主分类" : "交叉分类"
      }">${escapeHTML(category)}</span>`;
    })
    .join("");

  const keywordTags = matchedKeywords
    .map(
      (keyword) =>
        `<span class="paper-tag keyword" title="命中关键词"># ${highlightMatches(
          escapeHTML(keyword),
          tokens,
        )}</span>`,
    )
    .join("");

  const statusLabel = translated ? "已译" : "原文";
  const statusTitle = translated ? "已翻译中文摘要" : "仅英文原文摘要";

  return `
    <article class="paper-row ${keywordMatch ? "keyword-match" : ""}">
      <div class="paper-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</div>
      <div class="paper-body">
        <div class="paper-meta-row">
          ${categoryTags}
          ${keywordTags}
          <span class="translation-state ${translated ? "translated" : ""}" title="${statusTitle}">${statusLabel} · ${escapeHTML(publishedDate)}</span>
        </div>
        <h2 class="paper-title"><a href="${absHref}" target="_blank" rel="noreferrer">${titleHtml}</a></h2>
        ${originalTitleHtml}
        <p class="paper-authors">${authorsHtml} · <span class="author-id">arXiv:${arxivId}</span></p>
        <p class="translated-abstract clamped">${abstractHtml}</p>
        <details class="paper-details">
          <summary>展开全文</summary>
          <p class="translated-abstract">${abstractHtml}</p>
          ${originalBlock}
        </details>
        <div class="paper-actions">
          <a class="paper-action" href="${absHref}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i>abs</a>
          <a class="paper-action" href="${pdfHref}" target="_blank" rel="noreferrer"><i data-lucide="file-text"></i>pdf</a>
        </div>
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
  elements.olderDateButton.disabled =
    currentIndex === -1 || currentIndex >= dates.length - 1;
  elements.newerDateButton.disabled = currentIndex <= 0;
}

function updateGlobalMeta() {
  const updated = state.manifest.updated_at ? new Date(state.manifest.updated_at) : null;
  if (!updated || Number.isNaN(updated.getTime())) {
    elements.syncText.textContent = "数据时间未知";
    return;
  }
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  elements.syncText.textContent = `更新于 ${formatter.format(updated)}`;
}

function renderSkeleton(count = 4) {
  const row = `
    <div class="skeleton-row" aria-hidden="true">
      <div class="skeleton-index skeleton-shimmer"></div>
      <div class="skeleton-body">
        <div class="skeleton-line sm skeleton-shimmer"></div>
        <div class="skeleton-line lg skeleton-shimmer"></div>
        <div class="skeleton-line xs skeleton-shimmer"></div>
        <div class="skeleton-line md skeleton-shimmer"></div>
        <div class="skeleton-line md skeleton-shimmer"></div>
      </div>
    </div>
  `;
  elements.paperList.innerHTML = row.repeat(count);
}

/* ---------- 9. 设置对话框 ---------------------------------------------- */

function populateSettingsDialog() {
  elements.settingsCategoryGrid.innerHTML = groupCategories(
    state.config.available_categories || [],
  )
    .map((group) => `
      <fieldset class="settings-category-group">
        <legend>${escapeHTML(group.name)}</legend>
        <div class="settings-category-options">
          ${group.items
            .map(
              (item) => `
                <label>
                  <input type="checkbox" name="settingsCategory" value="${escapeAttribute(item.code)}"
                         ${state.automationCategories.includes(item.code) ? "checked" : ""}>
                  <span>${escapeHTML(item.name)}<small>${escapeHTML(item.code)}</small></span>
                </label>
              `,
            )
            .join("")}
        </div>
      </fieldset>
    `)
    .join("");
  elements.settingsKeywords.value = state.keywords.join(", ");
  const keywordRadio = elements.settingsForm.querySelector(
    `input[name="keywordMode"][value="${state.keywordMode}"]`,
  );
  if (keywordRadio) keywordRadio.checked = true;
  refreshIcons(elements.settingsCategoryGrid);
}

function openSettings() {
  populateSettingsDialog();
  elements.settingsDialog.showModal();
}

function handleDialogBackdropClick(event) {
  if (event.target === elements.settingsDialog) elements.settingsDialog.close();
}

function collectSettings() {
  const categories = [
    ...elements.settingsForm.querySelectorAll('input[name="settingsCategory"]:checked'),
  ].map((input) => input.value);
  const keywordMode =
    elements.settingsForm.querySelector('input[name="keywordMode"]:checked')?.value ||
    "highlight";
  const keywords = elements.settingsKeywords.value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return { categories, keywords, keywordMode };
}

function saveSettings(event) {
  event.preventDefault();
  const settings = collectSettings();
  if (settings.categories.length === 0) {
    showToast("至少选择一个用于自动抓取的研究领域");
    return;
  }
  state.automationCategories = settings.categories;
  state.selectedCategories = new Set(settings.categories);
  state.keywords = settings.keywords;
  state.keywordMode = settings.keywordMode;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 忽略存储失败 */
  }
  elements.settingsDialog.close();
  state.visibleCount = PAGE_SIZE;
  render();
  updateUrlState();
  showToast("设置已保存到当前浏览器");
}

function exportSettings() {
  const settings = collectSettings();
  if (settings.categories.length === 0) {
    showToast("至少选择一个用于自动抓取的研究领域");
    return;
  }
  const exported = JSON.parse(JSON.stringify(state.config));
  exported.research.categories = settings.categories;
  exported.research.keywords = settings.keywords;
  exported.research.keyword_mode = settings.keywordMode;
  const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "settings.json";
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("配置文件已导出");
}

/* ---------- 10. UI 辅助 ------------------------------------------------- */

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function toggleMobileSidebar() {
  const open = !elements.filterSidebar.classList.contains("open");
  elements.filterSidebar.classList.toggle("open", open);
  elements.mobileBackdrop.hidden = !open;
}

function closeMobileSidebar() {
  elements.filterSidebar.classList.remove("open");
  elements.mobileBackdrop.hidden = true;
}

function refreshIcons(scope) {
  if (!window.lucide) return;
  const options = { attrs: { "stroke-width": 1.8 } };
  if (scope && typeof window.lucide.createIcons === "function") {
    // lucide 支持通过 elements 参数限定作用范围；旧版本会忽略
    try {
      const nodes = scope.querySelectorAll("[data-lucide]");
      if (nodes.length) {
        window.lucide.createIcons({ ...options, nameAttr: "data-lucide" });
      }
    } catch {
      window.lucide.createIcons(options);
    }
  } else if (typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons(options);
  }
}

/* ---------- 11. 转义工具 ----------------------------------------------- */

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
