import { apiFetch } from "../../auth/auth-session.js";

const pageSize = 25;
const dateFormatter = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "medium", timeStyle: "short", timeZone: "America/Lima"
});
const panels = new WeakMap();

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function createPanel(panel) {
  const form = panel.querySelector("form");
  const body = panel.querySelector("tbody");
  const status = panel.querySelector(".voice-status");
  const page = panel.querySelector(".voice-page");
  const previous = panel.querySelector(".voice-prev");
  const next = panel.querySelector(".voice-next");
  const player = panel.querySelector(".voice-player");
  const audio = player.querySelector("audio");
  const title = player.querySelector("h2");
  const detail = player.querySelector(".voice-playing-detail");
  let filters = new URLSearchParams();
  let offset = 0;
  let request;

  function play(row, button) {
    body.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-pressed", "true");
    title.textContent = row.contact || row.phone || "Reproducción";
    detail.textContent = [row.phone, row.list, row.worker, formatDuration(row.durationSeconds)].filter(Boolean).join(" · ");
    player.hidden = false;
    audio.src = `/api/session/${encodeURIComponent(row.sessionCode)}/recordings/${encodeURIComponent(row.attemptId)}`;
    audio.play().catch(() => {});
  }

  function cell(row, primary, secondary = "") {
    const td = row.insertCell();
    td.textContent = primary || "—";
    if (secondary) {
      const info = document.createElement("small");
      info.textContent = secondary;
      td.append(info);
    }
    return td;
  }

  async function load(targetOffset = offset) {
    request?.abort();
    const current = new AbortController();
    request = current;
    panel.classList.add("voice-loading");
    previous.disabled = next.disabled = true;
    status.textContent = "Cargando grabaciones…";
    body.replaceChildren();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    player.hidden = true;
    try {
      const params = new URLSearchParams(filters);
      params.set("offset", String(targetOffset));
      const response = await apiFetch(`/api/admin/recordings?${params}`, { signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar las grabaciones.");
      offset = targetOffset;
      for (const entry of data.rows) {
        const row = body.insertRow();
        const started = new Date(entry.connectedAt || entry.startedAt || "");
        cell(row, entry.contact || "Contacto sin nombre", entry.phone);
        cell(row, Number.isNaN(started.getTime()) ? "" : dateFormatter.format(started), `Sesión ${entry.sessionCode}`);
        cell(row, entry.list || "Sin lista", entry.worker || "Sin equipo");
        cell(row, formatDuration(entry.durationSeconds), `${Math.ceil(entry.sizeBytes / 1024)} KB`);
        cell(row, entry.result && entry.result !== "contesto" ? entry.result.replaceAll("_", " ") : "Contestó");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "voice-secondary voice-play";
        button.textContent = "▶ Escuchar";
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-label", `Escuchar grabación de ${entry.contact || entry.phone || "este contacto"}`);
        button.addEventListener("click", () => play(entry, button));
        row.insertCell().append(button);
      }
      status.textContent = data.rows.length
        ? `Mostrando ${offset + 1}–${offset + data.rows.length}`
        : "No se encontraron grabaciones con estos filtros.";
      page.textContent = `Página ${Math.floor(offset / pageSize) + 1}`;
      previous.disabled = offset === 0;
      next.disabled = !data.hasMore;
    } catch (error) {
      if (!current.signal.aborted) status.textContent = error.message;
    } finally {
      if (request === current) panel.classList.remove("voice-loading");
    }
  }

  audio.addEventListener("error", () => {
    if (!player.hidden && audio.hasAttribute("src")) detail.textContent = "No se pudo reproducir esta grabación.";
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    filters = new URLSearchParams(new FormData(form));
    void load(0);
  });
  form.addEventListener("reset", () => {
    filters = new URLSearchParams();
    void load(0);
  });
  previous.addEventListener("click", () => void load(Math.max(0, offset - pageSize)));
  next.addEventListener("click", () => void load(offset + pageSize));
  return load;
}

export function openVoicePanel(panel) {
  if (!panels.has(panel)) panels.set(panel, createPanel(panel));
  return panels.get(panel)();
}
