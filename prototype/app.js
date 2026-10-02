"use strict";

// This is a local UX model. It does not invoke NCALayer, Solana, or any payment API.
const examples = {
  livestock: {
    title: "Партия КРС · 12 голов",
    quantity: "12 голов",
    amount: 8400000,
    date: "2026-10-10",
    seller: "ФХ «Сарыарка»",
    buyer: "ТОО «Береке»",
    quantityLabel: "ПАРТИЯ",
  },
  grain: {
    title: "Партия пшеницы · 80 тонн",
    quantity: "80 тонн",
    amount: 7600000,
    date: "2026-10-18",
    seller: "КХ «Жайлау»",
    buyer: "ТОО «Астық Трейд»",
    quantityLabel: "ОБЪЁМ",
  },
};

const steps = [
  { role: "seller", title: "Подготовить предложение", description: "Продавец проверяет условия и отправляет их покупателю.", button: "Отправить предложение", event: "Предложение отправлено", detail: "Продавец подтвердил отправку версии условий в демонстрационном интерфейсе." },
  { role: "buyer", title: "Принять условия", description: "Покупатель должен увидеть ту же версию сделки и принять её.", button: "Принять условия", event: "Условия приняты", detail: "Покупатель смоделировал согласие с текущей версией условий." },
  { role: "buyer", title: "Показать обеспечение", description: "Покупатель моделирует удержание демо-₸. Это не банковский платёж.", button: "Заблокировать демо-₸", event: "Демо-₸ удержаны", detail: "Баланс и удержание существуют только в этом браузерном сценарии." },
  { role: "seller", title: "Заявить передачу", description: "Продавец добавляет заявление о передаче партии. Факт ещё не проверен.", button: "Заявить передачу", event: "Передача заявлена", detail: "Физическая передача заявлена продавцом, но не подтверждена независимым источником." },
  { role: "buyer", title: "Проверить и принять", description: "Покупатель принимает партию либо открывает спор до расчёта.", button: "Принять партию", event: "Партия принята", detail: "Покупатель смоделировал приёмку партии; качество и количество не проверялись системой." },
  { role: "buyer", title: "Разблокировать расчёт", description: "После приёмки покупатель моделирует перевод демо-₸ продавцу.", button: "Разблокировать демо-₸", event: "Демо-расчёт завершён", detail: "Это изменение статуса макета, не реальный перевод денег или on-chain операция." },
];

// Interview checklist, not a claim that every item is legally required in every deal.
const documentCatalog = {
  livestock: [
    { id: "terms", group: "01 / ОСНОВА СДЕЛКИ", title: "Условия сделки · версия 1", description: "Сводка товара, суммы, сторон и срока из этой карточки. Документ и ЭЦП ещё не созданы.", generated: true },
    { id: "animals", group: "02 / ТОВАР", title: "Список животных и бирок", description: "Участники укажут, какие именно животные входят в партию." },
    { id: "veterinary", group: "02 / ТОВАР", title: "Ветеринарные материалы", description: "Перечень и источник проверки нужно уточнить для конкретной сделки." },
    { id: "handover", group: "03 / ПЕРЕДАЧА", title: "Подтверждение передачи", description: "Акт, фото или другой согласованный сторонами материал; загрузка не доказывает сам факт передачи." },
    { id: "acceptance", group: "03 / ПЕРЕДАЧА", title: "Приёмка или материалы спора", description: "Замечания покупателя и приложения привязываются к тому же этапу сделки." },
    { id: "settlement", group: "04 / РАСЧЁТ", title: "Подтверждение расчёта", description: "Банковский или наличный расчёт в макете не проверяется и не проводится." },
  ],
  grain: [
    { id: "terms", group: "01 / ОСНОВА СДЕЛКИ", title: "Условия сделки · версия 1", description: "Сводка партии, суммы, сторон и срока из этой карточки. Документ и ЭЦП ещё не созданы.", generated: true },
    { id: "specification", group: "02 / ПАРТИЯ", title: "Спецификация партии", description: "Культура, согласованный объём и договорные показатели качества." },
    { id: "waybill", group: "03 / ОТГРУЗКИ", title: "Накладная по отгрузке", description: "Для нескольких машин нужна отдельная привязка каждого документа к отгрузке." },
    { id: "weight", group: "03 / ОТГРУЗКИ", title: "Результат взвешивания", description: "Указываются автор и источник измерения; файл участника не равен проверенным данным весовой." },
    { id: "quality", group: "03 / ОТГРУЗКИ", title: "Анализ качества", description: "Указывается выдавшая организация и отгрузка; здесь лаборатория не подключена." },
    { id: "acceptance", group: "04 / ПРИЁМКА И РАСЧЁТ", title: "Приёмка или материалы спора", description: "Принятая, спорная и отклонённая части должны различаться в будущей реализации." },
    { id: "settlement", group: "04 / ПРИЁМКА И РАСЧЁТ", title: "Подтверждение расчёта", description: "В макете платёж не проводится и банковский файл не проверяется." },
  ],
};

