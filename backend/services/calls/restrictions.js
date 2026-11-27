import { annualPhoneBlocks, phoneKey } from "../campaigns/contact-book.js";
import { collectCallAttempts } from "./call-history.js";

/**
 * createRestrictions: conserva los contratos y reglas existentes.
 * Dependencias: runtime.persistence, runtime.sessions.
 * Se construye una vez por proceso.
 */
export function createRestrictions(runtime, services) {
  const durableExclusions = new Map();
  async function loadDialExclusions() {
    const [rows] = await runtime.persistence.pool.query("SELECT phone,called,manual_block,invalid_number FROM vc_dial_exclusions");
    durableExclusions.clear();
    for (const row of rows) durableExclusions.set(phoneKey(row.phone), row);
    return rows.length;
  }
  let cachedPersistedRevision = -1;
  let cachedPersistedRows = [];
  let cachedAllCallAttemptsKey = "";
  let cachedAllCallAttempts = [];
  let cachedPersistedBlocksRevision = -1;
  let cachedPersistedBlocks = new Map();
  let nextPersistedExpiryAt = 0;

  function persistedRows() {
    const revision = runtime.persistence.attemptsRevision || 0;
    if (revision !== cachedPersistedRevision) {
      cachedPersistedRows = [...runtime.persistence.records.values()].map(entry => entry.row);
      cachedPersistedRevision = revision;
    }
    return cachedPersistedRows;
  }

  function allCallAttempts() {
    const startedAt = Date.now();
    // Use cached attempts if available
    const sessionRevision = [...runtime.sessions].map(([code, session]) =>
      `${code}:${session.updatedAt || 0}:${session.campaign?.updatedAt || 0}`
    ).join("|");
    const cacheKey = `${runtime.persistence.attemptsRevision || 0}-${sessionRevision}`;
    if (cacheKey === cachedAllCallAttemptsKey) {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= 100) console.info(`[CALL_ATTEMPTS] cache=hit sessions=${runtime.sessions.size} rows=${cachedAllCallAttempts.length} elapsedMs=${elapsedMs}`);
      return cachedAllCallAttempts;
    }

    const rows = [...persistedRows()];
    for (const session of runtime.sessions.values()) rows.push(...collectCallAttempts(session));

    cachedAllCallAttemptsKey = cacheKey;
    cachedAllCallAttempts = rows;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 100) console.info(`[CALL_ATTEMPTS] cache=miss sessions=${runtime.sessions.size} rows=${rows.length} elapsedMs=${elapsedMs}`);
    return rows;
  }

  function clearAllCallAttemptsCache() {
    cachedPersistedRevision = -1;
    cachedPersistedRows = [];
    cachedAllCallAttemptsKey = "";
    cachedAllCallAttempts = [];
    cachedPersistedBlocksRevision = -1;
    cachedPersistedBlocks = new Map();
    nextPersistedExpiryAt = 0;
  }

  function persistedAnnualBlocks(now) {
    const revision = runtime.persistence.attemptsRevision || 0;
    if (revision !== cachedPersistedBlocksRevision || now >= nextPersistedExpiryAt) {
      cachedPersistedBlocks = annualPhoneBlocks(persistedRows(), new Date(now));
      cachedPersistedBlocksRevision = revision;
      nextPersistedExpiryAt = Infinity;
      for (const block of cachedPersistedBlocks.values()) {
        if (block.permanent) continue;
        const expiry = Date.parse(block.nextAllowedAt);
        if (Number.isFinite(expiry) && expiry < nextPersistedExpiryAt) nextPersistedExpiryAt = expiry;
      }
    }
    return cachedPersistedBlocks;
  }

  let cachedAllAnnualKey = "";
  let cachedAllAnnualAt = 0;
  let cachedAllAnnualBlocks = new Map();

  function allAnnualBlocks() {
    const now = Date.now();
    const sessionRevision = [...runtime.sessions].map(([code, session]) =>
      `${code}:${session.campaign?.updatedAt || 0}:${session.reportArchive?.length || 0}`
    ).join("|");
    const cacheKey = `${runtime.persistence.attemptsRevision || 0}-${sessionRevision}-${durableExclusions.size}`;
    if (cacheKey === cachedAllAnnualKey && now - cachedAllAnnualAt < 60000) {
      return new Map(cachedAllAnnualBlocks);
    }

    const blocks = new Map(persistedAnnualBlocks(now));
    const liveAttempts = [];
    for (const session of runtime.sessions.values()) liveAttempts.push(...collectCallAttempts(session));
    if (liveAttempts.length) {
      for (const [phone, block] of annualPhoneBlocks(liveAttempts, new Date(now))) {
        const existing = blocks.get(phone);
        if (existing?.permanent) continue;
        if (block.permanent || !existing || Date.parse(block.lastCalledAt) > Date.parse(existing.lastCalledAt)) {
          blocks.set(phone, block);
        }
      }
    }
    for (const [phone, exclusion] of durableExclusions) {
      if (exclusion.called || exclusion.invalid_number) blocks.set(phone, {
        permanent: true, lastCalledAt: null, nextAllowedAt: null,
        reason: exclusion.invalid_number ? "NO VOLVER A LLAMAR: número inexistente o incorrecto" : "NO VOLVER A LLAMAR: número ya llamado"
      });
    }
    cachedAllAnnualKey = cacheKey;
    cachedAllAnnualAt = now;
    cachedAllAnnualBlocks = blocks;
    return new Map(blocks);
  }

  function globalBlockedNumbers() {
  const blocked = new Map();
  for (const session of runtime.sessions.values()) {
    for (const entry of session.blockedNumbers || []) {
      const key = phoneKey(entry.phone || entry.number);
      if (key && !blocked.has(key)) blocked.set(key, { name: entry.name || entry.phone || key, phone: entry.phone || entry.number || key });
    }
  }
  for (const [phone, exclusion] of durableExclusions) {
    if (exclusion.manual_block && !blocked.has(phone)) blocked.set(phone, { name: phone, phone });
  }
  return [...blocked.values()];
}

