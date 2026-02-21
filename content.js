const STORAGE_KEY = "xwatch_users_v1";
const PROFILE_BOX_ID = "xwatch-profile-note-box";
const STYLE_ID = "xwatch-style";
const FALLBACK_ID_PREFIX = "h:";
const SCHEDULE_ASSIST_ID = "xmate-schedule-assist";

const EXCLUDED_PATHS = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "i",
  "settings",
  "search",
  "compose",
  "tos",
  "privacy"
]);

const PROFILE_ALLOWED_SUBPATHS = new Set([
  "with_replies",
  "media",
  "likes",
  "articles",
  "followers",
  "following",
  "verified_followers"
]);

let usersByIdCache = {};
let handleToIdCache = {};
let handleIdHintCache = {};
let observer = null;
let rescanTimer = null;
let isDevReloading = false;
const composingEditors = new WeakSet();
let scheduleAssistLastScanAt = 0;
let scheduleAssistApplying = false;
const SCHEDULE_ASSIST_SCAN_INTERVAL_MS = 450;

function i18n(key, fallback = "") {
  const message = chrome.i18n.getMessage(key);
  return message || fallback;
}

function normalizeHandle(handle) {
  return String(handle || "").trim().replace(/^@/, "").toLowerCase();
}

function normalizeUserId(userId) {
  return String(userId || "").trim();
}

function isFallbackUserId(userId) {
  return String(userId || "").startsWith(FALLBACK_ID_PREFIX);
}

function isLikelyRealUserId(userId) {
  return /^[0-9]{5,}$/.test(String(userId || ""));
}

function makeFallbackUserId(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return "";
  return `${FALLBACK_ID_PREFIX}${normalized}`;
}

function isValidHandle(handle) {
  return /^[a-zA-Z0-9_]{1,15}$/.test(handle);
}

function getHandleFromPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "";

  const first = normalizeHandle(parts[0]);
  if (!isValidHandle(first)) return "";
  if (EXCLUDED_PATHS.has(first)) return "";

  return first;
}

function getProfileHandleFromPath(pathname) {
  const handle = getHandleFromPath(pathname);
  if (!handle) return "";

  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts.length <= 1) return handle;

  const subPath = String(parts[1] || "").toLowerCase();
  if (!subPath) return handle;
  if (subPath === "status") return "";

  return PROFILE_ALLOWED_SUBPATHS.has(subPath) ? handle : "";
}

function getHandleFromHref(href) {
  if (!href) return "";
  try {
    const url = new URL(href, location.origin);
    return getHandleFromPath(url.pathname);
  } catch {
    return "";
  }
}

function getElementFromNode(node) {
  if (!node) return null;
  if (node instanceof Element) return node;
  return node.parentElement || null;
}

function findTweetComposerEditorFromNode(node) {
  const baseEl = getElementFromNode(node);
  if (!baseEl) return null;

  const editor = baseEl.closest('[role="textbox"]');
  if (!editor) return null;
  if (!editor.isContentEditable) return null;
  if (editor.closest(`#${PROFILE_BOX_ID}`)) return null;

  const selfTestId = String(editor.getAttribute("data-testid") || "");
  const hostWithTestId = editor.closest("[data-testid]");
  const hostTestId = String(hostWithTestId?.getAttribute("data-testid") || "");
  const inTweetComposer =
    selfTestId.startsWith("tweetTextarea_") ||
    hostTestId.startsWith("tweetTextarea_") ||
    editor.closest('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
  if (!inTweetComposer) return null;

  return editor;
}

function isComposerComposing(editor, event) {
  if (!editor) return false;
  if (event?.isComposing) return true;
  return composingEditors.has(editor);
}

function forceCommitComposerComposition(editor) {
  if (!editor) return;

  try {
    const x = window.scrollX;
    const y = window.scrollY;
    editor.blur();
    setTimeout(() => {
      if (!document.contains(editor)) return;
      try {
        editor.focus({ preventScroll: true });
      } catch {
        editor.focus();
      }
      window.scrollTo(x, y);
    }, 0);
  } catch {
    // Ignore IME commit fallback errors.
  }
}

function installImeSendGuard() {
  document.addEventListener("compositionstart", (event) => {
    const editor = findTweetComposerEditorFromNode(event.target);
    if (!editor) return;
    composingEditors.add(editor);
  }, true);

  document.addEventListener("compositionend", (event) => {
    const editor = findTweetComposerEditorFromNode(event.target);
    if (!editor) return;
    composingEditors.delete(editor);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Control") return;
    if (event.repeat) return;

    const editor =
      findTweetComposerEditorFromNode(event.target) ||
      findTweetComposerEditorFromNode(document.activeElement);

    const composing = isComposerComposing(editor, event);
    if (!editor) return;
    if (!composing) return;
    forceCommitComposerComposition(editor);
  }, true);
}

function normalizeUiText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1500, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  return true;
}

