const PATHS = {
  config: "config/settings.json",
  manifest: "data/manifest.json",
  day: (date) => `data/days/${date}.json`,
  month: (month) => `data/months/${month}.json`,
};

const STORAGE_KEY = "personal-arxiv-daily-settings-v3";
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
  searchScope: "day",
  visibleCount: PAGE_SIZE,
};

const elements = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  refreshIcons();

  try {
    [state.config, state.manifest] = await Promise.all([
      fetchJSON(PATHS.config),
      fetchJSON(PATHS.manifest),
    ]);
    applySavedSettings();
    state.selectedDate = state.manifest.latest_date;
    elements.datePicker.value = state.selectedDate || "";
    await loadDay(state.selectedDate);
    populateSettingsDialog();
    updateGlobalMeta();
    render();
  } catch (error) {
    console.error(error);
    elements.paperList.innerHTML = "";
    elements.resultSummary.textContent = "数据读取失败，请通过本地服务器或 GitHub Pages 打开本站";
    elements.emptyState.hidden = false;
    refreshIcons();
  }
}

function cacheElements() {
  const ids = [
    "searchForm", "searchInput", "syncText", "mobileFilterButton", "mobileBackdrop",
    "settingsButton", "filterSidebar", "olderDateButton", "newerDateButton", "datePicker",
    "clearCategoryButton", "categoryList", "keywordList", "dayPaperCount", "archivePaperCount",
    "translatedPaperCount", "pageTitle", "resultSummary", "demoBadge", "scopeControl",
    "activeFilters", "historyProgress", "historyProgressText", "historyProgressBar", "paperList",
    "emptyState", "resetFiltersButton", "loadMoreWrap", "loadMoreButton", "settingsDialog",
    "settingsForm", "closeSettingsButton", "settingsCategoryGrid", "settingsKeywords",
    "exportSettingsButton", "toast",
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
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMobileSidebar();
  });
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
      elements.historyProgressText.textContent = `${elements.historyProgressBar.value}/${months.length}`;
    }
  });

  await Promise.all(requests);
  state.historyPapers = deduplicatePapers(papers);
  elements.historyProgress.hidden = true;
}

function deduplicatePapers(papers) {
  const unique = new Map();
  for (const paper of papers) unique.set(paper.id, paper);
  return [...unique.values()].sort((a, b) => String(b.published).localeCompare(String(a.published)));
}

async function handleSearch(event) {
  event.preventDefault();
  state.searchQuery = elements.searchInput.value.trim();
  state.visibleCount = PAGE_SIZE;
  if (state.searchScope === "history") await loadHistory();
  render();
  closeMobileSidebar();
}

function handleSearchInput(event) {
  state.searchQuery = event.target.value.trim();
  state.visibleCount = PAGE_SIZE;
  render();
}

async function handleScopeChange(event) {
  if (!event.target.matches('input[name="searchScope"]')) return;
  state.searchScope = event.target.value;
  state.visibleCount = PAGE_SIZE;
  if (state.searchScope === "history") await loadHistory();
  render();
}

function handleCategoryClick(event) {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  const category = button.dataset.category;
  if (state.selectedCategories.has(category)) state.selectedCategories.delete(category);
  else state.selectedCategories.add(category);
  state.visibleCount = PAGE_SIZE;
  render();
}

function handleKeywordClick(event) {
  const button = event.target.closest("[data-keyword]");
  if (!button) return;
  elements.searchInput.value = button.dataset.keyword;
  state.searchQuery = button.dataset.keyword;
  state.visibleCount = PAGE_SIZE;
  render();
}

function clearCategories() {
  state.selectedCategories.clear();
  state.visibleCount = PAGE_SIZE;
  render();
}

function resetFilters() {
  state.selectedCategories.clear();
  state.searchQuery = "";
  elements.searchInput.value = "";
  state.searchScope = "day";
  const scopeInput = elements.scopeControl.querySelector('input[value="day"]');
  if (scopeInput) scopeInput.checked = true;
  state.visibleCount = PAGE_SIZE;
  render();
}

async function selectDate(date) {
  if (!date) return;
  state.selectedDate = date;
  state.searchScope = "day";
  const scopeInput = elements.scopeControl.querySelector('input[value="day"]');
  if (scopeInput) scopeInput.checked = true;
  await loadDay(date);
  render();
}

function moveDate(offset) {
  const dates = (state.manifest.dates || []).map((item) => item.date);
  const currentIndex = dates.indexOf(state.selectedDate);
  const nextIndex = currentIndex + offset;
  if (currentIndex === -1 || nextIndex < 0 || nextIndex >= dates.length) return;
  elements.datePicker.value = dates[nextIndex];
  selectDate(dates[nextIndex]);
}