const state = {
  scenario: "livestock",
  role: "seller",
  stage: 0,
  disputed: false,
  renewed: false,
  custom: null,
  events: [],
  ratings: { seller: false, buyer: false },
  view: "deals",
  dealPanel: "overview",
  documentKey: "livestock",
  documentSets: { livestock: [], grain: [] },
  customCount: 0,
  savedDeals: [],
  savedVersions: [],
  savedMarkers: [],
  markerLoadToken: 0,
  pendingMarkerRequest: null,
  activeDealId: null,
  editingId: null,
  editingVersion: null,
  apiAvailable: false,
  apiUnavailable: false,
};

const $ = (id) => document.getElementById(id);
const formatAmount = (amount) => `${new Intl.NumberFormat("ru-RU").format(amount)} ₸`;
const formatDate = (date) => {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "Срок не задан" : `Передача до ${new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(parsed)}`;
};
const roleLabel = (role) => role === "seller" ? "Продавец" : "Покупатель";
const formatQuantity = (quantity, scenario) => {
  const lastTwo = quantity % 100;
  const last = quantity % 10;
  const one = last === 1 && lastTwo !== 11;
  const few = last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14);
  const unit = scenario === "grain"
    ? one ? "тонна" : few ? "тонны" : "тонн"
    : one ? "голова" : few ? "головы" : "голов";
  return `${quantity} ${unit}`;
};
const deal = () => state.custom || examples[state.scenario];
const savedDeal = () => state.savedDeals.find((item) => item.id === state.activeDealId);
const activeDocuments = () => state.activeDealId
  ? state.savedMarkers.filter((marker) => marker.termsVersion === savedDeal()?.version)
  : state.documentSets[state.documentKey] || [];
let pendingAction = null;
let toastTimer = null;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4300);
}

function addEvent(title, detail, actor, source = "Смоделировано") {
  state.events.unshift({ title, detail, actor, source, time: new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date()) });
}

function resetFlow() {
  state.stage = 0;
  state.disputed = false;
  state.ratings = { seller: false, buyer: false };
  state.events = [];
  addEvent("Черновик условий создан", "Условия открыты двум демонстрационным участникам. Подписей и платёжных действий нет.", "Система");
  render();
}

function showSavedDeals() {
  $("savedDrafts").hidden = !state.apiAvailable;
  $("modeRibbon").textContent = state.apiAvailable
    ? "Локальный API сохраняет условия и метки без файлов · ЭЦП, деньги и Solana не подключены"
    : "Кликабельный UX-прототип · ЭЦП, деньги и Solana здесь не подключены";
  const select = $("savedDealSelect");
  select.replaceChildren(new Option("Пример сделки", ""));
  for (const item of state.savedDeals) {
    const label = `${item.scenario === "grain" ? "Зерно" : "КРС"} · v${item.version} · ${formatQuantity(item.quantity, item.scenario)} · ${formatAmount(item.amount)}`;
    select.append(new Option(label, item.id));
  }
  select.value = state.activeDealId || "";
}

function activateSavedDeal(item) {
  state.scenario = item.scenario;
  state.activeDealId = item.id;
  state.documentKey = `saved-${item.id}`;
  state.documentSets[state.documentKey] ||= [];
  state.savedVersions = [];
  state.savedMarkers = [];
  const markerLoadToken = ++state.markerLoadToken;
  state.custom = {
    ...examples[item.scenario],
    seller: "Продавец · тестовый профиль",
    buyer: "Покупатель · тестовый профиль",
    title: `${item.scenario === "grain" ? "Партия пшеницы" : "Партия КРС"} · ${formatQuantity(item.quantity, item.scenario)}`,
    quantity: formatQuantity(item.quantity, item.scenario),
    amount: item.amount,
    date: item.date,
  };
  showSavedDeals();
  resetFlow();
  loadVersions(item.id);
  loadMarkers(item.id, markerLoadToken);
}

async function loadMarkers(id, token) {
  try {
    const response = await fetch(`/api/deals/${id}/markers`, { cache: "no-store" });
    if (!response.ok) throw new Error("Markers unavailable");
    const data = await response.json();
    if (!Array.isArray(data.markers)) throw new Error("Invalid marker list");
    if (state.activeDealId === id && state.markerLoadToken === token) {
      state.savedMarkers = data.markers;
      renderDocuments();
    }
  } catch {
    if (state.activeDealId === id) showToast("Не удалось загрузить метки документов.");
  }
}

