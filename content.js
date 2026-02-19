const STORAGE_KEY = "xwatch_users_v1";
const PROFILE_BOX_ID = "xwatch-profile-note-box";
const STYLE_ID = "xwatch-style";
const FALLBACK_ID_PREFIX = "h:";

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
      border-radius: 8px;
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
      border-radius: 6px;
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
      margin-left: 6px;
      font-size: 11px;
      border: 1px solid rgba(83, 100, 113, 0.45);
      border-radius: 8px;
      padding: 1px 6px;
      opacity: 0.9;
      display: inline-block;
      max-width: 240px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      vertical-align: middle;
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
      <span class="xwatch-label">XWatch메모</span>
      <span class="xwatch-sep">|</span>
      <input data-role="comment" type="text" placeholder="메모 입력" />
      <span class="xwatch-sep">|</span>
      <button type="button" data-role="save">저장</button>
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

    status.textContent = "저장 중...";

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
        status.textContent = "삭제됨";
      } else if (response.user) {
        upsertLocalUser(response.user);
        box.dataset.userId = normalizeUserId(response.user.userId);
        input.value = response.user.comment || "";
        box.dataset.dirty = "0";
        status.textContent = "저장됨";
      } else {
        status.textContent = "변경 없음";
      }

      scanTimelineForNotes();
      setTimeout(() => {
        if (status.textContent === "저장됨" || status.textContent === "삭제됨" || status.textContent === "변경 없음") {
          status.textContent = "";
        }
      }, 1500);
      return;
    }

    status.textContent = "저장 실패";
  });

  return box;
}

function mountProfileBox(handle, user, userIdHint) {
  const primaryColumn = document.querySelector('main [data-testid="primaryColumn"]');
  if (!primaryColumn) return;

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
    return;
  }

  const refNode = primaryColumn.querySelector('div[data-testid="UserDescription"]') ||
    primaryColumn.querySelector('div[data-testid="UserName"]');
  const box = createProfileBox(handle, user, resolvedUserId);

  if (refNode) {
    refNode.insertAdjacentElement("afterend", box);
  } else {
    primaryColumn.prepend(box);
  }
}

function removeProfileBox() {
  const box = document.getElementById(PROFILE_BOX_ID);
  if (box) box.remove();
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
  hookNavigation();
  startObserver();
})();