function collectSmallTextCandidates(root, selector, maxCount = 80) {
  const nodes = Array.from(root.querySelectorAll(selector)).slice(0, maxCount);
  return nodes.map((node) => normalizeUiText(node.textContent)).filter(Boolean);
}

function hasAnyToken(textList, tokens) {
  for (const text of textList) {
    for (const token of tokens) {
      if (text.includes(token)) return true;
    }
  }
  return false;
}

function getSelectLabelText(selectEl) {
  if (!selectEl) return "";
  const labelledBy = selectEl.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return normalizeUiText(labelEl.textContent);
  }

  const group = selectEl.closest('[role="group"]');
  if (group) {
    const label = group.querySelector("label");
    if (label) return normalizeUiText(label.textContent);
  }
  return "";
}

function getScheduleControls(dialog) {
  if (!dialog) return null;
  const selects = Array.from(dialog.querySelectorAll("select"));
  if (selects.length < 5) return null;

  const controls = {
    month: null,
    day: null,
    year: null,
    hour: null,
    minute: null,
    ampm: null
  };

  for (const selectEl of selects) {
    const label = getSelectLabelText(selectEl);
    if (!label) continue;

    if (!controls.month && (label.includes("월") || label.includes("month"))) controls.month = selectEl;
    else if (!controls.day && (label === "일" || label.includes("day"))) controls.day = selectEl;
    else if (!controls.year && (label.includes("년") || label.includes("year"))) controls.year = selectEl;
    else if (!controls.hour && (label === "시" || label.includes("hour"))) controls.hour = selectEl;
    else if (!controls.minute && (label.includes("분") || label.includes("minute"))) controls.minute = selectEl;
    else if (!controls.ampm && (label.includes("am/pm") || label.includes("period") || label.includes("오전/오후"))) controls.ampm = selectEl;
  }

  if (!controls.month || !controls.day || !controls.year || !controls.hour || !controls.minute) {
    return null;
  }
  return controls;
}

function userClick(el) {
  if (!el) return;
  const options = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent("pointerdown", options));
  el.dispatchEvent(new MouseEvent("mousedown", options));
  el.dispatchEvent(new MouseEvent("pointerup", options));
  el.dispatchEvent(new MouseEvent("mouseup", options));
  el.click();
}

function isScheduleDialog(dialog) {
  if (!dialog || !isVisibleElement(dialog)) return false;
  return Boolean(getScheduleControls(dialog));
}

function findScheduleDialog() {
  return Array.from(document.querySelectorAll('div[role="dialog"]')).find((dialog) => isScheduleDialog(dialog)) || null;
}

function isKoreanScheduleDialog(dialog) {
  const controls = getScheduleControls(dialog);
  if (!controls) return false;
  const monthLabel = getSelectLabelText(controls.month);
  const hourLabel = getSelectLabelText(controls.hour);
  return monthLabel.includes("월") || hourLabel.includes("시");
}

function readSelectNumericValue(selectEl) {
  if (!selectEl) return null;
  const value = String(selectEl.value || "").trim();
  if (/^\d+$/.test(value)) return Number(value);

  const selectedOption = selectEl.options?.[selectEl.selectedIndex];
  const text = String(selectedOption?.textContent || "").replace(/[^\d]/g, "");
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}

function readSelectTextValue(selectEl) {
  if (!selectEl) return "";
  const value = String(selectEl.value || "").trim();
  if (value) return normalizeUiText(value);
  const selectedOption = selectEl.options?.[selectEl.selectedIndex];
  return normalizeUiText(selectedOption?.textContent || "");
}

function setNativeValue(selectEl, optionValue) {
  if (!selectEl) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
  if (setter) setter.call(selectEl, optionValue);
  else selectEl.value = optionValue;
}

function fireInputChange(selectEl) {
  if (!selectEl) return;
  selectEl.dispatchEvent(new Event("input", { bubbles: true }));
  selectEl.dispatchEvent(new Event("change", { bubbles: true }));
}

function pickSelectOptionValue(selectEl, candidates) {
  if (!selectEl) return null;
  const normalizedCandidates = candidates.map((v) => normalizeUiText(v)).filter(Boolean);
  const options = Array.from(selectEl.options || []);

  for (const option of options) {
    const value = normalizeUiText(option.value);
    const text = normalizeUiText(option.textContent);
    if (normalizedCandidates.includes(value) || normalizedCandidates.includes(text)) {
      return option.value;
    }
  }
  return null;
}

async function setSelectByCandidates(selectEl, candidates) {
  if (!selectEl) return false;
  const optionValue = pickSelectOptionValue(selectEl, candidates);
  if (optionValue == null) return false;
  setNativeValue(selectEl, optionValue);
  fireInputChange(selectEl);
  await sleep(15);
  return true;
}

