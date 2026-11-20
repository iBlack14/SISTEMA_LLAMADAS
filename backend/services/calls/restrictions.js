import { annualPhoneBlocks, phoneKey } from "../campaigns/contact-book.js";
import { collectCallAttempts } from "./call-history.js";

/**
 * createRestrictions: conserva los contratos y reglas existentes.
 * Dependencias: runtime.persistence, runtime.sessions.
 * Se construye una vez por proceso.
 */
export function createRestrictions(runtime, services) {
  let cachedAllCallAttemptsKey = "";
  let cachedAllCallAttempts = [];
  let blockedAttemptsSnapshot = null;
  let blockedNumbersByPhone = new Map();
  let nextBlockExpiryAt = 0;
  
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
    
    const rows = [...runtime.persistence.records.values()].map(entry => entry.row);
    for (const session of runtime.sessions.values()) rows.push(...collectCallAttempts(session));
    
    cachedAllCallAttemptsKey = cacheKey;
    cachedAllCallAttempts = rows;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 100) console.info(`[CALL_ATTEMPTS] cache=miss sessions=${runtime.sessions.size} rows=${rows.length} elapsedMs=${elapsedMs}`);
    return rows;
  }
  
  function clearAllCallAttemptsCache() {
    cachedAllCallAttemptsKey = "";
    cachedAllCallAttempts = [];
    blockedAttemptsSnapshot = null;
    blockedNumbersByPhone = new Map();
    nextBlockExpiryAt = 0;
  }

  function allAnnualBlocks() {
    const attempts = allCallAttempts();
    const now = Date.now();
    if (attempts !== blockedAttemptsSnapshot || now >= nextBlockExpiryAt) {
      blockedNumbersByPhone = annualPhoneBlocks(attempts, new Date(now));
      blockedAttemptsSnapshot = attempts;
      nextBlockExpiryAt = Infinity;
      for (const block of blockedNumbersByPhone.values()) {
        if (block.permanent) continue;
        const expiry = Date.parse(block.nextAllowedAt);
        if (Number.isFinite(expiry) && expiry < nextBlockExpiryAt) nextBlockExpiryAt = expiry;
      }
    }
    return blockedNumbersByPhone;
  }

  function globalBlockedNumbers() {
  const blocked = new Map();
  for (const session of runtime.sessions.values()) {
    for (const entry of session.blockedNumbers || []) {
      const key = phoneKey(entry.phone || entry.number);
      if (key && !blocked.has(key)) blocked.set(key, { name: entry.name || entry.phone || key, phone: entry.phone || entry.number || key });
    }
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

function refreshGlobalCallRestrictions(sourceCode = "") {
  for (const code of runtime.sessions.keys()) {
    if (code !== sourceCode) services.emitState(code);
  }
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

function callRestrictions(session) {
  const blocks = allAnnualBlocks();
  const manualBlocks = new Map(globalBlockedNumbers().map(entry => [phoneKey(entry.phone), entry]));
  const contacts = [...(session.contactBook?.contacts || []),...(session.campaign?.contacts || [])];
  return Object.fromEntries(contacts.flatMap(contact => {
    const phone = phoneKey(contact.phone);
    const annual = blocks.get(phone);
    const manual = manualBlocks.get(phone);
    return annual || manual ? [[phone, {
      ...(annual || {}),
      ...(manual ? { manualBlocked: true, blockName: manual.name, reason: "Número en la lista global de bloqueos." } : {})
    }]] : [];
  }));
}

function blockedCallMessage(block) {
  if (block.permanent) return "NO VOLVER A LLAMAR: número inexistente o incorrecto.";
  return "Número llamado anteriormente. Disponible desde " +
    new Date(block.nextAllowedAt).toLocaleDateString("es-PE",{timeZone:"America/Lima"}) + ".";
}
return { allCallAttempts, annualBlock, annualBlocks: allAnnualBlocks, callRestrictions, blockedCallMessage,
  globalBlockedNumbers, isGloballyBlocked, synchronizeGlobalBlockedNumbers, changeGlobalBlockedNumber,
  refreshGlobalCallRestrictions };
}
