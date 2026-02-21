const STORAGE_KEY = "xwatch_users_v1";
const SCHEMA_VERSION = 2;
const FALLBACK_ID_PREFIX = "h:";

let memoCache = createEmptySnapshot();
let isLoaded = false;

function createEmptySnapshot() {
  return {
    version: SCHEMA_VERSION,
    usersById: {},
    handleToId: {}
  };
}

function nowIso() {
  return new Date().toISOString();
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

function makeFallbackUserId(handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return "";
  return `${FALLBACK_ID_PREFIX}${normalized}`;
}

function normalizeUserRecord(userId, handle, record = {}) {
  const normalizedUserId = normalizeUserId(userId || record.userId);
  const normalizedHandle = normalizeHandle(handle || record.handle);
  const ts = nowIso();
  return {
    userId: normalizedUserId,
    handle: normalizedHandle,
    comment: typeof record.comment === "string" ? record.comment : "",
    createdAt: typeof record.createdAt === "string" ? record.createdAt : ts,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ts
  };
}

function normalizeSnapshot(raw) {
  const next = createEmptySnapshot();

  if (!raw || typeof raw !== "object") {
    return next;
  }

  const usersById = raw.usersById && typeof raw.usersById === "object" ? raw.usersById : {};
  for (const [rawUserId, record] of Object.entries(usersById)) {
    const userId = normalizeUserId(rawUserId || record?.userId);
    if (!userId) continue;
    const normalized = normalizeUserRecord(userId, record?.handle, record || {});
    if (!normalized.comment.trim()) continue;
    next.usersById[userId] = normalized;
  }

  const handleToId = raw.handleToId && typeof raw.handleToId === "object" ? raw.handleToId : {};
  for (const [rawHandle, rawUserId] of Object.entries(handleToId)) {
    const handle = normalizeHandle(rawHandle);
    const userId = normalizeUserId(rawUserId);
    if (!handle || !userId) continue;
    if (!next.usersById[userId]) continue;
    next.handleToId[handle] = userId;
  }

  for (const [userId, record] of Object.entries(next.usersById)) {
    const handle = normalizeHandle(record.handle);
    if (handle && !next.handleToId[handle]) {
      next.handleToId[handle] = userId;
    }
  }

  return next;
}

function migrateLegacySnapshot(raw) {
  const migrated = createEmptySnapshot();
  if (!raw || typeof raw !== "object") {
    return migrated;
  }

  for (const [rawHandle, record] of Object.entries(raw)) {
    const handle = normalizeHandle(rawHandle || record?.handle);
    if (!handle || !record || typeof record !== "object") continue;

    const comment = typeof record.comment === "string" ? record.comment : "";
    if (!comment.trim()) continue;

    const userIdFromRecord = normalizeUserId(record.userId);
    const userId = userIdFromRecord || makeFallbackUserId(handle);
    if (!userId) continue;

    migrated.usersById[userId] = normalizeUserRecord(userId, handle, record);
    migrated.handleToId[handle] = userId;
  }

  return migrated;
}

function isV2Snapshot(raw) {
  return Boolean(
    raw &&
    typeof raw === "object" &&
    raw.version === SCHEMA_VERSION &&
    raw.usersById &&
    typeof raw.usersById === "object" &&
    raw.handleToId &&
    typeof raw.handleToId === "object"
  );
}

async function persistCache() {
  memoCache.version = SCHEMA_VERSION;
  await chrome.storage.sync.set({ [STORAGE_KEY]: memoCache });
}

function mergeFallbackRecordIntoUser(fallbackId, userId, handleHint = "") {
  if (!fallbackId || !userId || fallbackId === userId) return false;
  if (!isFallbackUserId(fallbackId)) return false;

  const fallbackRecord = memoCache.usersById[fallbackId];
  if (!fallbackRecord) return false;

  const existingTarget = memoCache.usersById[userId];
  if (!existingTarget) {
    memoCache.usersById[userId] = normalizeUserRecord(
      userId,
      handleHint || fallbackRecord.handle,
      {
        ...fallbackRecord,
        userId
      }
    );
  } else if (!String(existingTarget.comment || "").trim() && String(fallbackRecord.comment || "").trim()) {
    memoCache.usersById[userId] = normalizeUserRecord(
      userId,
      handleHint || existingTarget.handle || fallbackRecord.handle,
      {
        ...existingTarget,
        comment: fallbackRecord.comment,
        createdAt: fallbackRecord.createdAt || existingTarget.createdAt
      }
    );
  }

  delete memoCache.usersById[fallbackId];

  for (const [handle, mappedUserId] of Object.entries(memoCache.handleToId)) {
    if (mappedUserId === fallbackId) {
      memoCache.handleToId[handle] = userId;
    }
  }

  return true;
}

function bindHandleToUserId(userId, handle) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedHandle = normalizeHandle(handle);
  if (!normalizedUserId || !normalizedHandle) return false;

  let mutated = false;
  const mappedUserId = memoCache.handleToId[normalizedHandle];
  if (mappedUserId && mappedUserId !== normalizedUserId) {
    if (isFallbackUserId(mappedUserId)) {
      if (mergeFallbackRecordIntoUser(mappedUserId, normalizedUserId, normalizedHandle)) {
        mutated = true;
      }
    }
  }

  const record = memoCache.usersById[normalizedUserId];
  if (record) {
    const previousHandle = normalizeHandle(record.handle);
    if (previousHandle && previousHandle !== normalizedHandle && memoCache.handleToId[previousHandle] === normalizedUserId) {
      delete memoCache.handleToId[previousHandle];
      mutated = true;
    }
    if (record.handle !== normalizedHandle) {
      record.handle = normalizedHandle;
      mutated = true;
    }
  }

  if (memoCache.handleToId[normalizedHandle] !== normalizedUserId) {
    memoCache.handleToId[normalizedHandle] = normalizedUserId;
    mutated = true;
  }

  return mutated;
}

