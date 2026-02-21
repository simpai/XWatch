const STORAGE_PREFIX = "xw_u_";
let usersCache = {};

function i18n(key, fallback = "") {
  const message = chrome.i18n.getMessage(key);
  return message || fallback;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function getSearchText() {
  const el = document.getElementById("search");
  return (el?.value || "").trim().toLowerCase();
}

function snapshotToUsersById(data) {
  if (!data || typeof data !== "object") return {};
  const usersById = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith(STORAGE_PREFIX)) {
      const userId = key.slice(STORAGE_PREFIX.length);
      if (userId && value) {
        usersById[userId] = {
          userId: value.i || value.userId || userId,
          handle: value.h || value.handle || "",
          comment: value.c || value.comment || ""
        };
      }
    }
  }
  return usersById;
}

function renderViewer() {
  const tbody = document.getElementById("viewer-body");
  const empty = document.getElementById("viewer-empty");
  if (!tbody || !empty) return;

  const q = getSearchText();
  const entries = Object.entries(usersCache || {}).map(([userId, user]) => ({
    userId,
    handle: String(user?.handle || ""),
    comment: typeof user?.comment === "string" ? user.comment : ""
  }));

  entries.sort((a, b) => a.userId.localeCompare(b.userId));

  const filtered = q
    ? entries.filter((item) =>
      item.userId.toLowerCase().includes(q) ||
      item.handle.toLowerCase().includes(q) ||
      item.comment.toLowerCase().includes(q)
    )
    : entries;

  tbody.textContent = "";
  for (const item of filtered) {
    const tr = document.createElement("tr");

    const userIdTd = document.createElement("td");
    userIdTd.textContent = item.userId;

    const handleTd = document.createElement("td");
    if (item.handle) {
      const a = document.createElement("a");
      a.href = `https://x.com/${item.handle}`;
      a.target = "_blank";
      a.textContent = `@${item.handle}`;
      handleTd.appendChild(a);
    } else {
      handleTd.textContent = "-";
    }

    const commentTd = document.createElement("td");
    commentTd.className = "comment";
    commentTd.textContent = item.comment || "-";

    const actionTd = document.createElement("td");
    const delButton = document.createElement("button");
    delButton.type = "button";
    delButton.className = "delete-btn";
    delButton.textContent = i18n("optionsDelete", "Delete");
    delButton.addEventListener("click", async () => {
      const response = await sendMessage("XWATCH_DELETE_USER", { userId: item.userId });
      if (!response?.ok) return;
      delete usersCache[item.userId];
      renderViewer();
      refreshUsage();
    });
    actionTd.appendChild(delButton);

    tr.appendChild(userIdTd);
    tr.appendChild(handleTd);
    tr.appendChild(commentTd);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }

  empty.style.display = filtered.length ? "none" : "block";
}

async function sendMessage(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "Empty response" });
    });
  });
}

async function refreshUsage() {
  const [infoResponse, usersResponse] = await Promise.all([
    sendMessage("XWATCH_GET_STORAGE_INFO"),
    sendMessage("XWATCH_GET_ALL_USERS")
  ]);

  if (!infoResponse?.ok) {
    setText("quota", i18n("optionsQuotaFetchFailed", "Failed"));
    return;
  }

  const info = infoResponse.info;
  setText("quota", formatBytes(info.quota));
  setText("used", formatBytes(info.totalUsed));
  setText("remaining", formatBytes(info.remaining));
  setText("key-used", formatBytes(info.keyUsed));

  usersCache = usersResponse?.usersById || {};
  setText("user-count", String(Object.keys(usersCache).length));
  renderViewer();
}

function applyI18n() {
  document.title = i18n("optionsTitle", "XMate Settings");
  setText("options-main-title", i18n("optionsMainTitle", "XMate Settings"));
  setText("options-storage-title", i18n("optionsStorageTitle", "chrome.storage.sync Usage"));
  setText("options-total-quota-label", i18n("optionsTotalQuota", "Total quota"));
  setText("options-used-label", i18n("optionsUsed", "Used"));
  setText("options-remaining-label", i18n("optionsRemaining", "Remaining"));
  setText("options-data-usage-label", i18n("optionsDataUsage", "XMate data"));
  setText("options-user-count-label", i18n("optionsUserCount", "Saved users"));
  setText("refresh", i18n("optionsRefresh", "Refresh"));
  setText("options-viewer-title", i18n("optionsViewerTitle", "Saved Notes Viewer"));
  setText("options-col-user-id", i18n("optionsColUserId", "User ID"));
  setText("options-col-handle", i18n("optionsColHandle", "Handle"));
  setText("options-col-comment", i18n("optionsColComment", "Comment"));

  setText("options-col-action", i18n("optionsColAction", "Action"));
  setText("viewer-empty", i18n("optionsViewerEmpty", "No data to display."));

  const search = document.getElementById("search");
  if (search) {
    search.placeholder = i18n("optionsSearchPlaceholder", "Search by handle or comment");
  }
}

document.getElementById("btn-refresh")?.addEventListener("click", refreshUsage);
document.getElementById("search")?.addEventListener("input", renderViewer);

document.getElementById("btn-export")?.addEventListener("click", () => {
  const dataStr = JSON.stringify(Object.values(usersCache || {}), null, 2);
  const blob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `xwatch_users_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

async function handleImport(mode) {
  const fileInput = document.getElementById("file-import");
  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const users = JSON.parse(text);
      const response = await sendMessage("XWATCH_IMPORT_USERS", { users, mode });
      if (!response?.ok) {
        if (response?.error?.toLowerCase().includes("quota")) {
          alert(i18n("optionsQuotaExceeded", "Storage space exceeded. Please delete some users and try again."));
        } else {
          alert("Failed to import: " + (response?.error || "Unknown error"));
        }
      } else {
        refreshUsage();
        alert(i18n("optionsImportSuccess", "Import successful."));
      }
    } catch (err) {
      alert("Invalid JSON file");
    }
    fileInput.value = ""; // reset
  };
  fileInput.click();
}

document.getElementById("btn-import-append")?.addEventListener("click", () => handleImport("append"));
document.getElementById("btn-import-replace")?.addEventListener("click", () => {
  if (confirm(i18n("optionsConfirmReplace", "Are you sure you want to completely replace all saved users?"))) {
    handleImport("replace");
  }
});

document.getElementById("btn-delete-all")?.addEventListener("click", async () => {
  if (confirm(i18n("optionsConfirmDeleteAll", "Are you sure you want to delete ALL saved users?"))) {
    const response = await sendMessage("XWATCH_DELETE_ALL_USERS");
    if (!response?.ok) {
      alert("Failed to delete all: " + (response?.error || "Unknown error"));
    } else {
      refreshUsage();
    }
  }
});

document.addEventListener("DOMContentLoaded", () => {
  applyI18n();
  refreshUsage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  let changed = false;
  for (const [key, change] of Object.entries(changes)) {
    if (key.startsWith(STORAGE_PREFIX)) {
      changed = true;
      const userId = key.slice(STORAGE_PREFIX.length);
      if (!change.newValue) {
        delete usersCache[userId];
      } else {
        usersCache[userId] = {
          userId: change.newValue.i || change.newValue.userId || userId,
          handle: change.newValue.h || change.newValue.handle || "",
          comment: change.newValue.c || change.newValue.comment || ""
        };
      }
    }
  }

  if (changed) {
    renderViewer();
    refreshUsage();
  }
});
