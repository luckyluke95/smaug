import { api, requestJson } from "../api.js";
import { createPagination } from "../pagination.js";
import {
  emptyState,
  iconElement,
  readPageData,
  renderTable,
  setText,
  showError,
  showMessage,
} from "../ui.js";

const PAGE_SIZE = 6;
const pageData = readPageData();
const groups = Array.isArray(pageData.groups) ? pageData.groups : [];
const isAdmin = pageData.isAdmin === true;
const formList = document.getElementById("formList");
const formSearch = document.getElementById("formSearch");
const domainIdle = document.getElementById("domain-idle");
const domainContent = document.getElementById("domain-content");
const closeDomainButton = document.getElementById("closeDomain");
const allFormsButton = document.getElementById("showAllForms");
const expandedGroupTitle = document.getElementById("expanded-group-title");
const resetFilters = document.getElementById("resetFilters");
const globalSearch = document.getElementById("globalSearch");
const groupSelector = document.getElementById("groupSelector");
const count = document.getElementById("availableCount");
const groupCards = [...document.querySelectorAll("[data-group-id]")];

const makeTab = (id, name, listKey, kind) => ({
  id,
  name,
  listKey,
  kind,
  forms: [],
  page: 1,
  pagination: null,
  loading: true,
  failed: false,
  requestToken: 0,
});

const tabs = groups.map((group) =>
  makeTab(String(group.id), group.name, "with_group", "group"),
);
if (isAdmin) {
  tabs.push(makeTab("None", "Sans groupe", "without_group", "group"));
}
const allTab = makeTab("all", "Toutes les analyses disponibles", "all", "all");

let activeGroup = null;
let failedGroups = 0;
let searchTimer = null;

const pagination = createPagination({
  onPage: (page) => loadActivePage(page),
});

function findTab(groupId) {
  if (groupId === "all") return allTab;
  return tabs.find((tab) => tab.id === groupId);
}

function activeTab() {
  return activeGroup === null ? null : findTab(activeGroup);
}

function updateGroupCard(tab) {
  const card = groupCards.find((item) => item.dataset.groupId === tab.id);
  const label = card?.querySelector("[data-group-count]");
  if (!label) return;
  if (tab.loading) label.textContent = "Chargement…";
  else if (tab.failed) label.textContent = "Indisponible";
  else {
    const total = tab.pagination?.total_count ?? tab.forms.length;
    label.textContent = total === 0 ? "Aucune analyse" : `${total} analyse${total === 1 ? "" : "s"}`;
  }
}

function setActiveGroup(groupId) {
  const valid = groupId === "all" || tabs.some((tab) => tab.id === groupId);
  const nextGroup = valid ? groupId : null;
  if (nextGroup !== activeGroup) {
    formSearch.value = "";
    if (globalSearch) globalSearch.value = "";
  }
  activeGroup = nextGroup;
  const isOpen = activeGroup !== null;
  domainIdle.hidden = isOpen;
  domainContent.hidden = !isOpen;
  for (const card of groupCards) {
    card.setAttribute("aria-expanded", String(card.dataset.groupId === activeGroup));
  }
  allFormsButton?.setAttribute("aria-expanded", String(activeGroup === "all"));
  if (!isOpen) {
    formSearch.value = "";
    if (globalSearch) globalSearch.value = "";
    return;
  }
  const tab = activeTab();
  setText(expandedGroupTitle, activeGroup === "all" ? "Toutes les analyses disponibles" : `Analyses · ${tab?.name ?? "Groupe"}`);
  if (tab) {
    renderForms();
    pagination.update(tab.pagination);
  }
}

function setupGroupDisclosure() {
  for (const card of groupCards) {
    card.addEventListener("click", () => {
      const nextGroup = activeGroup === card.dataset.groupId ? null : card.dataset.groupId;
      setActiveGroup(nextGroup);
    });
  }
  allFormsButton?.addEventListener("click", () => {
    setActiveGroup(activeGroup === "all" ? null : "all");
  });
  closeDomainButton?.addEventListener("click", () => setActiveGroup(null));
  groupSelector?.addEventListener("change", () => {
    const groupId = groupSelector.value;
    groupSelector.value = "";
    if (groupId) setActiveGroup(groupId);
  });
}

function isNonMain(form) {
  return form.form_id === "GitBranchAndPath"
    && form.branch
    && form.branch !== "main";
}

