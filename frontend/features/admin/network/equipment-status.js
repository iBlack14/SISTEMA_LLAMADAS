const states = {
  "En llamada": { label: "Llamando", caption: "En conversaci\u00f3n", connection: "connected", connectionLabel: "Conectado" },
  Marcando: { label: "Timbrando", caption: "Esperando respuesta", connection: "connected", connectionLabel: "Conectado" },
  Disponible: { label: "Conectado S/LL", caption: "Sin llamar", connection: "connected", connectionLabel: "Conectado" },
  Desconectado: { label: "Desconectado", caption: "Sin conexi\u00f3n", connection: "disconnected", connectionLabel: "Desconectado" }
};

export function displayState(item, live) {
  if (!item?.deviceId || item.state === "Sin vincular") return "Sin equipo";
  return live && states[item.state] ? item.state : "Sin se\u00f1al de estado";
}

export function equipmentStatus(item, live, serverNow) {
  const key = displayState(item, live);
  const state = states[key];
  if (!state) return { label: key, caption: key === "Sin equipo" ? "Sin dispositivo" : "Estado pendiente", connection: "unknown", connectionLabel: key === "Sin equipo" ? "Sin vincular" : "Sin confirmar", seconds: null };
  const since = Date.parse(item.stateSince);
  const seconds = Number.isFinite(since) && Number.isFinite(serverNow) && since <= serverNow
    ? Math.floor((serverNow - since) / 1000) : null;
  return { ...state, seconds };
}