function lookupUserId(userId, handle, allowFallback) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedHandle = normalizeHandle(handle);
  if (normalizedUserId) return normalizedUserId;

  if (normalizedHandle && memoCache.handleToId[normalizedHandle]) {
    return memoCache.handleToId[normalizedHandle];
  }

  if (allowFallback && normalizedHandle) {
    return makeFallbackUserId(normalizedHandle);
  }

  return "";
}

async function ensureLoaded() {
  if (isLoaded) return;

  const data = await chrome.storage.sync.get(STORAGE_KEY);
  const raw = data?.[STORAGE_KEY];

  let next;
  if (isV2Snapshot(raw)) {
    next = normalizeSnapshot(raw);
  } else {
    next = migrateLegacySnapshot(raw);
  }

  const changed = JSON.stringify(raw || null) !== JSON.stringify(next);
  memoCache = next;
  isLoaded = true;

  if (changed) {
    await persistCache();
  }
}

async function getUser(userId, handle) {
  await ensureLoaded();

  const normalizedUserId = normalizeUserId(userId);
  const normalizedHandle = normalizeHandle(handle);
  let mutated = false;

  if (normalizedUserId && normalizedHandle) {
    mutated = bindHandleToUserId(normalizedUserId, normalizedHandle) || mutated;
  }

  const resolvedUserId = lookupUserId(normalizedUserId, normalizedHandle, false);
  if (!resolvedUserId) {
    if (mutated) await persistCache();
    return { user: null, resolvedUserId: "" };
  }

  const user = memoCache.usersById[resolvedUserId] || null;
  if (mutated) await persistCache();
  return { user, resolvedUserId };
}

async function upsertUser(userId, handle, patch = {}) {
  await ensureLoaded();

  const normalizedHandle = normalizeHandle(handle);
  const explicitUserId = normalizeUserId(userId);
  let resolvedUserId = lookupUserId(explicitUserId, normalizedHandle, true);
  if (!resolvedUserId) return { user: null, deleted: false };

  let mutated = false;
  if (explicitUserId && normalizedHandle) {
    mutated = bindHandleToUserId(explicitUserId, normalizedHandle) || mutated;
    resolvedUserId = explicitUserId;
  }

  const nextComment = typeof patch.comment === "string" ? patch.comment : "";
  if (!nextComment.trim()) {
    const deleted = await deleteUser(resolvedUserId, normalizedHandle);
    return { user: null, deleted };
  }

  const base = memoCache.usersById[resolvedUserId] || normalizeUserRecord(resolvedUserId, normalizedHandle, {});
  const ts = nowIso();
  const merged = normalizeUserRecord(
    resolvedUserId,
    normalizedHandle || base.handle,
    {
      ...base,
      ...patch,
      userId: resolvedUserId,
      handle: normalizedHandle || base.handle,
      updatedAt: ts
    }
  );
  merged.updatedAt = ts;

  const previousHandle = normalizeHandle(base.handle);
  const nextHandle = normalizeHandle(merged.handle);
  if (previousHandle && previousHandle !== nextHandle && memoCache.handleToId[previousHandle] === resolvedUserId) {
    delete memoCache.handleToId[previousHandle];
    mutated = true;
  }

  memoCache.usersById[resolvedUserId] = merged;
  if (nextHandle) {
    memoCache.handleToId[nextHandle] = resolvedUserId;
  }

  await persistCache();
  return { user: merged, deleted: false };
}

