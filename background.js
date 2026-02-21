const STORAGE_KEY_LEGACY = "xwatch_users_v1";
const STORAGE_PREFIX = "xw_u_";
const FALLBACK_ID_PREFIX = "h:";

let memoCache = createEmptySnapshot();
let isLoaded = false;

function createEmptySnapshot() {
  return {
    usersById: {},
    handleToId: {}
  };
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
  return {
    userId: normalizedUserId,
    handle: normalizedHandle,
    comment: typeof record.comment === "string" ? record.comment : ""
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
    raw.version === 2 &&
    raw.usersById &&
    typeof raw.usersById === "object" &&
    raw.handleToId &&
    typeof raw.handleToId === "object"
  );
}

async function persistUser(user) {
  if (!user || !user.userId) return;
  const packed = { i: user.userId };
  if (user.handle) packed.h = user.handle;
  if (user.comment) packed.c = user.comment;

  await chrome.storage.sync.set({ [`${STORAGE_PREFIX}${user.userId}`]: packed });
}

async function removePersistedUser(userId) {
  if (!userId) return;
  await chrome.storage.sync.remove(`${STORAGE_PREFIX}${userId}`);
}

function mergeFallbackRecordIntoUser(fallbackId, userId, handleHint = "") {
  if (!fallbackId || !userId || fallbackId === userId) return { mutated: false, deletedFallback: false };
  if (!isFallbackUserId(fallbackId)) return { mutated: false, deletedFallback: false };

  const fallbackRecord = memoCache.usersById[fallbackId];
  if (!fallbackRecord) return { mutated: false, deletedFallback: false };

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
        comment: fallbackRecord.comment
      }
    );
  }

  delete memoCache.usersById[fallbackId];

  for (const [handle, mappedUserId] of Object.entries(memoCache.handleToId)) {
    if (mappedUserId === fallbackId) {
      memoCache.handleToId[handle] = userId;
    }
  }

  return { mutated: true, deletedFallback: true };
}