function renderForms() {
  if (activeGroup === null) return;
  const tab = activeTab();
  if (!tab) return;

  if (tab.loading) {
    resetFilters.hidden = true;
    setText(count, "Chargement…");
    emptyState(formList, "Chargement de vos analyses…");
    return;
  }

  const query = formSearch.value.trim();
  const total = tab.pagination?.total_count ?? tab.forms.length;
  formList.replaceChildren();
  resetFilters.hidden = !query;
  setText(count, `${total} analyse${total === 1 ? "" : "s"}`);

  if (tab.forms.length === 0) {
    let message = "Aucune analyse disponible dans ce groupe.";
    if (tabs.length === 0) message = "Aucune analyse accessible. Contactez votre administrateur.";
    else if (query) message = "Aucune analyse ne correspond à votre recherche.";
    else if (tab.failed) message = "Impossible de charger les analyses de ce groupe.";
    else if (activeGroup === "all" && failedGroups) message = "Aucune analyse disponible ; certains groupes n'ont pas pu être chargés.";
    else if (activeGroup === "all") message = "Aucune analyse accessible pour vos groupes.";
    emptyState(formList, message);
    return;
  }

  for (const form of tab.forms) {
    const item = document.createElement("article");
    const nonMain = isNonMain(form);
    item.className = `form-item domain-analysis-card${nonMain ? " domain-analysis-card--branch" : ""}`;
    const copy = document.createElement("div");
    copy.className = "form-copy";
    const title = document.createElement("strong");
    title.textContent = form.name || "Analyse sans nom";
    const description = document.createElement("p");
    description.textContent = form.description || "";
    copy.append(title, description);
    if (nonMain) {
      const branch = document.createElement("span");
      branch.className = "branch-badge";
      branch.textContent = `Branche ${form.branch}`;
      copy.append(branch);
    }

    const target = api.launchForm(form);
    if (target) {
      const link = document.createElement("a");
      link.className = "run-button";
      link.href = target;
      link.append(iconElement("play"), document.createTextNode("Ouvrir le formulaire"));
      item.append(copy, link);
    } else {
      const unavailable = document.createElement("span");
      unavailable.className = "soft-badge";
      unavailable.textContent = "Ouverture indisponible";
      item.append(copy, unavailable);
    }
    formList.append(item);
  }
}

async function loadTab(tab, page = 1, search = "") {
  const token = tab.requestToken + 1;
  tab.requestToken = token;
  tab.loading = true;
  tab.failed = false;
  if (activeGroup === tab.id) renderForms();

  try {
    const data = tab.kind === "all"
      ? await requestJson(api.allGroupForms({ page, pageSize: PAGE_SIZE, search }))
      : await requestJson(api.groupForms(tab.id, { page, pageSize: PAGE_SIZE, search }));
    if (tab.requestToken !== token) return;
    tab.forms = Array.isArray(data?.[tab.listKey]) ? data[tab.listKey] : [];
    tab.pagination = data?.pagination ?? null;
    tab.page = tab.pagination?.current_page ?? page;
  } catch (error) {
    if (tab.requestToken !== token) return;
    tab.failed = true;
    failedGroups += 1;
    console.error(error);
    if (tab.kind === "group") {
      showMessage("error", `Impossible de charger les analyses du groupe « ${tab.name} ». `);
    }
  } finally {
    if (tab.requestToken !== token) return;
    tab.loading = false;
    updateGroupCard(tab);
    if (activeGroup === tab.id) {
      renderForms();
      pagination.update(tab.pagination);
    }
  }
}

function loadActivePage(page) {
  const tab = activeTab();
  if (!tab) return;
  loadTab(tab, page, formSearch.value.trim());
}

function scheduleSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const tab = activeTab();
    if (!tab) return;
    loadTab(tab, 1, formSearch.value.trim());
  }, 250);
}

async function loadForms() {
  if (tabs.length === 0) {
    const hint = domainIdle?.querySelector("p");
    if (hint) hint.textContent = "Vous n'appartenez à aucun groupe. Contactez votre administrateur pour accéder aux analyses.";
  }
  await Promise.all([...tabs, allTab].map((tab) => loadTab(tab, 1)));
}

async function loadRecentRuns() {
  const container = document.getElementById("latest-runs-table");
  try {
    const data = await requestJson(api.listRuns({ page: 1, pageSize: 5 }));
    const displayData = Array.isArray(data?.header) ? {
      ...data,
      header: data.header.map((column) => ({
        ...column,
        content: /^runs?$/i.test(String(column.content ?? "").trim()) ? "Analyse" : column.content,
      })),
    } : data;
    renderTable(container, displayData, "Aucune analyse récente.");
  } catch (error) {
    showError(error);
    emptyState(container, "Impossible de charger les analyses récentes.");
  }
}

setupGroupDisclosure();
formSearch?.addEventListener("input", scheduleSearch);
globalSearch?.addEventListener("input", () => {
  // Mémoriser la saisie avant l'ouverture, qui réinitialise les anciens filtres.
  const query = globalSearch.value;
  if (activeGroup !== "all") setActiveGroup("all");
  formSearch.value = query;
  globalSearch.value = query;
  scheduleSearch();
});
resetFilters?.addEventListener("click", () => {
  formSearch.value = "";
  if (globalSearch) globalSearch.value = "";
  loadActivePage(1);
});
await loadForms();
await loadRecentRuns();