async function deleteUser(userId, handle) {
  await ensureLoaded();

  const resolvedUserId = lookupUserId(userId, handle, true);
  if (!resolvedUserId || !memoCache.usersById[resolvedUserId]) return false;

  delete memoCache.usersById[resolvedUserId];

  for (const [mappedHandle, mappedUserId] of Object.entries(memoCache.handleToId)) {
    if (mappedUserId === resolvedUserId) {
      delete memoCache.handleToId[mappedHandle];
    }
  }

  await persistCache();
  return true;
}

async function getStorageInfo() {
  const totalUsed = await chrome.storage.sync.getBytesInUse(null);
  const keyUsed = await chrome.storage.sync.getBytesInUse(STORAGE_KEY);
  const quota = chrome.storage.sync.QUOTA_BYTES;
  return {
    quota,
    totalUsed,
    keyUsed,
    remaining: Math.max(0, quota - totalUsed)
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureLoaded();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (!changes[STORAGE_KEY]) return;

  memoCache = normalizeSnapshot(changes[STORAGE_KEY].newValue);
  isLoaded = true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "XWATCH_GET_USER": {
        const { user, resolvedUserId } = await getUser(message.userId, message.handle);
        sendResponse({ ok: true, user, resolvedUserId });
        return;
      }
      case "XWATCH_GET_OR_CREATE_USER": {
        const { user, resolvedUserId } = await getUser(message.userId, message.handle);
        sendResponse({ ok: true, user, resolvedUserId });
        return;
      }
      case "XWATCH_UPSERT_USER": {
        const result = await upsertUser(message.userId, message.handle, message.patch || {});
        sendResponse({ ok: true, user: result.user, deleted: result.deleted });
        return;
      }
      case "XWATCH_DELETE_USER": {
        const deleted = await deleteUser(message.userId, message.handle);
        sendResponse({ ok: true, deleted });
        return;
      }
      case "XWATCH_DELETE_ALL_USERS": {
        await ensureLoaded();
        memoCache = createEmptySnapshot();
        await persistCache();
        sendResponse({ ok: true });
        return;
      }
      case "XWATCH_IMPORT_USERS": {
        await ensureLoaded();
        const { users, mode } = message;
        if (mode === "replace") {
          memoCache = createEmptySnapshot();
        }

        let mutated = false;
        const usersArray = Array.isArray(users) ? users : Object.values(users || {});
        for (const record of usersArray) {
          if (!record) continue;
          const normalizedHandle = normalizeHandle(record.handle);
          const explicitUserId = normalizeUserId(record.userId);
          let targetUserId = explicitUserId || makeFallbackUserId(normalizedHandle);
          if (!targetUserId) continue;

          const base = memoCache.usersById[targetUserId] || normalizeUserRecord(targetUserId, normalizedHandle, {});
          const merged = normalizeUserRecord(
            targetUserId,
            normalizedHandle || base.handle,
            {
              ...base,
              ...record,
              userId: targetUserId,
              handle: normalizedHandle || base.handle,
              updatedAt: record.updatedAt || base.updatedAt || nowIso()
            }
          );

          memoCache.usersById[targetUserId] = merged;
          if (merged.handle) {
            memoCache.handleToId[merged.handle] = targetUserId;
          }
          mutated = true;
        }

        if (mutated || mode === "replace") {
          await persistCache();
        }
        sendResponse({ ok: true });
        return;
      }
      case "XWATCH_GET_ALL_USERS": {
        await ensureLoaded();
        sendResponse({
          ok: true,
          snapshot: memoCache,
          usersById: memoCache.usersById,
          handleToId: memoCache.handleToId,
          users: memoCache.usersById
        });
        return;
      }
      case "XWATCH_GET_STORAGE_INFO": {
        const info = await getStorageInfo();
        sendResponse({ ok: true, info });
        return;
      }
      case "XWATCH_DEV_RELOAD_EXTENSION": {
        sendResponse({ ok: true });
        setTimeout(() => {
          chrome.runtime.reload();
        }, 150);
        return;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});
