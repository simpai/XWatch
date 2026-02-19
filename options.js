const STORAGE_KEY = "xwatch_users_v1";
let usersCache = {};

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

function toLocalDateText(isoText) {
  if (!isoText) return "-";
  const dt = new Date(isoText);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleString();
}

function getSearchText() {
  const el = document.getElementById("search");
  return (el?.value || "").trim().toLowerCase();
}

function snapshotToUsersById(snapshotLike) {
  if (!snapshotLike || typeof snapshotLike !== "object") return {};
  if (snapshotLike.usersById && typeof snapshotLike.usersById === "object") {
    return snapshotLike.usersById;
  }
  return snapshotLike.users && typeof snapshotLike.users === "object"
    ? snapshotLike.users
    : {};
}

function renderViewer() {
  const tbody = document.getElementById("viewer-body");
  const empty = document.getElementById("viewer-empty");
  if (!tbody || !empty) return;

  const q = getSearchText();
  const entries = Object.entries(usersCache || {}).map(([userId, user]) => ({
    userId,
    handle: String(user?.handle || ""),
    comment: typeof user?.comment === "string" ? user.comment : "",
    updatedAt: user?.updatedAt || ""
  }));

  entries.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

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
    handleTd.textContent = item.handle ? `@${item.handle}` : "-";

    const commentTd = document.createElement("td");
    commentTd.className = "comment";
    commentTd.textContent = item.comment || "-";

    const updatedTd = document.createElement("td");
    updatedTd.textContent = toLocalDateText(item.updatedAt);

    const actionTd = document.createElement("td");
    const delButton = document.createElement("button");
    delButton.type = "button";
    delButton.className = "delete-btn";
    delButton.textContent = "삭제";
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
    tr.appendChild(updatedTd);
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
    setText("quota", "조회 실패");
    return;
  }

  const info = infoResponse.info;
  setText("quota", formatBytes(info.quota));
  setText("used", formatBytes(info.totalUsed));
  setText("remaining", formatBytes(info.remaining));
  setText("key-used", formatBytes(info.keyUsed));

  usersCache = snapshotToUsersById(usersResponse?.snapshot || usersResponse || {});
  setText("user-count", String(Object.keys(usersCache).length));
  renderViewer();
}

document.getElementById("refresh")?.addEventListener("click", refreshUsage);
document.getElementById("search")?.addEventListener("input", renderViewer);

document.addEventListener("DOMContentLoaded", refreshUsage);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (!changes[STORAGE_KEY]) return;

  usersCache = snapshotToUsersById(changes[STORAGE_KEY].newValue || {});
  renderViewer();
  refreshUsage();
});
