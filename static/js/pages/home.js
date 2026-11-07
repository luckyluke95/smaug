import { api, requestJson } from "../api.js";
import {
  emptyState,
  iconElement,
  readPageData,
  renderTable,
  setText,
  showError,
  showMessage,
} from "../ui.js";

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
const count = document.getElementById("availableCount");
const groupCards = [...document.querySelectorAll("[data-group-id]")];

const tabs = groups.map((group) => ({
  id: String(group.id), name: group.name, listKey: "with_group", forms: [], loading: true, failed: false,
}));
if (isAdmin) {
  tabs.push({ id: "None", name: "Sans groupe", listKey: "without_group", forms: [], loading: true, failed: false });
}

const normalize = (value) => String(value ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

let activeGroup = null;
let failedGroups = 0;

function updateGroupCard(tab) {
  const card = groupCards.find((item) => item.dataset.groupId === tab.id);
  const label = card?.querySelector("[data-group-count]");
  if (!label) return;
  if (tab.loading) label.textContent = "Chargement…";
  else if (tab.failed) label.textContent = "Indisponible";
  else if (tab.forms.length === 0) label.textContent = "Aucune analyse";
  else label.textContent = `${tab.forms.length} analyse${tab.forms.length === 1 ? "" : "s"}`;
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
  const tab = tabs.find((item) => item.id === activeGroup);
  setText(expandedGroupTitle, activeGroup === "all" ? "Toutes les analyses disponibles" : `Analyses · ${tab?.name ?? "Groupe"}`);
  renderForms();
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
}

function formKey(form) {
  if (form.form_id === "GitBranchAndPath") {
    return `${form.form_id}:${form.branch ?? ""}:${form.file_path ?? ""}`;
  }
  return JSON.stringify([form.form_id, form.name, form.branch, form.file_path]);
}

function accessibleForms() {
  const unique = new Map();
  for (const tab of tabs) {
    for (const form of tab.forms) {
      const key = formKey(form);
      if (!unique.has(key)) unique.set(key, { form, groupIds: new Set() });
      unique.get(key).groupIds.add(tab.id);
    }
  }
  return [...unique.values()];
}

function renderForms() {
  if (activeGroup === null) return;
  const activeTab = tabs.find((tab) => tab.id === activeGroup);
  if (activeGroup === "all" ? tabs.some((tab) => tab.loading) : activeTab?.loading) {
    resetFilters.hidden = true;
    setText(count, "Chargement…");
    emptyState(formList, "Chargement de vos analyses…");
    return;
  }
  const query = normalize(formSearch.value.trim());
  const forms = accessibleForms().filter((entry) =>
    (activeGroup === "all" || entry.groupIds.has(activeGroup))
      && (!query || normalize(`${entry.form.name ?? ""} ${entry.form.description ?? ""}`).includes(query))
  );
  formList.replaceChildren();
  resetFilters.hidden = !query;
  setText(count, `${forms.length} analyse${forms.length !== 1 ? "s" : ""}`);

  if (forms.length === 0) {
    let message = "Aucune analyse disponible dans ce groupe.";
    if (tabs.length === 0) message = "Aucune analyse accessible. Contactez votre administrateur.";
    else if (query) message = "Aucune analyse ne correspond à votre recherche.";
    else if (activeTab?.failed) message = "Impossible de charger les analyses de ce groupe.";
    else if (activeGroup === "all" && failedGroups) message = "Aucune analyse disponible ; certains groupes n'ont pas pu être chargés.";
    else if (activeGroup === "all") message = "Aucune analyse accessible pour vos groupes.";
    emptyState(formList, message);
    return;
  }

  for (const { form } of forms) {
    const item = document.createElement("article");
    item.className = "form-item domain-analysis-card";
    const copy = document.createElement("div");
    copy.className = "form-copy";
    const title = document.createElement("strong");
    title.textContent = form.name || "Analyse sans nom";
    const description = document.createElement("p");
    description.textContent = form.description || "";
    copy.append(title, description);

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

async function loadForms() {
  if (tabs.length === 0) {
    const hint = domainIdle?.querySelector("p");
    if (hint) hint.textContent = "Vous n'appartenez à aucun groupe. Contactez votre administrateur pour accéder aux analyses.";
    return;
  }
  await Promise.all(tabs.map(async (tab) => {
    try {
      const data = await requestJson(api.groupForms(tab.id));
      tab.forms = Array.isArray(data?.[tab.listKey]) ? data[tab.listKey] : [];
    } catch (error) {
      tab.failed = true;
      failedGroups += 1;
      console.error(error);
      showMessage("error", `Impossible de charger les analyses du groupe « ${tab.name} ». `);
    } finally {
      tab.loading = false;
      updateGroupCard(tab);
      renderForms();
    }
  }));
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
formSearch?.addEventListener("input", renderForms);
globalSearch?.addEventListener("input", () => {
  // Mémoriser la saisie avant l'ouverture, qui réinitialise les anciens filtres.
  const query = globalSearch.value;
  if (activeGroup === null) setActiveGroup("all");
  formSearch.value = query;
  globalSearch.value = query;
  renderForms();
});
resetFilters?.addEventListener("click", () => {
  formSearch.value = "";
  if (globalSearch) globalSearch.value = "";
  renderForms();
});
await loadForms();
await loadRecentRuns();