function findScheduleFieldTrigger(dialog, labelCandidates) {
  const labelSet = new Set(labelCandidates.map((label) => normalizeUiText(label)));

  const triggers = Array.from(dialog.querySelectorAll('[role="button"], button'));
  for (const trigger of triggers) {
    if (!isVisibleElement(trigger)) continue;

    const selfText = normalizeUiText(trigger.textContent);
    const parentText = normalizeUiText(trigger.parentElement?.textContent || "");
    for (const label of labelSet) {
      if (!label) continue;
      if (selfText === label || selfText.includes(label)) return trigger;
      if (parentText.includes(label)) return trigger;
    }
  }

  return null;
}

function findScheduleOption(optionTexts) {
  const expected = optionTexts.map((text) => normalizeUiText(text));
  const options = Array.from(document.querySelectorAll('[role="option"], li[role="option"], div[role="option"]'));
  const visibleOptions = options.filter((option) => isVisibleElement(option));
  if (!visibleOptions.length) return null;

  for (const option of visibleOptions) {
    const text = normalizeUiText(option.textContent);
    if (!text) continue;
    if (expected.includes(text)) return option;
  }

  for (const option of visibleOptions) {
    const text = normalizeUiText(option.textContent);
    if (!text) continue;
    if (expected.some((candidate) => candidate && (text.startsWith(candidate) || candidate.startsWith(text)))) {
      return option;
    }
  }

  return null;
}

async function pickScheduleFieldOption(dialog, labels, optionTexts) {
  const trigger = findScheduleFieldTrigger(dialog, labels);
  if (!trigger) return false;

  userClick(trigger);
  await sleep(70);

  let option = await waitFor(() => findScheduleOption(optionTexts), 420, 35);
  if (!option) {
    userClick(trigger);
    await sleep(70);
    option = await waitFor(() => findScheduleOption(optionTexts), 420, 35);
  }
  if (!option) return false;

  userClick(option);
  await sleep(55);
  return true;
}

function parseKoreanScheduledDate(text) {
  const match = String(text || "").match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일[\s\S]*?(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const meridiem = match[4];
  let hour = Number(match[5]);
  const minute = Number(match[6]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }

  if (meridiem === "오후" && hour < 12) hour += 12;
  if (meridiem === "오전" && hour === 12) hour = 0;

  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function parseEnglishScheduledDate(text) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const match = normalized.match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})[\s\S]*?(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;

  const monthName = match[1];
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const meridiem = String(match[6]).toUpperCase();

  const monthIndex = new Date(`${monthName} 1, 2000`).getMonth();
  if (!Number.isFinite(monthIndex) || monthIndex < 0) return null;
  if (!Number.isFinite(day) || !Number.isFinite(year) || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

function readScheduledDateTime(dialog) {
  if (!dialog) return null;
  const controls = getScheduleControls(dialog);
  if (controls) {
    const year = readSelectNumericValue(controls.year);
    const month = readSelectNumericValue(controls.month);
    const day = readSelectNumericValue(controls.day);
    const hourBase = readSelectNumericValue(controls.hour);
    const minute = readSelectNumericValue(controls.minute);

    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day) && Number.isFinite(hourBase) && Number.isFinite(minute)) {
      let hour = hourBase;
      if (controls.ampm) {
        const ap = readSelectTextValue(controls.ampm);
        const isPm = ap.includes("pm") || ap.includes("오후");
        const isAm = ap.includes("am") || ap.includes("오전");
        if (isPm && hour < 12) hour += 12;
        if (isAm && hour === 12) hour = 0;
      }
      return new Date(year, month - 1, day, hour, minute, 0, 0);
    }
  }

  const text = String(dialog.textContent || "");
  return parseKoreanScheduledDate(text) || parseEnglishScheduledDate(text);
}

function buildScheduleOptionTexts(targetDate, useKoreanLabels) {
  const month = targetDate.getMonth() + 1;
  const day = targetDate.getDate();
  const year = targetDate.getFullYear();
  const hour24 = targetDate.getHours();
  const hour12 = hour24 % 12 || 12;
  const minute = targetDate.getMinutes();
  const minutePadded = String(minute).padStart(2, "0");
  const isPm = hour24 >= 12;

  const monthShort = targetDate.toLocaleString("en-US", { month: "short" });
  const monthLong = targetDate.toLocaleString("en-US", { month: "long" });

  return {
    month: useKoreanLabels ? [`${month}월`, String(month)] : [monthShort, monthLong, String(month)],
    day: useKoreanLabels ? [`${day}일`, String(day)] : [String(day)],
    year: useKoreanLabels ? [`${year}년`, String(year)] : [String(year)],
    hour: [String(hour12), useKoreanLabels ? `${hour12}시` : String(hour12)],
    minute: [minutePadded, String(minute), useKoreanLabels ? `${minute}분` : String(minute)],
    ampm: isPm ? ["PM", "오후"] : ["AM", "오전"]
  };
}