function isGloballyBlocked(phone) {
  const key = phoneKey(phone);
  return Boolean(key && globalBlockedNumbers().some(entry => phoneKey(entry.phone) === key));
}

function synchronizeGlobalBlockedNumbers() {
  const blocked = globalBlockedNumbers();
  for (const session of runtime.sessions.values()) session.blockedNumbers = structuredClone(blocked);
  return blocked;
}

let refreshRestrictionsTimer = null;
const pendingRestrictionSources = new Set();
function refreshGlobalCallRestrictions(sourceCode = "") {
  if (sourceCode) pendingRestrictionSources.add(sourceCode);
  if (refreshRestrictionsTimer) return;
  refreshRestrictionsTimer = setTimeout(() => {
    refreshRestrictionsTimer = null;
    const onlyExcluded = pendingRestrictionSources.size === 1 ? [...pendingRestrictionSources][0] : "";
    pendingRestrictionSources.clear();
    for (const code of runtime.sessions.keys()) {
      if (code !== onlyExcluded) services.emitState(code);
    }
  }, 1000);
  refreshRestrictionsTimer.unref?.();
}

let blockedNumbersQueue = Promise.resolve();
function changeGlobalBlockedNumber(action, entry) {
  const operation = blockedNumbersQueue.catch(() => {}).then(async () => {
    const previous = globalBlockedNumbers();
    const key = phoneKey(entry.phone);
    const next = action === "add"
      ? [...previous.filter(item => phoneKey(item.phone) !== key), { name: entry.name || entry.phone, phone: entry.phone }]
      : previous.filter(item => phoneKey(item.phone) !== key);
    if (next.length > 5000) throw new Error("La lista alcanzó el límite de 5000 números.");
    for (const session of runtime.sessions.values()) session.blockedNumbers = structuredClone(next);
    try {
      await runtime.persistence.save(runtime.sessions);
      await runtime.persistence.pool.query(
        `INSERT INTO vc_dial_exclusions(phone,manual_block) VALUES (?,?)
         ON DUPLICATE KEY UPDATE manual_block=VALUES(manual_block)`, [key, action === "add"]);
      durableExclusions.set(key, { ...(durableExclusions.get(key) || {}), phone: key, manual_block: action === "add" });
    } catch (error) {
      for (const session of runtime.sessions.values()) session.blockedNumbers = structuredClone(previous);
      throw error;
    }
    return next;
  });
  blockedNumbersQueue = operation.catch(() => {});
  return operation;
}

function annualBlock(phone) {
  return allAnnualBlocks().get(phoneKey(phone));
}

const sessionRestrictionsCache = new WeakMap();

function callRestrictions(session) {
  const blockedList = globalBlockedNumbers();
  const cacheKey = `${runtime.persistence.attemptsRevision || 0}:${session.contactBook?.revision || session.contactBook?.contacts?.length || 0}:${session.campaign?.contacts?.length || 0}:${session.campaign?.startedAt || ""}:${blockedList.length}:${durableExclusions.size}`;
  const cached = sessionRestrictionsCache.get(session);
  if (cached && cached.key === cacheKey) return cached.value;

  const blocks = allAnnualBlocks();
  const manualBlocks = new Map(blockedList.map(entry => [phoneKey(entry.phone), entry]));
  const value = {};
  const applyContact = (contact) => {
    const phone = phoneKey(contact.phone);
    if (!phone || value[phone]) return;
    const annual = blocks.get(phone);
    const manual = manualBlocks.get(phone);
    if (annual || manual) {
      value[phone] = {
        ...(annual || {}),
        ...(manual ? { manualBlocked: true, blockName: manual.name, reason: "Número en la lista global de bloqueos." } : {})
      };
    }
  };
  for (const contact of session.contactBook?.contacts || []) applyContact(contact);
  for (const contact of session.campaign?.contacts || []) applyContact(contact);
  sessionRestrictionsCache.set(session, { key: cacheKey, value });
  return value;
}

function blockedCallMessage(block) {
  if (block.permanent) return "NO VOLVER A LLAMAR: número inexistente o incorrecto.";
  return "Número llamado anteriormente. Disponible desde " +
    new Date(block.nextAllowedAt).toLocaleDateString("es-PE",{timeZone:"America/Lima"}) + ".";
}
return { allCallAttempts, annualBlock, annualBlocks: allAnnualBlocks, callRestrictions, blockedCallMessage,
  loadDialExclusions,
  globalBlockedNumbers, isGloballyBlocked, synchronizeGlobalBlockedNumbers, changeGlobalBlockedNumber,
  refreshGlobalCallRestrictions };
}