function render() {
  const source = state.searchScope === "history" && state.historyPapers ? state.historyPapers : state.dayPapers;
  state.filteredPapers = filterPapers(source);
  renderHeader();
  renderCategoryList();
  renderKeywords();
  renderActiveFilters();
  renderPapers();
  updateNavigationState();
  refreshIcons();
}

function filterPapers(papers) {
  const queryTokens = normalizeText(state.searchQuery).split(/\s+/).filter(Boolean);
  return papers.filter((paper) => {
    const categories = paper.categories || [];
    const categoryMatch =
      state.selectedCategories.size === 0 || categories.some((category) => state.selectedCategories.has(category));
    if (!categoryMatch) return false;

    const haystack = normalizeText([
      paper.title,
      paper.title_zh,
      paper.abstract,
      paper.abstract_zh,
      ...(paper.authors || []),
      ...categories,
    ].join(" "));
    const queryMatch = queryTokens.length === 0 || queryTokens.every((token) => haystack.includes(token));
    return queryMatch;
  });
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function renderHeader() {
  const isHistory = state.searchScope === "history";
  elements.pageTitle.textContent = isHistory ? "历史检索" : formatDateTitle(state.selectedDate);
  const scopeLabel = isHistory ? "历史归档" : state.selectedDate || "当前日期";
  elements.resultSummary.textContent = `${scopeLabel} · 找到 ${state.filteredPapers.length} 篇论文`;
  elements.demoBadge.hidden = !state.manifest.demo;
  elements.dayPaperCount.textContent = `${state.dayPapers.length} 篇`;
  elements.archivePaperCount.textContent = `${state.manifest.stats?.total || 0} 篇`;
  elements.translatedPaperCount.textContent = `${state.manifest.stats?.translated || 0} 篇`;
}

function formatDateTitle(value) {
  if (!value) return "今日论文";
  const parsed = new Date(`${value}T00:00:00+08:00`);
  const formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  return formatter.format(parsed);
}

function renderCategoryList() {
  const counts = new Map();
  for (const paper of state.dayPapers) {
    for (const category of paper.categories || []) counts.set(category, (counts.get(category) || 0) + 1);
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
          ${group.items.map((item) => `
            <button class="category-button ${state.selectedCategories.has(item.code) ? "active" : ""}" type="button" data-category="${escapeAttribute(item.code)}">
              <span class="category-name">${escapeHTML(item.name)} <small>${escapeHTML(item.code)}</small></span>
              <span class="category-count">${counts.get(item.code) || 0}</span>
            </button>
          `).join("")}
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
    ? state.keywords.map((keyword) => `<button class="keyword-chip" type="button" data-keyword="${escapeAttribute(keyword)}">${escapeHTML(keyword)}</button>`).join("")
    : '<span class="category-count">未设置</span>';
}

function renderActiveFilters() {
  const chips = [];
  if (state.searchQuery) chips.push(`搜索：${escapeHTML(state.searchQuery)}`);
  if (state.selectedCategories.size) {
    const selectedGroups = new Set(
      [...state.selectedCategories].map(categoryGroup),
    );
    chips.push(`领域：${escapeHTML([...selectedGroups].join("、"))}（${state.selectedCategories.size} 项）`);
  }
  if (state.searchScope === "history") chips.push("范围：历史数据");
  elements.activeFilters.innerHTML = chips.map((chip) => `<span class="filter-chip">${chip}</span>`).join("");
  elements.activeFilters.hidden = chips.length === 0;
}

function categoryName(code) {
  return state.config.available_categories.find((item) => item.code === code)?.name || code;
}

function categoryGroup(code) {
  return state.config.available_categories.find((item) => item.code === code)?.group || categoryName(code);
}

function renderPapers() {
  const visible = state.filteredPapers.slice(0, state.visibleCount);
  elements.paperList.innerHTML = visible.map((paper, index) => renderPaper(paper, index)).join("");
  elements.emptyState.hidden = state.filteredPapers.length !== 0;
  elements.loadMoreWrap.hidden = state.visibleCount >= state.filteredPapers.length;
  refreshIcons();
}

function renderPaper(paper, index) {
  const translated = Boolean(paper.abstract_zh);
  const abstract = paper.abstract_zh || paper.abstract || "暂无摘要";
  const title = paper.title_zh || paper.title || paper.id;
  const authors = formatAuthors(paper.authors || []);
  const categories = (paper.categories || []).slice(0, 4);
  const matchedKeywords = paper.matched_keywords || [];
  const keywordMatch = matchedKeywords.length > 0;
  const publishedDate = paper.announcement_date || String(paper.published || "").slice(0, 10);
  const statusText = translated ? "中文摘要" : "原文摘要";
  const originalBlock = paper.abstract
    ? `<div class="original-abstract"><strong>原文摘要</strong><br>${escapeHTML(paper.abstract)}</div>`
    : "";

  return `
    <article class="paper-row ${keywordMatch ? "keyword-match" : ""}">
      <div class="paper-index">${String(index + 1).padStart(2, "0")}</div>
      <div class="paper-body">
        <div class="paper-meta-row">
          ${categories.map((category, tagIndex) => `<span class="paper-tag ${tagIndex ? "secondary" : ""}">${escapeHTML(category)}</span>`).join("")}
          ${matchedKeywords.map((keyword) => `<span class="paper-tag"># ${escapeHTML(keyword)}</span>`).join("")}
          <span class="translation-state ${translated ? "translated" : ""}">${statusText} · ${escapeHTML(publishedDate)}</span>
        </div>
        <h2 class="paper-title"><a href="${escapeAttribute(paper.links?.abs || `https://arxiv.org/abs/${paper.arxiv_id || paper.id}`)}" target="_blank" rel="noreferrer">${escapeHTML(title)}</a></h2>
        ${paper.title_zh && paper.title ? `<p class="paper-title-original">${escapeHTML(paper.title)}</p>` : ""}
        <p class="paper-authors">${escapeHTML(authors)} · arXiv:${escapeHTML(paper.arxiv_id || paper.id)}</p>
        <p class="translated-abstract clamped">${escapeHTML(abstract)}</p>
        <details class="paper-details">
          <summary>展开摘要</summary>
          <p class="translated-abstract">${escapeHTML(abstract)}</p>
          ${originalBlock}
        </details>
        <div class="paper-actions">
          <a class="paper-action" href="${escapeAttribute(paper.links?.abs || `https://arxiv.org/abs/${paper.arxiv_id || paper.id}`)}" target="_blank" rel="noreferrer"><i data-lucide="external-link"></i>原文</a>
          <a class="paper-action" href="${escapeAttribute(paper.links?.pdf || `https://arxiv.org/pdf/${paper.arxiv_id || paper.id}`)}" target="_blank" rel="noreferrer"><i data-lucide="file-text"></i>PDF</a>
        </div>
      </div>
    </article>
  `;
}

function formatAuthors(authors) {
  if (authors.length <= 5) return authors.join("、");
  return `${authors.slice(0, 4).join("、")} 等 ${authors.length} 位作者`;
}

function updateNavigationState() {
  const dates = (state.manifest.dates || []).map((item) => item.date);
  const currentIndex = dates.indexOf(state.selectedDate);
  elements.olderDateButton.disabled = currentIndex === -1 || currentIndex >= dates.length - 1;
  elements.newerDateButton.disabled = currentIndex <= 0;
}

function updateGlobalMeta() {
  const updated = state.manifest.updated_at ? new Date(state.manifest.updated_at) : null;
  if (!updated || Number.isNaN(updated.getTime())) {
    elements.syncText.textContent = "数据时间未知";
    return;
  }
  elements.syncText.textContent = `更新于 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(updated)}`;
}

function populateSettingsDialog() {
  elements.settingsCategoryGrid.innerHTML = groupCategories(state.config.available_categories || [])
    .map((group) => `
      <fieldset class="settings-category-group">
        <legend>${escapeHTML(group.name)}</legend>
        <div class="settings-category-options">
          ${group.items.map((item) => `
            <label>
              <input type="checkbox" name="settingsCategory" value="${escapeAttribute(item.code)}" ${state.automationCategories.includes(item.code) ? "checked" : ""}>
              <span>${escapeHTML(item.name)}<br><small>${escapeHTML(item.code)}</small></span>
            </label>
          `).join("")}
        </div>
      </fieldset>
    `)
    .join("");
  elements.settingsKeywords.value = state.keywords.join(", ");
  const keywordRadio = elements.settingsForm.querySelector(`input[name="keywordMode"][value="${state.keywordMode}"]`);
  if (keywordRadio) keywordRadio.checked = true;
  refreshIcons();
}

function openSettings() {
  populateSettingsDialog();
  elements.settingsDialog.showModal();
}

function handleDialogBackdropClick(event) {
  if (event.target === elements.settingsDialog) elements.settingsDialog.close();
}

function collectSettings() {
  const categories = [...elements.settingsForm.querySelectorAll('input[name="settingsCategory"]:checked')].map((input) => input.value);
  const keywordMode = elements.settingsForm.querySelector('input[name="keywordMode"]:checked')?.value || "highlight";
  const keywords = elements.settingsKeywords.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  return {
    categories,
    keywords,
    keywordMode,
  };
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  elements.settingsDialog.close();
  state.visibleCount = PAGE_SIZE;
  render();
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
  const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "settings.json";
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("配置文件已导出");
}

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

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}