async function loadVersions(id) {
  try {
    const response = await fetch(`/api/deals/${id}/versions`, { cache: "no-store" });
    if (!response.ok) throw new Error("History unavailable");
    const data = await response.json();
    if (!Array.isArray(data.versions)) throw new Error("Invalid history");
    if (state.activeDealId === id) {
      state.savedVersions = data.versions;
      renderDraftVersions();
    }
  } catch {
    if (state.activeDealId === id) showToast("Не удалось загрузить историю версий черновика.");
  }
}

async function loadSavedDeals() {
  $("createDeal").disabled = true;
  try {
    const response = await fetch("/api/deals", { cache: "no-store" });
    if (!response.ok) throw new Error("API unavailable");
    const data = await response.json();
    if (!Array.isArray(data.deals)) throw new Error("Invalid API response");
    state.apiAvailable = true;
    state.savedDeals = data.deals;
    if (data.deals.length) activateSavedDeal(data.deals[0]);
    else showSavedDeals();
  } catch {
    // The file:// and old static-server entrypoints remain UX-only.
    state.apiUnavailable = location.port === "4174";
    showSavedDeals();
    if (state.apiUnavailable) showToast("Локальный API недоступен. Сохранение черновика временно остановлено.");
  } finally {
    $("createDeal").disabled = false;
  }
}

function setScenario(scenario) {
  if (!examples[scenario]) return;
  state.scenario = scenario;
  state.custom = null;
  state.activeDealId = null;
  state.savedVersions = [];
  state.savedMarkers = [];
  state.markerLoadToken += 1;
  state.documentKey = scenario;
  showSavedDeals();
  resetFlow();
  showToast(scenario === "grain" ? "Открыт сценарий зерновой сделки." : "Открыт сценарий сделки КРС.");
}