async function applyScheduleDateTime(dialog, targetDate) {
  if (!dialog || !targetDate) return false;
  const controls = getScheduleControls(dialog);
  if (controls) {
    const month = targetDate.getMonth() + 1;
    const day = targetDate.getDate();
    const year = targetDate.getFullYear();
    const hour24 = targetDate.getHours();
    const minute = targetDate.getMinutes();
    const minutePadded = String(minute).padStart(2, "0");
    const hour12 = hour24 % 12 || 12;
    const isPm = hour24 >= 12;

    const okYear = await setSelectByCandidates(controls.year, [String(year)]);
    const okMonth = await setSelectByCandidates(controls.month, [String(month), `${month}월`, targetDate.toLocaleString("en-US", { month: "short" }), targetDate.toLocaleString("en-US", { month: "long" })]);
    const okDay = await setSelectByCandidates(controls.day, [String(day), `${day}일`]);

    let okHour = false;
    let okMinute = false;
    let okAmPm = true;
    if (controls.ampm) {
      okHour = await setSelectByCandidates(controls.hour, [String(hour12), `${hour12}시`]);
      okMinute = await setSelectByCandidates(controls.minute, [minutePadded, String(minute), `${minute}분`]);
      okAmPm = await setSelectByCandidates(controls.ampm, [isPm ? "pm" : "am", isPm ? "오후" : "오전", isPm ? "PM" : "AM"]);
    } else {
      okHour = await setSelectByCandidates(controls.hour, [String(hour24), String(hour12)]);
      okMinute = await setSelectByCandidates(controls.minute, [minutePadded, String(minute)]);
    }

    return okYear && okMonth && okDay && okHour && okMinute && okAmPm;
  }

  const useKoreanLabels = isKoreanScheduleDialog(dialog);
  const options = buildScheduleOptionTexts(targetDate, useKoreanLabels);

  const results = [];
  results.push(await pickScheduleFieldOption(dialog, ["년", "year"], options.year));
  results.push(await pickScheduleFieldOption(dialog, ["월", "month"], options.month));
  results.push(await pickScheduleFieldOption(dialog, ["일", "day"], options.day));
  results.push(await pickScheduleFieldOption(dialog, ["시", "hour"], options.hour));
  results.push(await pickScheduleFieldOption(dialog, ["분", "minute"], options.minute));
  results.push(await pickScheduleFieldOption(dialog, ["am/pm", "period", "오전/오후"], options.ampm));

  return results.every(Boolean);
}

function roundToMinute(date) {
  const rounded = new Date(date.getTime());
  rounded.setSeconds(0, 0);
  return rounded;
}

function findScheduleAssistAnchor(dialog) {
  const divider = dialog.querySelector(".r-13awgt0.r-eqz5dr");
  if (divider?.parentElement) {
    return { mode: "before", node: divider };
  }

  const actionTargets = Array.from(dialog.querySelectorAll("button, [role='button']"));
  const actionButton = actionTargets.find((el) => {
    const text = normalizeUiText(el.textContent);
    return text.includes("예약 게시물") || text.includes("schedule post");
  });
  if (actionButton?.parentElement) {
    return { mode: "before", node: actionButton.parentElement };
  }
  return { mode: "append", node: dialog };
}

function createScheduleAssistPanel(dialog) {
  const panel = document.createElement("section");
  panel.id = SCHEDULE_ASSIST_ID;
  panel.innerHTML = `
    <div class="xmate-schedule-row" data-row="delay"></div>
    <div class="xmate-schedule-row" data-row="adjust"></div>
  `;

  const delayRow = panel.querySelector('[data-row="delay"]');
  const adjustRow = panel.querySelector('[data-row="adjust"]');

  const delayButtons = [
    { label: i18n("scheduleDelay5m", "In 5m"), minutes: 5 },
    { label: i18n("scheduleDelay10m", "In 10m"), minutes: 10 },
    { label: i18n("scheduleDelay30m", "In 30m"), minutes: 30 },
    { label: i18n("scheduleDelay1h", "In 1h"), minutes: 60 }
  ];

  const adjustButtons = [
    { label: i18n("scheduleAdjustPlus1h", "+1h"), hours: 1, days: 0 },
    { label: i18n("scheduleAdjustMinus1h", "-1h"), hours: -1, days: 0 },
    { label: i18n("scheduleAdjustPlus1d", "+1d"), hours: 0, days: 1 },
    { label: i18n("scheduleAdjustMinus1d", "-1d"), hours: 0, days: -1 }
  ];

  for (const buttonConfig of delayButtons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "xmate-schedule-btn";
    button.textContent = buttonConfig.label;
    button.addEventListener("click", async () => {
      if (scheduleAssistApplying) return;
      const currentDialog = findScheduleDialog();
      if (!currentDialog) return;
      scheduleAssistApplying = true;

      const target = roundToMinute(new Date(Date.now() + buttonConfig.minutes * 60_000));
      try {
        await applyScheduleDateTime(currentDialog, target);
      } finally {
        scheduleAssistApplying = false;
      }
    });
    delayRow.appendChild(button);
  }

  for (const buttonConfig of adjustButtons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "xmate-schedule-btn";
    button.textContent = buttonConfig.label;
    button.addEventListener("click", async () => {
      if (scheduleAssistApplying) return;
      const currentDialog = findScheduleDialog();
      if (!currentDialog) return;
      scheduleAssistApplying = true;

      try {
        const base = readScheduledDateTime(currentDialog) || new Date();
        const target = new Date(base.getTime());
        if (buttonConfig.hours) {
          target.setHours(target.getHours() + buttonConfig.hours);
        }
        if (buttonConfig.days) {
          target.setDate(target.getDate() + buttonConfig.days);
        }

        await applyScheduleDateTime(currentDialog, roundToMinute(target));
      } finally {
        scheduleAssistApplying = false;
      }
    });
    adjustRow.appendChild(button);
  }

  return panel;
}

