const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const LOGGER_STATE = Symbol.for("viax.consoleLogger");

function normalizeLevel(value) {
  const level = String(value || "info").trim().toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : "info";
}

function timestamp(timeZone) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).format(new Date());
  } catch {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }
}

function formatArgument(value) {
  if (typeof value === "string") return value.replace(/\r?\n/g, "\n    ");
  if (value instanceof Error) {
    const stack = value.stack && value.stack !== `${value.name}: ${value.message}`
      ? `\n    ${value.stack.split("\n").slice(1).join("\n    ")}`
      : "";
    return `${value.name}: ${value.message}${value.code ? ` (code=${value.code})` : ""}${stack}`;
  }
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value !== "object" || value === null) return String(value);

  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (item instanceof Error) return { name: item.name, message: item.message, code: item.code };
      if (item instanceof Map) return Object.fromEntries(item);
      if (item instanceof Set) return [...item];
      if (typeof item === "bigint") return `${item}n`;
      return item;
    });
    return json === undefined ? String(value) : json;
  } catch {
    return "[objeto no serializable]";
  }
}

function formatMessage(args) {
  const message = args.map(formatArgument).join(" ").trim();
  return /^\[[A-Z0-9_-]+\]/i.test(message) ? message : `[APP] ${message}`;
}

function isRoutineCallLog(args) {
  const first = String(args[0] || "");
  return first.startsWith("[CALL_DISPATCH]") ||
    first.startsWith("[PHONE_STATUS] duplicate-ignored") ||
    first.startsWith("[PHONE_STATUS] persisting-session-snapshot") ||
    first.startsWith("[CALL_ATTEMPTS] cache=hit");
}

/** Give Docker/EasyPanel logs a consistent timestamp, severity and one-line context. */
export function configureConsoleLogging(options = {}) {
  const state = globalThis.console[LOGGER_STATE] || {
    level: "info",
    timeZone: "America/Lima",
    originals: {}
  };
  state.level = normalizeLevel(options.level ?? process.env.LOG_LEVEL ?? state.level);
  state.timeZone = String(options.timeZone ?? process.env.LOG_TIMEZONE ?? state.timeZone);

  if (!globalThis.console[LOGGER_STATE]) {
    state.originals = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };
    for (const method of Object.keys(state.originals)) {
      console[method] = (...args) => {
        const level = method === "log" ? "info" : method;
        const displayLevel = (level === "info" && isRoutineCallLog(args)) ? "debug" : level;
        if (LEVELS[displayLevel] < LEVELS[state.level]) return;
        const line = `${timestamp(state.timeZone)} | ${displayLevel.toUpperCase().padEnd(5)} | ${formatMessage(args)}`;
        state.originals[method](line);
      };
    }
    Object.defineProperty(globalThis.console, LOGGER_STATE, { value: state, configurable: false });
  }
}