function bindHandleToUserId(userId, handle) {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedHandle = normalizeHandle(handle);
  if (!normalizedUserId || !normalizedHandle) return { mutated: false, deletedFallbackId: "" };

  let mutated = false;
  let deletedFallbackId = "";
  const mappedUserId = memoCache.handleToId[normalizedHandle];
  if (mappedUserId && mappedUserId !== normalizedUserId) {
    if (isFallbackUserId(mappedUserId)) {
      const result = mergeFallbackRecordIntoUser(mappedUserId, normalizedUserId, normalizedHandle);
      if (result.mutated) {
        mutated = true;
        if (result.deletedFallback) {
          deletedFallbackId = mappedUserId;
        }
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

  return { mutated, deletedFallbackId };
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

  const data = await chrome.storage.sync.get(null);
  const rawLegacy = data?.[STORAGE_KEY_LEGACY];

  memoCache = createEmptySnapshot();

  let hasLegacyData = false;
  if (rawLegacy) {
    hasLegacyData = true;
    let next;
    if (isV2Snapshot(rawLegacy)) {
      next = normalizeSnapshot(rawLegacy);
    } else {
      next = migrateLegacySnapshot(rawLegacy);
    }

    // Migrate legacy data to new individual keys
    for (const [userId, user] of Object.entries(next.usersById)) {
      memoCache.usersById[userId] = normalizeUserRecord(userId, user.handle, user);
      memoCache.handleToId[user.handle] = userId;
      await persistUser(memoCache.usersById[userId]);
    }
    await chrome.storage.sync.remove(STORAGE_KEY_LEGACY);
  }

  // Load from new individual keys
  if (!hasLegacyData) {
    for (const [key, value] of Object.entries(data || {})) {
      if (key.startsWith(STORAGE_PREFIX)) {
        const userId = key.slice(STORAGE_PREFIX.length);
        if (!userId || !value) continue;

        const rawHandle = value.h || value.handle;
        const rawComment = value.c || value.comment;
        const rawUserId = value.i || value.userId || userId;

        const normalized = normalizeUserRecord(rawUserId, rawHandle, { ...value, comment: rawComment });
        if (normalized.comment.trim()) {
          memoCache.usersById[userId] = normalized;
          if (normalized.handle) {
            memoCache.handleToId[normalized.handle] = userId;
          }
        } else {
          // Cleanup empty comment strays during load
          await removePersistedUser(userId);
        }
      }
    }
  }

  isLoaded = true;
}

async function getUser(userId, handle) {
  await ensureLoaded();

  const normalizedUserId = normalizeUserId(userId);
  const normalizedHandle = normalizeHandle(handle);

  if (normalizedUserId && normalizedHandle) {
    const { mutated, deletedFallbackId } = bindHandleToUserId(normalizedUserId, normalizedHandle);
    if (mutated) {
      if (deletedFallbackId) await removePersistedUser(deletedFallbackId);
      if (memoCache.usersById[normalizedUserId]) {
        await persistUser(memoCache.usersById[normalizedUserId]);
      }
    }
  }

  const resolvedUserId = lookupUserId(normalizedUserId, normalizedHandle, false);
  if (!resolvedUserId) {
    return { user: null, resolvedUserId: "" };
  }

  const user = memoCache.usersById[resolvedUserId] || null;
  return { user, resolvedUserId };
}

async function upsertUser(userId, handle, patch = {}) {
  await ensureLoaded();

  const normalizedHandle = normalizeHandle(handle);
  const explicitUserId = normalizeUserId(userId);
  let resolvedUserId = lookupUserId(explicitUserId, normalizedHandle, true);
  if (!resolvedUserId) return { user: null, deleted: false };

  let deletedFallbackId = "";
  if (explicitUserId && normalizedHandle) {
    const bindResult = bindHandleToUserId(explicitUserId, normalizedHandle);
    if (bindResult.deletedFallbackId) {
      deletedFallbackId = bindResult.deletedFallbackId;
    }
    resolvedUserId = explicitUserId;
  }

  const nextComment = typeof patch.comment === "string" ? patch.comment : "";
  if (!nextComment.trim()) {
    const deleted = await deleteUser(resolvedUserId, normalizedHandle);
    if (deletedFallbackId) await removePersistedUser(deletedFallbackId);
    return { user: null, deleted };
  }

  const base = memoCache.usersById[resolvedUserId] || normalizeUserRecord(resolvedUserId, normalizedHandle, {});
  const merged = normalizeUserRecord(
    resolvedUserId,
    normalizedHandle || base.handle,
    {
      ...base,
      ...patch,
      userId: resolvedUserId,
      handle: normalizedHandle || base.handle
    }
  );

  const previousHandle = normalizeHandle(base.handle);
  const nextHandle = normalizeHandle(merged.handle);
  if (previousHandle && previousHandle !== nextHandle && memoCache.handleToId[previousHandle] === resolvedUserId) {
    delete memoCache.handleToId[previousHandle];
  }

  memoCache.usersById[resolvedUserId] = merged;
  if (nextHandle) {
    memoCache.handleToId[nextHandle] = resolvedUserId;
  }

  if (deletedFallbackId && deletedFallbackId !== resolvedUserId) {
    await removePersistedUser(deletedFallbackId);
  }
  await persistUser(merged);

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

  await removePersistedUser(resolvedUserId);
  return true;
}

async function getStorageInfo() {
  const totalUsed = await chrome.storage.sync.getBytesInUse(null);

  const allData = await chrome.storage.sync.get(null);
  const xwKeys = Object.keys(allData || {}).filter(k => k.startsWith(STORAGE_PREFIX));
  const keyUsed = xwKeys.length > 0 ? await chrome.storage.sync.getBytesInUse(xwKeys) : 0;

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

  let changed = false;
  for (const [key, change] of Object.entries(changes)) {
    if (key.startsWith(STORAGE_PREFIX)) {
      changed = true;
      const userId = key.slice(STORAGE_PREFIX.length);

      if (!change.newValue) {
        // User deleted
        if (memoCache.usersById[userId]) {
          const handle = memoCache.usersById[userId].handle;
          if (handle && memoCache.handleToId[handle] === userId) {
            delete memoCache.handleToId[handle];
          }
          delete memoCache.usersById[userId];
        }
      } else {
        // User added/updated
        const rawHandle = change.newValue.h || change.newValue.handle;
        const rawComment = change.newValue.c || change.newValue.comment;
        const record = normalizeUserRecord(userId, rawHandle, { ...change.newValue, comment: rawComment });
        memoCache.usersById[userId] = record;
        if (record.handle) {
          memoCache.handleToId[record.handle] = userId;
        }
      }
    }
  }
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
        const keysToRemove = Object.keys(memoCache.usersById).map(id => `${STORAGE_PREFIX}${id}`);
        if (keysToRemove.length > 0) {
          await chrome.storage.sync.remove(keysToRemove);
        }
        memoCache = createEmptySnapshot();
        sendResponse({ ok: true });
        return;
      }
      case "XWATCH_IMPORT_USERS": {
        await ensureLoaded();
        const { users, mode } = message;

        if (mode === "replace") {
          const keysToRemove = Object.keys(memoCache.usersById).map(id => `${STORAGE_PREFIX}${id}`);
          if (keysToRemove.length > 0) {
            await chrome.storage.sync.remove(keysToRemove);
          }
          memoCache = createEmptySnapshot();
        }

        const usersArray = Array.isArray(users) ? users : Object.values(users || {});
        const updates = {};
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
              handle: normalizedHandle || base.handle
            }
          );

          memoCache.usersById[targetUserId] = merged;
          if (merged.handle) {
            memoCache.handleToId[merged.handle] = targetUserId;
          }

          const packed = { i: targetUserId };
          if (merged.handle) packed.h = merged.handle;
          if (merged.comment) packed.c = merged.comment;
          updates[`${STORAGE_PREFIX}${targetUserId}`] = packed;
        }

        if (Object.keys(updates).length > 0) {
          await chrome.storage.sync.set(updates);
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