function ensureScheduleAssistUI() {
  const now = Date.now();
  if (now - scheduleAssistLastScanAt < SCHEDULE_ASSIST_SCAN_INTERVAL_MS) return;
  scheduleAssistLastScanAt = now;

  const dialog = findScheduleDialog();
  if (!dialog) return;
  if (dialog.querySelector(`#${SCHEDULE_ASSIST_ID}`)) return;

  const panel = createScheduleAssistPanel(dialog);
  const anchor = findScheduleAssistAnchor(dialog);
  if (anchor.mode === "before" && anchor.node?.parentElement) {
    anchor.node.insertAdjacentElement("beforebegin", panel);
  } else {
    anchor.node.appendChild(panel);
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snapshotFromRaw(raw) {
  if (raw && typeof raw === "object" && raw.usersById && raw.handleToId) {
    return {
      usersById: raw.usersById && typeof raw.usersById === "object" ? raw.usersById : {},
      handleToId: raw.handleToId && typeof raw.handleToId === "object" ? raw.handleToId : {}
    };
  }

  if (raw && typeof raw === "object") {
    const usersById = {};
    const handleToId = {};
    for (const [rawHandle, record] of Object.entries(raw)) {
      const handle = normalizeHandle(rawHandle || record?.handle);
      const comment = typeof record?.comment === "string" ? record.comment : "";
      if (!handle || !comment.trim()) continue;
      const userId = normalizeUserId(record?.userId) || makeFallbackUserId(handle);
      if (!userId) continue;
      usersById[userId] = {
        userId,
        handle,
        comment,
        createdAt: record?.createdAt || "",
        updatedAt: record?.updatedAt || ""
      };
      handleToId[handle] = userId;
    }
    return { usersById, handleToId };
  }

  return { usersById: {}, handleToId: {} };
}

function applySnapshot(snapshot) {
  const parsed = snapshotFromRaw(snapshot);
  usersByIdCache = parsed.usersById;
  handleToIdCache = parsed.handleToId;

  for (const [handle, userId] of Object.entries(handleToIdCache)) {
    if (isLikelyRealUserId(userId)) {
      handleIdHintCache[handle] = userId;
    }
  }
}

function upsertLocalUser(user) {
  const userId = normalizeUserId(user?.userId);
  if (!userId) return;
  usersByIdCache[userId] = user;
  const handle = normalizeHandle(user?.handle);
  if (handle) {
    handleToIdCache[handle] = userId;
    if (isLikelyRealUserId(userId)) {
      handleIdHintCache[handle] = userId;
    }
  }
}

function removeLocalUser(userId, handle) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedHandle = normalizeHandle(handle);

  if (normalizedUserId && usersByIdCache[normalizedUserId]) {
    delete usersByIdCache[normalizedUserId];
  }

  if (normalizedHandle && handleToIdCache[normalizedHandle]) {
    const mapped = handleToIdCache[normalizedHandle];
    if (!normalizedUserId || mapped === normalizedUserId) {
      delete handleToIdCache[normalizedHandle];
    }
  }
}

function getKnownUserIdForHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return "";
  const mapped = normalizeUserId(handleToIdCache[normalized]);
  if (mapped) return mapped;
  return normalizeUserId(handleIdHintCache[normalized]);
}

function getUserForHandle(handle) {
  const userId = getKnownUserIdForHandle(handle);
  if (!userId) return null;
  return usersByIdCache[userId] || null;
}

function getCommentForHandle(handle) {
  const user = getUserForHandle(handle);
  return user?.comment || "";
}