function setView(view) {
  if (!["deals", "evidence", "wallet", "reputation"].includes(view)) return;
  state.view = view;
  for (const name of ["deals", "evidence", "wallet", "reputation"]) {
    $(`view-${name}`).hidden = name !== view;
  }
  for (const button of document.querySelectorAll("[data-nav]")) {
    const selected = button.dataset.nav === view;
    button.classList.toggle("is-active", selected);
    selected ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  }
  $("sectionLabel").textContent = { deals: "СДЕЛКИ", evidence: "ЖУРНАЛ", wallet: "КОШЕЛЁК", reputation: "РЕПУТАЦИЯ" }[view];
  document.querySelector(".workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setDealPanel(panel, focus = false) {
  if (!["overview", "documents"].includes(panel)) return;
  state.dealPanel = panel;
  $("dealOverview").hidden = panel !== "overview";
  $("dealDocuments").hidden = panel !== "documents";
  for (const [name, id] of [["overview", "tabOverview"], ["documents", "tabDocuments"]]) {
    const tab = $(id);
    const selected = name === panel;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  if (focus) $(panel === "overview" ? "tabOverview" : "tabDocuments").focus();
}

function makeElement(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(bytes / 1024)} КБ`;
}

function fileKind(name) {
  const extension = name.split(".").pop().toLowerCase();
  if (extension === "pdf") return "pdf";
  if (["jpg", "jpeg", "png", "webp"].includes(extension)) return "image";
  if (["doc", "docx"].includes(extension)) return "word";
  if (["xls", "xlsx"].includes(extension)) return "spreadsheet";
  return null;
}

const fileKindLabel = { pdf: "PDF", image: "изображение", word: "Word", spreadsheet: "Excel" };

function renderDocuments() {
  const docs = activeDocuments();
  const catalog = documentCatalog[state.scenario];
  $("documentsNotice").textContent = state.activeDealId
    ? "Сохраняются метки черновика: категория, версия условий, формат по расширению и введённые описания. Имя выбранного файла и его содержимое не отправляются автоматически. Не вводите их или личные данные в описания. Роль тестовая, без проверки личности."
    : "Только локальная демонстрация: имя и размер выбранного файла видны до обновления страницы. Содержимое не считывается и не отправляется; метка не доказывает подлинность документа.";
  $("fileStorageStatus").textContent = state.activeDealId
    ? "Содержимое не хранится; сохраняется лишь метка черновика"
    : "Содержимое не хранится; метка только в браузере";
  $("docsCount").textContent = String(docs.length);
  $("documentsSubtitle").textContent = state.scenario === "grain"
    ? "Примерный набор для зерна. Отгрузки, вес и качество потребуют отдельного согласования с участниками."
    : "Примерный набор для сделки КРС. Что действительно нужно, уточним с участниками.";
  const list = $("documentsList");
  list.replaceChildren();
  const groups = new Map();
  for (const item of catalog) {
    if (!groups.has(item.group)) {
      const group = makeElement("section", "doc-group");
      const heading = makeElement("h3", "", item.group);
      const body = makeElement("div", "doc-group-body");
      group.append(heading, body);
      list.append(group);
      groups.set(item.group, body);
    }
    const row = makeElement("article", "doc-row");
    row.append(makeElement("div", "doc-row-index", String(catalog.indexOf(item) + 1).padStart(2, "0")));
    const content = makeElement("div", "doc-row-content");
    const head = makeElement("div", "doc-row-head");
    const title = makeElement("h4", "", item.generated && state.activeDealId
      ? `Условия сделки · версия ${savedDeal()?.version || 1}` : item.title);
    const attached = docs.filter((doc) => doc.category === item.id);
    const status = makeElement("span", `doc-status${item.generated || attached.length ? " is-added" : ""}`,
      item.generated ? "Черновик · без ЭЦП" : attached.length ? `Метки: ${attached.length}` : "Не добавлен");
    head.append(title, status);
    content.append(head, makeElement("p", "doc-row-description", item.description));
    if (item.generated) {
      const details = makeElement("div", "doc-attachments");
      const summary = makeElement("div", "doc-attachment");
      summary.append(makeElement("div", "doc-file-icon", "≡"));
      const body = makeElement("div", "");
      body.append(makeElement("strong", "", `${deal().quantity} · ${formatAmount(deal().amount)}`));
      body.append(makeElement("span", "", "Из полей карточки · не подписано · файла нет"));
      summary.append(body);
      details.append(summary);
      content.append(details);
    } else if (attached.length) {
      const attachments = makeElement("div", "doc-attachments");
      for (const doc of attached) {
        const attachment = makeElement("div", "doc-attachment");
        attachment.append(makeElement("div", "doc-file-icon", "↥"));
        const body = makeElement("div", "");
        body.append(makeElement("strong", "", doc.id
          ? `Метка ${fileKindLabel[doc.fileKind] || doc.fileKind} · файл не сохранён`
          : doc.name));
        body.append(makeElement("span", "", doc.id
          ? `Черновик v${doc.termsVersion} · заявлено ролью «${roleLabel(doc.claimedRole)}» · ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(doc.createdAt))} · не проверено`
          : `${fileSize(doc.size)} · ${doc.actor} · ${doc.time} · только имя файла, не проверено`));
        if (doc.context) body.append(makeElement("p", "", `Привязка: ${doc.context}`));
        if (doc.note) body.append(makeElement("p", "", `Примечание: ${doc.note}`));
        attachment.append(body);
        attachments.append(attachment);
      }
      content.append(attachments);
    }
    row.append(content);
    groups.get(item.group).append(row);
  }
  const archived = state.activeDealId
    ? state.savedMarkers.filter((marker) => marker.termsVersion !== savedDeal()?.version) : [];
  $("archivedMarkers").hidden = archived.length === 0;
  const archiveList = $("archivedMarkerList");
  archiveList.replaceChildren();
  for (const marker of archived) {
    const category = (documentCatalog[marker.termsScenario] || []).find((item) => item.id === marker.category);
    archiveList.append(makeElement("li", "", `v${marker.termsVersion} · ${category?.title || marker.category} · ${fileKindLabel[marker.fileKind] || marker.fileKind} · файл не сохранён`));
  }
}

function openDocumentDialog() {
  $("documentForm").reset();
  $("documentError").hidden = true;
  const select = $("documentCategory");
  select.replaceChildren();
  for (const item of documentCatalog[state.scenario].filter((entry) => !entry.generated)) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.title;
    select.append(option);
  }
  $("documentDialog").showModal();
}

async function addDocument(event) {
  event.preventDefault();
  const category = $("documentCategory").value;
  const file = $("documentFile").files[0];
  const allowedCategory = documentCatalog[state.scenario].some((item) => item.id === category && !item.generated);
  const kind = file && fileKind(file.name);
  if (!allowedCategory || !file || !kind) {
    $("documentError").textContent = "Выберите раздел и тестовый файл PDF, изображение, Word или Excel.";
    $("documentError").hidden = false;
    return;
  }
  const localDocument = {
    category,
    name: file.name,
    size: file.size,
    context: $("documentContext").value.trim().slice(0, 80),
    note: $("documentNote").value.trim().slice(0, 120),
    actor: roleLabel(state.role),
    time: new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date()),
  };
  if (state.activeDealId) {
    const submit = $("documentForm").querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const requestKey = JSON.stringify([state.activeDealId, savedDeal().version, category,
        localDocument.context, localDocument.note, state.role, kind]);
      if (state.pendingMarkerRequest?.key !== requestKey) {
        state.pendingMarkerRequest = { key: requestKey, id: crypto.randomUUID() };
      }
      const response = await fetch(`/api/deals/${state.activeDealId}/markers`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: savedDeal().version,
          requestId: state.pendingMarkerRequest.id, category, context: localDocument.context,
          note: localDocument.note, claimedRole: state.role, fileKind: kind }),
      });
      if (response.status === 409) {
        $("documentError").textContent = "Версия условий уже изменилась. Обновите страницу перед повтором.";
        $("documentError").hidden = false;
        return;
      }
      if (!response.ok) throw new Error("Marker save failed");
      const { marker } = await response.json();
      if (state.activeDealId !== marker.dealId) return;
      state.markerLoadToken += 1;
      if (!state.savedMarkers.some((saved) => saved.id === marker.id)) state.savedMarkers.unshift(marker);
      state.pendingMarkerRequest = null;
    } catch {
      $("documentError").textContent = "Не удалось сохранить метку. Проверьте локальный сервер и повторите.";
      $("documentError").hidden = false;
      return;
    } finally {
      submit.disabled = false;
    }
  } else {
    activeDocuments().push(localDocument);
  }
  $("documentForm").reset(); // Drop the File object; no file bytes are read.
  if ($("documentDialog").open) $("documentDialog").close();
  renderDocuments();
  showToast(state.activeDealId
    ? "Метка сохранена с версией черновика. Выбранный файл и его имя не загружены."
    : "Добавлена только локальная метка. Содержимое файла не загружено.");
}

function renderEvents() {
  const list = $("eventList");
  list.replaceChildren();
  for (const entry of state.events) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const detail = document.createElement("p");
    title.textContent = entry.title;
    meta.textContent = `${entry.time} · ${entry.actor} · ${entry.source}`;
    detail.textContent = entry.detail;
    item.append(title, meta, detail);
    list.append(item);
  }
}

function renderReputation() {
  // Each role has an independent rating lane; the numbers below are never claimed as real reviews.
  $("sellerRating").textContent = state.ratings.buyer ? "5 / 5 · демо" : "Нет истории";
  $("buyerRating").textContent = state.ratings.seller ? "5 / 5 · демо" : "Нет истории";
  $("sellerRatingNote").textContent = state.ratings.buyer ? "Покупатель оставил демонстрационный отзыв продавцу." : "Отзывы появятся только после завершённой сделки.";
  $("buyerRatingNote").textContent = state.ratings.seller ? "Продавец оставил демонстрационный отзыв покупателю." : "Новая учётная запись не получает искусственную оценку.";
}

function renderDraftVersions() {
  const workspaceLink = $("testWorkspaceLink");
  if (workspaceLink && document.body?.dataset.testWorkspace === "enabled") {
    workspaceLink.hidden = false;
    workspaceLink.href = state.activeDealId ? `/test-workspace/?dealId=${state.activeDealId}` : "/test-workspace/";
  }
  $("draftHistory").hidden = !state.activeDealId;
  $("termsFingerprint").textContent = savedDeal()?.termsFingerprint || "—";
  const list = $("draftVersions");
  list.replaceChildren();
  for (const version of state.savedVersions) {
    const item = makeElement("li", "", `v${version.version} · ${formatQuantity(version.quantity, version.scenario)} · ${formatAmount(version.amount)} · до ${version.date}`);
    list.append(item);
  }
  const [current, previous] = state.savedVersions;
  const diff = $("versionDiff");
  const changes = $("versionChanges");
  changes.replaceChildren();
  diff.hidden = !current || !previous;
  if (current && previous) {
    $("versionDiffTitle").textContent = `Что изменилось относительно v${previous.version}`;
    const fields = [
      ["Тип партии", "scenario", (value) => value === "grain" ? "Зерно" : "КРС"],
      ["Количество", "quantity", (value, version) => formatQuantity(value, version.scenario)],
      ["Сумма", "amount", formatAmount],
      ["Срок передачи", "date", (value) => value],
    ];
    for (const [label, field, format] of fields) {
      const before = format(previous[field], previous);
      const after = format(current[field], current);
      if (before === after) continue;
      const row = makeElement("div", "version-change");
      row.append(makeElement("dt", "", label),
        makeElement("dd", "", `${before} → ${after}`));
      changes.append(row);
    }
  }
}

function render() {
  const current = deal();
  $("roleName").textContent = roleLabel(state.role);
  $("dealNumber").textContent = state.activeDealId
    ? `ЧЕРНОВИК № ${state.activeDealId.slice(0, 8).toUpperCase()} · v${savedDeal()?.version || 1} · БЕЗ ЭЦП`
    : state.custom ? "СДЕЛКА № DH-NEW · ЛОКАЛЬНЫЙ ЧЕРНОВИК" : "СДЕЛКА № DH-001 · ПРИМЕР";
  $("persistenceNote").textContent = state.activeDealId
    ? "На этом компьютере сохранены условия и метки документов без файлов. Шаги маршрута сбросятся после обновления страницы; переключатель ролей не подтверждает полномочия."
    : "Кнопки маршрута и метки документов существуют только в текущем браузерном сеансе.";
  $("dealTitle").textContent = current.title;
  $("sellerName").textContent = current.seller;
  $("buyerName").textContent = current.buyer;
  $("dealAmount").textContent = formatAmount(current.amount);
  $("amountNote").textContent = state.custom ? "Указано в черновике · не подтверждено" : "Пример, не рыночная оценка";
  $("quantityLabel").textContent = current.quantityLabel;
  $("dealQuantity").textContent = current.quantity;
  $("dealDate").textContent = formatDate(current.date);
  $("scenarioLimit").hidden = state.scenario !== "grain";
  $("progressCount").textContent = `Шаг ${state.stage} из 6`;
  $("progressFill").style.width = `${(state.stage / 6) * 100}%`;
  $("certificateLabel").textContent = state.renewed ? "Тестовая версия B · демо" : "Тестовая версия A";
  $("scenarioLivestock").classList.toggle("is-selected", state.scenario === "livestock");
  $("scenarioGrain").classList.toggle("is-selected", state.scenario === "grain");
  $("scenarioLivestock").setAttribute("aria-pressed", String(state.scenario === "livestock"));
  $("scenarioGrain").setAttribute("aria-pressed", String(state.scenario === "grain"));

  const status = $("dealStatus");
  status.classList.toggle("is-dispute", state.disputed);
  status.classList.toggle("is-warning", state.stage === 3 && !state.disputed);
  status.textContent = state.disputed ? "Спор открыт" : ["Черновик", "Предложение", "Согласовано", "Демо-₸ удержаны", "Передача заявлена", "Партия принята", "Завершена"][state.stage];

  $("basisTerms").textContent = state.stage >= 2 ? "Согласованы в демо · без ЭЦП" : state.stage === 1 ? "Предложение в демо · без ЭЦП" : "Черновик · без ЭЦП";
  $("basisDelivery").textContent = state.disputed ? "Оспаривается · не проверена" : state.stage >= 5 ? "Принята в демо · не проверена" : state.stage >= 4 ? "Заявлена в демо · не проверена" : "Не заявлена";
  $("basisSettlement").textContent = state.disputed ? "Остановлен из-за спора" : state.stage >= 6 ? "Смоделирован · без платежа" : state.stage >= 3 ? "Демо-удержание · без денег" : "Не проводился";

  const primary = $("primaryAction");
  const secondary = $("secondaryAction");
  secondary.hidden = state.stage !== 4 || state.disputed;
  if (state.disputed) {
    $("nextTitle").textContent = "Спор требует разбора";
    $("nextDescription").textContent = "Расчёт остановлен. В MVP спор должен разрешаться по отдельному процессу с доказательствами сторон.";
    primary.textContent = "Спор открыт — расчёт остановлен";
    primary.disabled = true;
  } else if (state.stage < steps.length) {
    const step = steps[state.stage];
    $("nextTitle").textContent = step.title;
    $("nextDescription").textContent = step.description;
    primary.textContent = `${step.button} →`;
    primary.disabled = false;
  } else {
    const alreadyRated = state.ratings[state.role];
    $("nextTitle").textContent = "Сделка завершена";
    $("nextDescription").textContent = "Каждая сторона может оставить один демонстрационный отзыв о контрагенте.";
    primary.textContent = alreadyRated ? "Демо-отзыв оставлен" : "Оценить контрагента →";
    primary.disabled = alreadyRated;
  }
  renderEvents();
  renderReputation();
  renderDocuments();
  renderDraftVersions();
}

function addPreviewLine(label, value) {
  const row = document.createElement("div");
  const caption = document.createElement("span");
  const content = document.createElement("strong");
  row.className = "preview-line";
  caption.textContent = label;
  content.textContent = value;
  row.append(caption, content);
  $("signedPreview").append(row);
}

function openAction(type) {
  pendingAction = type;
  const current = deal();
  $("signedPreview").replaceChildren();
  if (type === "renew") {
    $("actionDialogKicker").textContent = "СЕРТИФИКАТ · КОНЦЕПЦИЯ";
    $("actionDialogTitle").textContent = "Перевыпуск ЭЦП";
    $("actionDialogBody").textContent = "Покажем только изменение метки сертификата. Реальная перепривязка потребует повторной идентификации и проверки полномочий.";
    addPreviewLine("Владелец", "DEMO-OWNER-01");
    addPreviewLine("Новая метка", "Тестовая версия B");
    addPreviewLine("Solana-адрес", "Не создан");
  } else if (type === "dispute") {
    $("actionDialogKicker").textContent = "СПОР · ДЕМО";
    $("actionDialogTitle").textContent = "Открыть спор?";
    $("actionDialogBody").textContent = "Расчёт в прототипе остановится. Для реального продукта нужны причины, доказательства и правила разрешения спора.";
    addPreviewLine("Инициатор", "Покупатель · тестовый аккаунт");
    addPreviewLine("Состояние", "Передача заявлена, приёмка не подтверждена");
  } else if (type === "rating") {
    $("actionDialogKicker").textContent = "ОТЗЫВ · ДЕМО";
    $("actionDialogTitle").textContent = "Оценить контрагента";
    $("actionDialogBody").textContent = "Макет покажет демонстрационную оценку 5/5. Настоящий отзыв должен создаваться только после завершённой сделки.";
    addPreviewLine("Автор", `${roleLabel(state.role)} · тестовый аккаунт`);
    addPreviewLine("О ком", state.role === "seller" ? current.buyer : current.seller);
  } else {
    const step = steps[state.stage];
    $("actionDialogKicker").textContent = "ШАГ СДЕЛКИ · ДЕМО";
    $("actionDialogTitle").textContent = step.title;
    $("actionDialogBody").textContent = `${step.description} Подтверждение здесь не является подписью или банковской операцией.`;
    addPreviewLine("Участник", `${roleLabel(state.role)} · тестовый аккаунт`);
    addPreviewLine("Версия условий", `Черновик v${savedDeal()?.version || 1} · без ЭЦП`);
    addPreviewLine("Партия", current.quantity);
    addPreviewLine("Сумма", formatAmount(current.amount));
  }
  $("actionDialog").showModal();
}

function handlePrimary() {
  if (state.disputed) return;
  if (state.stage === 6) {
    if (!state.ratings[state.role]) openAction("rating");
    return;
  }
  const neededRole = steps[state.stage].role;
  if (state.role !== neededRole) {
    showToast(`Этот шаг выполняет ${neededRole === "seller" ? "продавец" : "покупатель"}. Переключите тестовый аккаунт вверху справа.`);
    return;
  }
  openAction("step");
}

function confirmAction() {
  if (!pendingAction) return;
  if (pendingAction === "renew") {
    state.renewed = true;
    addEvent("Метка сертификата изменена", "Смоделирован перевыпуск: тестовый владелец прежний, реального сертификата и кошелька нет.", "Система");
    showToast("Демонстрационная метка сертификата обновлена.");
  } else if (pendingAction === "dispute") {
    state.disputed = true;
    addEvent("Спор открыт", "Покупатель заявил несогласие с передачей. Демо-расчёт остановлен.", "Покупатель", "Заявлено стороной · демо");
    showToast("Спор открыт. Расчёт в сценарии остановлен.");
  } else if (pendingAction === "rating") {
    state.ratings[state.role] = true;
    addEvent("Демо-отзыв оставлен", `${roleLabel(state.role)} оставил демонстрационную оценку контрагенту.`, roleLabel(state.role));
    showToast("Демонстрационная оценка добавлена.");
  } else if (pendingAction === "step") {
    const step = steps[state.stage];
    addEvent(step.event, step.detail, roleLabel(state.role), state.stage === 3 ? "Заявлено стороной · демо" : "Смоделировано");
    state.stage += 1;
    showToast("Шаг смоделирован и добавлен в журнал.");
  }
  $("actionDialog").close();
  pendingAction = null;
  render();
}

function openCreate(edit = false) {
  state.editingId = edit ? state.activeDealId : null;
  state.editingVersion = edit ? savedDeal()?.version : null;
  const current = deal();
  $("formScenario").value = state.scenario;
  $("formQuantity").value = parseInt(current.quantity.replace(/\s/g, ""), 10) || "";
  $("formAmount").value = current.amount;
  $("formDate").value = current.date;
  $("formError").hidden = true;
  $("createKicker").textContent = edit ? `УСЛОВИЯ · ВЕРСИЯ ${state.editingVersion} · БЕЗ ЭЦП` : "НОВАЯ СДЕЛКА · ДЕМО";
  $("createDialogTitle").textContent = edit ? "Изменить черновик" : "Зафиксируем условия";
  $("createSubmit").innerHTML = edit ? 'Сохранить новую версию <span aria-hidden="true">→</span>' : 'Создать черновик <span aria-hidden="true">→</span>';
  $("createIntro").textContent = edit
    ? "Изменение создаст новую локальную версию условий. Ранее смоделированные шаги сбросятся; ЭЦП и согласия сторон нет."
    : state.apiAvailable
      ? "Сохраняются только условия черновика на этом компьютере. Участники, ЭЦП и расчёт не подтверждаются."
      : "Это локальный черновик в браузере. Данные никуда не отправляются.";
  $("createDialog").showModal();
}

async function createDeal(event) {
  event.preventDefault();
  const scenario = $("formScenario").value;
  const quantity = Number($("formQuantity").value);
  const amount = Number($("formAmount").value);
  const date = $("formDate").value;
  const parsedDate = new Date(`${date}T00:00:00Z`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;
  if (!examples[scenario] || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000 || !Number.isSafeInteger(amount) || amount < 1 || amount > 999999999999 || !validDate) {
    $("formError").textContent = "Проверьте тип партии, целое количество, сумму и дату передачи.";
    $("formError").hidden = false;
    return;
  }
  if (state.apiUnavailable) {
    $("formError").textContent = "Локальный API недоступен. Обновите страницу после его запуска.";
    $("formError").hidden = false;
    return;
  }
  if (state.apiAvailable) {
    const submit = $("createSubmit");
    submit.disabled = true;
    try {
      const edit = Boolean(state.editingId);
      const response = await fetch(edit ? `/api/deals/${state.editingId}` : "/api/deals", {
        method: edit ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, quantity, amount, date,
          ...(edit ? { expectedVersion: state.editingVersion } : {}) }),
      });
      if (response.status === 409) {
        $("formError").textContent = "Черновик уже изменён в другой вкладке. Скопируйте нужные значения и обновите страницу перед повторной правкой.";
        $("formError").hidden = false;
        return;
      }
      if (!response.ok) throw new Error("Save failed");
      const { deal: saved } = await response.json();
      if (edit && saved.version === state.editingVersion) {
        $("createDialog").close();
        showToast("Условия не изменились — новая версия не создана.");
        return;
      }
      if (edit) state.savedDeals = state.savedDeals.map((item) => item.id === saved.id ? saved : item);
      else state.savedDeals.unshift(saved);
      activateSavedDeal(saved);
      $("createDialog").close();
      setView("deals");
      showToast(edit ? "Новая версия условий сохранена локально. ЭЦП не создавалась." : "Условия черновика сохранены локально. ЭЦП не создавалась.");
    } catch {
      $("formError").textContent = "Не удалось сохранить черновик. Проверьте локальный сервер и повторите.";
      $("formError").hidden = false;
    } finally {
      submit.disabled = false;
    }
    return;
  }
  state.scenario = scenario;
  state.activeDealId = null;
  state.documentKey = `custom-${++state.customCount}`;
  state.documentSets[state.documentKey] = [];
  state.custom = {
    ...examples[scenario],
    title: `${scenario === "grain" ? "Партия пшеницы" : "Партия КРС"} · ${formatQuantity(quantity, scenario)}`,
    quantity: formatQuantity(quantity, scenario),
    amount,
    date,
  };
  $("createDialog").close();
  resetFlow();
  showSavedDeals();
  setView("deals");
  showToast("Локальный черновик создан. Ничего не отправлено.");
}

document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.nav)));
document.querySelectorAll("[data-open-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.openView)));
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
$("tabOverview").addEventListener("click", () => setDealPanel("overview"));
$("tabDocuments").addEventListener("click", () => setDealPanel("documents"));
document.querySelector(".deal-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  setDealPanel(event.key === "ArrowLeft" || event.key === "Home" ? "overview" : "documents", true);
});
$("addDocument").addEventListener("click", openDocumentDialog);
$("documentForm").addEventListener("submit", addDocument);
$("roleSwitch").addEventListener("click", () => { state.role = state.role === "seller" ? "buyer" : "seller"; render(); showToast(`Открыт тестовый аккаунт: ${roleLabel(state.role)}.`); });
$("scenarioLivestock").addEventListener("click", () => setScenario("livestock"));
$("scenarioGrain").addEventListener("click", () => setScenario("grain"));
$("savedDealSelect").addEventListener("change", (event) => {
  const item = state.savedDeals.find((dealItem) => dealItem.id === event.target.value);
  if (item) activateSavedDeal(item);
  else setScenario(state.scenario);
});
$("resetDemo").addEventListener("click", () => { state.custom = null; state.activeDealId = null; state.documentKey = state.scenario; showSavedDeals(); resetFlow(); showToast("Сценарий возвращён к примеру. Сохранённые черновики не удалены."); });
$("createDeal").addEventListener("click", () => openCreate());
$("editDraft").addEventListener("click", () => openCreate(true));
$("createForm").addEventListener("submit", createDeal);
$("primaryAction").addEventListener("click", handlePrimary);
$("secondaryAction").addEventListener("click", () => { if (state.stage === 4 && state.role === "buyer") openAction("dispute"); else showToast("Спор на этом шаге может открыть тестовый покупатель."); });
$("renewCertificate").addEventListener("click", () => openAction("renew"));
$("confirmAction").addEventListener("click", confirmAction);
$("actionDialog").addEventListener("close", () => { pendingAction = null; });

resetFlow();
loadSavedDeals();