function findUserIdInScripts(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return "";

  const escapedHandle = escapeRegExp(normalized);
  const patterns = [
    new RegExp(`"screen_name":"${escapedHandle}"[\\s\\S]{0,500}?"rest_id":"(\\d+)"`, "i"),
    new RegExp(`"rest_id":"(\\d+)"[\\s\\S]{0,500}?"screen_name":"${escapedHandle}"`, "i"),
    new RegExp(`"screen_name":"${escapedHandle}"[\\s\\S]{0,500}?"id_str":"(\\d+)"`, "i"),
    new RegExp(`"id_str":"(\\d+)"[\\s\\S]{0,500}?"screen_name":"${escapedHandle}"`, "i")
  ];

  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text || text.length > 2_000_000) continue;
    if (!text.toLowerCase().includes(normalized)) continue;

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match?.[1]) continue;
      const userId = normalizeUserId(match[1]);
      if (isLikelyRealUserId(userId)) {
        return userId;
      }
    }
  }

  return "";
}

function findUserIdFromUserLinksForProfile(handle) {
  const normalized = normalizeHandle(handle);
  const routeHandle = getProfileHandleFromPath(location.pathname);
  if (!normalized || routeHandle !== normalized) return "";

  const candidates = new Set();
  const links = document.querySelectorAll('a[href*="/i/user/"]');
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    const match = href.match(/\/i\/user\/(\d+)/);
    if (match?.[1]) candidates.add(match[1]);
  }

  if (candidates.size === 1) {
    return normalizeUserId(Array.from(candidates)[0]);
  }

  return "";
}

async function discoverUserIdForHandle(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return "";

  const known = getKnownUserIdForHandle(normalized);
  if (isLikelyRealUserId(known)) {
    return known;
  }

  const fromScripts = findUserIdInScripts(normalized);
  if (isLikelyRealUserId(fromScripts)) {
    handleIdHintCache[normalized] = fromScripts;
    return fromScripts;
  }

  const fromLinks = findUserIdFromUserLinksForProfile(normalized);
  if (isLikelyRealUserId(fromLinks)) {
    handleIdHintCache[normalized] = fromLinks;
    return fromLinks;
  }

  return "";
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      if (isDevReloading) {
        resolve({ ok: false, error: "Extension reloading" });
        return;
      }

      if (!chrome?.runtime?.id) {
        resolve({ ok: false, error: "Extension runtime unavailable" });
        return;
      }

      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        try {
          const runtimeError = chrome.runtime?.lastError;
          if (runtimeError) {
            resolve({ ok: false, error: runtimeError.message });
            return;
          }
          resolve(response || { ok: false, error: "Empty response" });
        } catch (error) {
          resolve({ ok: false, error: String(error?.message || error) });
        }
      });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message || error) });
    }
  });
}

async function fetchAllUsers() {
  const response = await sendMessage("XWATCH_GET_ALL_USERS");
  if (!response?.ok) return;

  if (response.snapshot) {
    applySnapshot(response.snapshot);
    return;
  }

  applySnapshot({
    usersById: response.usersById || response.users || {},
    handleToId: response.handleToId || {}
  });
}

async function ensureProfileData(handle, userId) {
  const response = await sendMessage("XWATCH_GET_USER", { handle, userId });
  if (!response?.ok) return null;

  const normalizedHandle = normalizeHandle(handle);
  const resolvedUserId = normalizeUserId(response.resolvedUserId);
  if (normalizedHandle && resolvedUserId) {
    handleToIdCache[normalizedHandle] = resolvedUserId;
    if (isLikelyRealUserId(resolvedUserId)) {
      handleIdHintCache[normalizedHandle] = resolvedUserId;
    }
  }

  if (response.user) {
    upsertLocalUser(response.user);
    return response.user;
  }

  return null;
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${PROFILE_BOX_ID} {
      border: 0;
      border-radius: 3px;
      padding: 4px 8px;
      margin: 6px 0 10px;
      background: rgba(83, 100, 113, 0.12);
      color: inherit;
      font-size: 12px;
    }

    #${PROFILE_BOX_ID} .xwatch-inline-editor {
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }

    #${PROFILE_BOX_ID} .xwatch-label {
      opacity: 0.9;
      font-weight: 600;
      flex: 0 0 auto;
    }

    #${PROFILE_BOX_ID} .xwatch-sep {
      opacity: 0.5;
      flex: 0 0 auto;
    }

    #${PROFILE_BOX_ID} input[data-role="comment"] {
      flex: 1 1 auto;
      min-width: 120px;
      border: 0;
      outline: 0;
      padding: 3px 8px;
      border-radius: 3px;
      background: rgba(83, 100, 113, 0.22);
      color: inherit;
      font: inherit;
    }

    #${PROFILE_BOX_ID} button[data-role="save"] {
      margin: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: rgb(29, 155, 240);
      padding: 0;
      cursor: pointer;
      font-weight: 600;
      flex: 0 0 auto;
    }

    #${PROFILE_BOX_ID} .xwatch-status {
      margin-left: 6px;
      opacity: 0.8;
      font-size: 12px;
      white-space: nowrap;
    }

    .xwatch-inline-note {
      margin-left: 4px;
      font-size: 11px;
      border: 0;
      border-radius: 3px;
      padding: 1px 8px;
      background: rgba(83, 100, 113, 0.22);
      opacity: 0.95;
      display: inline-flex;
      align-items: center;
      max-width: 220px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      vertical-align: middle;
      line-height: 1.3;
    }

    #${SCHEDULE_ASSIST_ID} {
      margin-top: 16px !important;
      padding: 14px 18px 12px !important;
    }

    #${SCHEDULE_ASSIST_ID} .xmate-schedule-row {
      display: flex;
      column-gap: 12px !important;
      row-gap: 12px !important;
      flex-wrap: wrap;
      margin: 0 0 12px 0 !important;
      padding: 0 2px !important;
    }

    #${SCHEDULE_ASSIST_ID} .xmate-schedule-btn {
      border: 0;
      border-radius: 4px;
      padding: 10px 16px !important;
      font-size: 14px;
      line-height: 1.2;
      background: rgba(83, 100, 113, 0.16);
      color: inherit;
      cursor: pointer;
      margin: 0 !important;
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  `;

  document.documentElement.appendChild(style);
}

function createProfileBox(handle, user, userIdHint) {
  const box = document.createElement("section");
  box.id = PROFILE_BOX_ID;
  box.dataset.handle = handle;
  box.dataset.userId = normalizeUserId(userIdHint || user?.userId);
  box.innerHTML = `
    <div class="xwatch-inline-editor">
      <span class="xwatch-label">${i18n("profileMemoLabel", "XMate Memo")}</span>
      <span class="xwatch-sep">|</span>
      <input data-role="comment" type="text" placeholder="${i18n("profileMemoPlaceholder", "Write a note")}" />
      <span class="xwatch-sep">|</span>
      <button type="button" data-role="save">${i18n("profileSaveButton", "Save")}</button>
      <span class="xwatch-status"></span>
    </div>
  `;

  const input = box.querySelector('input[data-role="comment"]');
  const saveButton = box.querySelector('button[data-role="save"]');
  const status = box.querySelector(".xwatch-status");

  input.value = user?.comment || "";
  box.dataset.dirty = "0";

  input.addEventListener("input", () => {
    box.dataset.dirty = "1";
  });

  saveButton.addEventListener("click", async () => {
    const activeHandle = normalizeHandle(box.dataset.handle);
    if (!activeHandle) return;

    let activeUserId = normalizeUserId(box.dataset.userId);
    if (!activeUserId || isFallbackUserId(activeUserId)) {
      const discovered = await discoverUserIdForHandle(activeHandle);
      if (discovered) {
        activeUserId = discovered;
      }
    }

    status.textContent = i18n("statusSaving", "Saving...");
    status.dataset.state = "saving";

    const patch = {
      comment: input.value || ""
    };

    const response = await sendMessage("XWATCH_UPSERT_USER", {
      handle: activeHandle,
      userId: activeUserId,
      patch
    });

    if (response?.ok) {
      if (response.deleted) {
        removeLocalUser(activeUserId, activeHandle);
        input.value = "";
        box.dataset.userId = "";
        box.dataset.dirty = "0";
        status.textContent = i18n("statusDeleted", "Deleted");
        status.dataset.state = "deleted";
      } else if (response.user) {
        upsertLocalUser(response.user);
        box.dataset.userId = normalizeUserId(response.user.userId);
        input.value = response.user.comment || "";
        box.dataset.dirty = "0";
        status.textContent = i18n("statusSaved", "Saved");
        status.dataset.state = "saved";
      } else {
        status.textContent = i18n("statusNoChange", "No changes");
        status.dataset.state = "unchanged";
      }

      scanTimelineForNotes();
      setTimeout(() => {
        if (status.dataset.state === "saved" || status.dataset.state === "deleted" || status.dataset.state === "unchanged") {
          status.textContent = "";
          status.dataset.state = "";
        }
      }, 1500);
      return;
    }

    status.textContent = i18n("statusSaveFailed", "Save failed");
    status.dataset.state = "failed";

    if (response?.error?.toLowerCase().includes("quota")) {
      alert(i18n("optionsQuotaExceeded", "Storage space exceeded. Please delete some users and try again."));
    }
  });

  return box;
}

function mountProfileBox(handle, user, userIdHint) {
  const primaryColumn = document.querySelector('main [data-testid="primaryColumn"]');
  if (!primaryColumn) return;
  const refNode = primaryColumn.querySelector('div[data-testid="UserDescription"]');

  const resolvedUserId = normalizeUserId(user?.userId || userIdHint || getKnownUserIdForHandle(handle));
  const existing = document.getElementById(PROFILE_BOX_ID);
  if (existing) {
    const previousHandle = normalizeHandle(existing.dataset.handle);
    const isSameHandle = previousHandle === handle;
    existing.dataset.handle = handle;
    existing.dataset.userId = resolvedUserId;

    const input = existing.querySelector('input[data-role="comment"]');
    const isDirty = existing.dataset.dirty === "1";

    if (input && (!isSameHandle || !isDirty)) {
      input.value = user?.comment || "";
    }
    if (!isSameHandle) {
      existing.dataset.dirty = "0";
    }

    if (refNode && existing.parentElement) {
      const shouldMove =
        existing.parentElement !== refNode.parentElement ||
        existing.previousElementSibling !== refNode;
      if (shouldMove) {
        refNode.insertAdjacentElement("afterend", existing);
      }
    }

    return;
  }

  if (!refNode) return;
  const box = createProfileBox(handle, user, resolvedUserId);
  refNode.insertAdjacentElement("afterend", box);
}

function removeProfileBox() {
  const box = document.getElementById(PROFILE_BOX_ID);
  if (box) box.remove();
}

function findInlineHandleTarget(container, safeHandle) {
  const normalizedAtHandle = `@${safeHandle}`;
  const spans = Array.from(container.querySelectorAll("span"));
  const handleSpan = spans.find((span) => {
    const text = String(span.textContent || "").trim().toLowerCase();
    return text === normalizedAtHandle || text.includes(normalizedAtHandle);
  });
  if (handleSpan) {
    return { host: handleSpan.parentElement || container, handleEl: handleSpan };
  }

  const anchors = Array.from(container.querySelectorAll('a[href]'));
  const handleAnchor = anchors.find((anchor) => {
    const hrefHandle = getHandleFromHref(anchor.getAttribute("href"));
    if (hrefHandle !== safeHandle) return false;
    const text = String(anchor.textContent || "").trim().toLowerCase();
    return text.includes(normalizedAtHandle);
  });
  if (handleAnchor) {
    return { host: handleAnchor.parentElement || container, handleEl: handleAnchor };
  }

  const fallbackHost = container.querySelector("div[dir]") || container.firstElementChild || container;
  return { host: fallbackHost, handleEl: null };
}

function setInlineNote(container, handle, comment) {
  const safeHandle = normalizeHandle(handle);
  if (!safeHandle) return;

  let note = container.querySelector(`.xwatch-inline-note[data-handle="${safeHandle}"]`);

  if (!comment) {
    if (note) note.remove();
    return;
  }

  if (!note) {
    note = document.createElement("span");
    note.className = "xwatch-inline-note";
    note.dataset.handle = safeHandle;
    container.appendChild(note);
  }

  note.textContent = comment;
  note.title = `@${safeHandle}: ${comment}`;

  const target = findInlineHandleTarget(container, safeHandle);
  if (target.handleEl) {
    target.handleEl.insertAdjacentElement("afterend", note);
    return;
  }

  if (target.host && note.parentElement !== target.host) {
    target.host.appendChild(note);
  }
}

function scanTimelineForNotes() {
  const nameBlocks = document.querySelectorAll('article [data-testid="User-Name"]');

  nameBlocks.forEach((block) => {
    const anchor = block.querySelector('a[href]');
    if (!anchor) return;

    const handle = getHandleFromHref(anchor.getAttribute("href"));
    if (!handle) return;

    const comment = getCommentForHandle(handle);
    setInlineNote(block, handle, comment);
  });
}

async function syncProfileUIFromRoute() {
  const routeHandle = getProfileHandleFromPath(location.pathname);
  if (!routeHandle) {
    removeProfileBox();
    return;
  }

  const discoveredUserId = await discoverUserIdForHandle(routeHandle);
  const cachedUser = getUserForHandle(routeHandle);
  const queryUserId = normalizeUserId(discoveredUserId || cachedUser?.userId || getKnownUserIdForHandle(routeHandle));
  const fetchedUser = await ensureProfileData(routeHandle, queryUserId);
  const finalUser = fetchedUser || cachedUser || { handle: routeHandle, comment: "", userId: queryUserId };

  mountProfileBox(routeHandle, finalUser, queryUserId);
}

function scheduleRescan() {
  if (isDevReloading) return;
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    if (isDevReloading) return;
    syncProfileUIFromRoute();
    scanTimelineForNotes();
    ensureScheduleAssistUI();
  }, 120);
}

function hookNavigation() {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function pushStateWrapper(...args) {
    const result = originalPushState.apply(this, args);
    scheduleRescan();
    return result;
  };

  history.replaceState = function replaceStateWrapper(...args) {
    const result = originalReplaceState.apply(this, args);
    scheduleRescan();
    return result;
  };

  window.addEventListener("popstate", scheduleRescan);
}

function startObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => {
    scheduleRescan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (isDevReloading) return;
    if (areaName !== "sync") return;
    if (!changes[STORAGE_KEY]) return;

    applySnapshot(changes[STORAGE_KEY].newValue);
    scheduleRescan();
  });
} catch {
  // Ignore registration errors during extension reload.
}

(async function init() {
  injectStyle();
  installImeSendGuard();
  await fetchAllUsers();
  await syncProfileUIFromRoute();
  scanTimelineForNotes();
  ensureScheduleAssistUI();
  hookNavigation();
  startObserver();
})();
