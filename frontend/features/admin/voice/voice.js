import { apiFetch } from "../../auth/auth-session.js";

const pageSize = 25;
const dateFormatter = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "medium", timeStyle: "short", timeZone: "America/Lima"
});
const dayFormatter = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "full", timeZone: "America/Lima"
});
const panels = new WeakMap();

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h1v-8H9Zm4 0v8h1v-8h-1Z"/></svg>'
};

function iconEl(name, className = "") {
  const span = document.createElement("span");
  span.className = `voice-icon ${className}`.trim();
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = ICONS[name] || "";
  return span;
}

function formatDuration(value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) return "0:00";
  const total = Math.floor(Number(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  return kilobytes >= 1024 ? `${(kilobytes / 1024).toFixed(1)} MB` : `${Math.round(kilobytes)} KB`;
}

function initials(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] || "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || "");
  return (first + second).toUpperCase();
}

function resultLabel(value) {
  const result = String(value || "").trim();
  if (!result || result === "contesto") return "Contestó";
  return result.replaceAll("_", " ").replace(/^./, char => char.toUpperCase());
}

function resultTone(value) {
  const result = String(value || "").toLowerCase();
  if (!result || result.includes("contesto")) return "success";
  if (result.includes("ocupado") || result.includes("busy")) return "warn";
  return "neutral";
}

function createPanel(panel) {
  const form = panel.querySelector("form");
  const body = panel.querySelector("tbody");
  const status = panel.querySelector(".voice-status");
  const page = panel.querySelector(".voice-page");
  const previous = panel.querySelector(".voice-prev");
  const next = panel.querySelector(".voice-next");
  const refresh = panel.querySelector(".voice-refresh");
  const player = panel.querySelector(".voice-player");
  const audio = player.querySelector("audio");
  const title = player.querySelector("h2");
  const detail = player.querySelector(".voice-playing-detail");
  const currentLabel = player.querySelector(".voice-player-current");
  const durationLabel = player.querySelector(".voice-player-duration");
  const seek = player.querySelector(".voice-player-seek");
  const toggle = player.querySelector(".voice-player-toggle");
  const backBtn = player.querySelector(".voice-player-back");
  const forwardBtn = player.querySelector(".voice-player-forward");
  const speedBtn = player.querySelector(".voice-player-speed");
  const downloadLink = player.querySelector(".voice-player-download");
  const mute = player.querySelector(".voice-player-mute");
  const close = player.querySelector(".voice-player-close");
  const toast = panel.querySelector(".voice-toast");
  const userSelect = form.elements.namedItem("userId");
  const confirmDialog = panel.querySelector(".voice-confirm-dialog");
  const confirmName = confirmDialog?.querySelector(".voice-confirm-name");
  const confirmMeta = confirmDialog?.querySelector(".voice-confirm-meta");
  const confirmCancel = confirmDialog?.querySelector(".voice-confirm-cancel");
  const confirmSubmit = confirmDialog?.querySelector(".voice-confirm-submit");
  const speeds = [1, 1.25, 1.5, 2];
  let speedIndex = 0;
  let toastTimer = null;
  let filters = new URLSearchParams();
  let offset = 0;
  let currentCount = 0;
  let request;
  let autoApplyTimer = null;
  let activeEntry = null;
  let activeButton = null;

  if (userSelect) {
    apiFetch("/api/users/lists", { cache: "no-store" })
      .then(response => response.json().then(data => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok || !data.ok || !Array.isArray(data.users)) return;
        const selected = userSelect.value;
        userSelect.replaceChildren(new Option("Todos los usuarios", ""));
        for (const user of data.users) userSelect.add(new Option(user.username, String(user.id)));
        userSelect.value = selected;
      })
      .catch(error => console.warn("No se pudo cargar el filtro de usuarios del Panel de voz:", error));
  }

  function showToast(message, isError = false) {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle("is-error", isError);
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  function recordingUrl(entry) {
    return `/api/session/${encodeURIComponent(entry.sessionCode)}/recordings/${encodeURIComponent(entry.attemptId)}`;
  }

  function paintActive(button, playing) {
    if (!button) return;
    button.dataset.playing = String(playing);
    button.setAttribute("aria-pressed", String(playing));
    const label = button.querySelector(".voice-play-label");
    if (label) label.textContent = playing ? "Pausar" : "Escuchar";
    button.closest("tr")?.classList.toggle("voice-row--playing", playing);
  }

  function clearActive() {
    if (activeButton) paintActive(activeButton, false);
    activeEntry = null;
    activeButton = null;
  }

  function renderTime() {
    const duration = audio.duration;
    const current = audio.currentTime || 0;
    currentLabel.textContent = formatDuration(current);
    if (Number.isFinite(duration) && duration > 0) {
      durationLabel.textContent = formatDuration(duration);
      const ratio = Math.min(1, Math.max(0, current / duration));
      seek.value = String(Math.round(ratio * 1000));
      seek.style.setProperty("--progress", `${(ratio * 100).toFixed(2)}%`);
    } else {
      seek.style.setProperty("--progress", "0%");
    }
  }

  function stopPlayer() {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    player.hidden = true;
    player.dataset.playing = "false";
    player.dataset.loading = "false";
    player.dataset.attemptId = "";
    currentLabel.textContent = "0:00";
    durationLabel.textContent = "0:00";
    seek.value = "0";
    seek.style.setProperty("--progress", "0%");
    seek.disabled = true;
    if (downloadLink) downloadLink.setAttribute("href", "#");
    clearActive();
  }

  function showPlaybackError() {
    detail.textContent = "No se pudo reproducir esta grabación. Vuelve a intentarlo.";
    player.dataset.playing = "false";
    player.dataset.loading = "false";
    if (activeButton) paintActive(activeButton, false);
  }

  function startPlayback() {
    audio.play().catch(error => {
      if (error?.name === "AbortError") return;
      showPlaybackError();
    });
  }

  function play(entry, button) {
    if (player.dataset.attemptId === entry.attemptId) {
      if (audio.paused) startPlayback();
      else audio.pause();
      return;
    }
    clearActive();
    activeEntry = entry;
    activeButton = button;
    paintActive(button, true);
    title.textContent = entry.contact || entry.phone || "Reproducción";
    detail.textContent = [entry.phone, entry.list, entry.worker, formatDuration(entry.durationSeconds)]
      .filter(Boolean).join(" · ");
    player.hidden = false;
    player.dataset.attemptId = entry.attemptId;
    player.dataset.playing = "true";
    player.dataset.loading = "true";
    currentLabel.textContent = "0:00";
    durationLabel.textContent = formatDuration(entry.durationSeconds);
    seek.value = "0";
    seek.style.setProperty("--progress", "0%");
    seek.disabled = true;
    const url = recordingUrl(entry);
    if (downloadLink) {
      downloadLink.href = url;
      downloadLink.download = `grabacion-${entry.phone || entry.attemptId}.m4a`;
    }
    audio.src = url;
    audio.playbackRate = speeds[speedIndex];
    audio.load();
    startPlayback();
  }

  function confirmDelete(entry) {
    const label = entry.contact || entry.phone || "Contacto sin nombre";
    if (!confirmDialog || typeof confirmDialog.showModal !== "function") {
      return Promise.resolve(window.confirm(`¿Eliminar la grabación de ${label}? Esta acción no se puede deshacer.`));
    }
    confirmName.textContent = label;
    confirmMeta.textContent = [entry.phone, formatDuration(entry.durationSeconds), entry.list]
      .filter(Boolean).join(" · ");
    confirmSubmit.disabled = false;
    confirmSubmit.textContent = "Eliminar grabación";
    return new Promise(resolve => {
      const cleanup = result => {
        confirmCancel.removeEventListener("click", onCancel);
        confirmSubmit.removeEventListener("click", onConfirm);
        confirmDialog.removeEventListener("cancel", onCancel);
        confirmDialog.removeEventListener("click", onBackdrop);
        if (confirmDialog.open) confirmDialog.close();
        resolve(result);
      };
      const onCancel = () => cleanup(false);
      const onConfirm = () => cleanup(true);
      const onBackdrop = event => {
        if (event.target === confirmDialog) cleanup(false);
      };
      confirmCancel.addEventListener("click", onCancel);
      confirmSubmit.addEventListener("click", onConfirm);
      confirmDialog.addEventListener("cancel", onCancel);
      confirmDialog.addEventListener("click", onBackdrop);
      confirmDialog.showModal();
      confirmCancel.focus();
    });
  }

  async function remove(entry, button) {
    const confirmed = await confirmDelete(entry);
    if (!confirmed) return;
    button.disabled = true;
    const row = button.closest("tr");
    try {
      const response = await apiFetch(
        `/api/admin/recordings/${encodeURIComponent(entry.sessionCode)}/${encodeURIComponent(entry.attemptId)}`,
        { method: "DELETE" }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo eliminar la grabación.");
      if (player.dataset.attemptId === entry.attemptId) stopPlayer();
      showToast("Grabación eliminada correctamente.");
      if (row) {
        row.classList.add("voice-row--removing");
        await new Promise(r => setTimeout(r, 200));
        row.remove();
        currentCount = Math.max(0, currentCount - 1);
        if (currentCount === 0) {
          await load(Math.max(0, offset > 0 ? offset - pageSize : 0));
        } else {
          status.textContent = `Mostrando ${offset + 1}–${offset + currentCount}`;
        }
      } else {
        await load(offset);
      }
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
    }
  }

  function cell(row, className, label) {
    const td = row.insertCell();
    td.className = className;
    td.dataset.label = label;
    return td;
  }

  function small(text) {
    const element = document.createElement("small");
    element.textContent = text;
    return element;
  }

  function stack(...children) {
    const element = document.createElement("div");
    element.className = "voice-cell-stack";
    element.append(...children);
    return element;
  }

  function buildRow(entry) {
    const row = body.insertRow();

    const contactCell = cell(row, "voice-cell-contact", "Contacto");
    const contact = document.createElement("div");
    contact.className = "voice-contact";
    const avatar = document.createElement("span");
    avatar.className = "voice-avatar";
    avatar.textContent = initials(entry.contact || entry.phone);
    const copy = document.createElement("div");
    copy.className = "voice-contact-copy";
    const name = document.createElement("strong");
    name.textContent = entry.contact || "Contacto sin nombre";
    copy.append(name, small(entry.phone || "Sin teléfono"));
    contact.append(avatar, copy);
    contactCell.append(contact);

    const started = new Date(entry.connectedAt || entry.startedAt || "");
    const dateCell = cell(row, "voice-cell-date", "Fecha en Lima");
    dateCell.append(stack(
      Number.isNaN(started.getTime()) ? "—" : dateFormatter.format(started),
      small(`Sesión ${entry.sessionCode}`)
    ));

    const sourceCell = cell(row, "voice-cell-source", "Lista y equipo");
    sourceCell.append(stack(entry.list || "Sin lista", small(entry.worker || "Sin equipo")));

    const durationCell = cell(row, "voice-cell-duration", "Duración");
    const duration = document.createElement("span");
    duration.className = "voice-duration";
    const durationValue = document.createElement("strong");
    durationValue.textContent = formatDuration(entry.durationSeconds);
    const size = document.createElement("span");
    size.textContent = formatBytes(entry.sizeBytes);
    duration.append(durationValue, size);
    durationCell.append(duration);

    const resultCell = cell(row, "voice-cell-result", "Resultado");
    const badge = document.createElement("span");
    badge.className = `voice-badge is-${resultTone(entry.result)}`;
    badge.textContent = resultLabel(entry.result);
    resultCell.append(badge);

    const actionsCell = cell(row, "voice-cell-actions", "Audio");
    const actions = document.createElement("div");
    actions.className = "voice-actions";
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "voice-action voice-play";
    playButton.dataset.playing = "false";
    playButton.setAttribute("aria-pressed", "false");
    playButton.setAttribute("aria-label", `Escuchar grabación de ${entry.contact || entry.phone || "este contacto"}`);
    const playLabel = document.createElement("span");
    playLabel.className = "voice-play-label";
    playLabel.textContent = "Escuchar";
    playButton.append(iconEl("play", "voice-icon-play"), iconEl("pause", "voice-icon-pause"), playLabel);
    playButton.addEventListener("click", () => play(entry, playButton));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "voice-action voice-delete";
    deleteButton.title = "Eliminar grabación";
    deleteButton.setAttribute("aria-label", `Eliminar grabación de ${entry.contact || entry.phone || "este contacto"}`);
    deleteButton.append(iconEl("trash"));
    deleteButton.addEventListener("click", () => remove(entry, deleteButton));

    actions.append(playButton, deleteButton);
    actionsCell.append(actions);
  }

  async function load(targetOffset = offset) {
    request?.abort();
    const current = new AbortController();
    request = current;
    panel.classList.add("voice-loading");
    previous.disabled = next.disabled = true;
    if (refresh) refresh.disabled = true;
    status.classList.remove("voice-status--date");
    status.textContent = "Cargando grabaciones…";
    body.replaceChildren();
    stopPlayer();
    try {
      const params = new URLSearchParams(filters);
      params.set("offset", String(targetOffset));
      const response = await apiFetch(`/api/admin/recordings?${params}`, { signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar las grabaciones.");
      offset = targetOffset;
      currentCount = data.rows.length;
      for (const entry of data.rows) buildRow(entry);
      if (!data.rows.length) {
        const row = body.insertRow();
        const empty = row.insertCell();
        empty.colSpan = 6;
        empty.className = "voice-empty";
        empty.textContent = "No se encontraron grabaciones con estos filtros.";
      }
      const from = form.elements.namedItem("from")?.value;
      const to = form.elements.namedItem("to")?.value;
      const labelDay = value => value
        ? dayFormatter.format(new Date(`${value}T12:00:00`))
        : "";
      const firstRecordingDate = data.rows[0]
        ? new Date(data.rows[0].connectedAt || data.rows[0].startedAt)
        : null;
      const selectedDate = from && to
        ? `${labelDay(from)} — ${labelDay(to)}`
        : from || to ? labelDay(from || to)
          : firstRecordingDate && !Number.isNaN(firstRecordingDate.getTime())
            ? dayFormatter.format(firstRecordingDate)
            : "Sin resultados";
      status.textContent = selectedDate;
      status.classList.toggle("voice-status--date", Boolean(data.rows.length));
      page.textContent = `Página ${Math.floor(offset / pageSize) + 1}`;
      previous.disabled = offset === 0;
      next.disabled = !data.hasMore;
    } catch (error) {
      if (!current.signal.aborted) {
        status.classList.remove("voice-status--date");
        status.textContent = error.message;
      }
      previous.disabled = offset === 0;
      next.disabled = true;
    } finally {
      if (request === current) {
        panel.classList.remove("voice-loading");
        if (refresh) refresh.disabled = false;
      }
    }
  }

  seek.addEventListener("input", () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
      renderTime();
    }
  });
  toggle.addEventListener("click", () => {
    if (!player.dataset.attemptId) return;
    if (audio.paused) startPlayback();
    else audio.pause();
  });
  backBtn?.addEventListener("click", () => {
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, (audio.currentTime || 0) - 10);
    renderTime();
  });
  forwardBtn?.addEventListener("click", () => {
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.min(audio.duration, (audio.currentTime || 0) + 10);
    renderTime();
  });
  speedBtn?.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % speeds.length;
    const rate = speeds[speedIndex];
    audio.playbackRate = rate;
    speedBtn.textContent = `${rate}×`;
  });
  mute.addEventListener("click", () => {
    audio.muted = !audio.muted;
  });
  close.addEventListener("click", stopPlayer);

  audio.addEventListener("waiting", () => {
    player.dataset.loading = "true";
  });
  audio.addEventListener("canplay", () => {
    player.dataset.loading = "false";
  });
  audio.addEventListener("playing", () => {
    player.dataset.loading = "false";
  });
  audio.addEventListener("play", () => {
    player.dataset.playing = "true";
    toggle.setAttribute("aria-pressed", "true");
    toggle.setAttribute("aria-label", "Pausar");
    if (activeButton) paintActive(activeButton, true);
  });
  audio.addEventListener("pause", () => {
    player.dataset.playing = "false";
    toggle.setAttribute("aria-pressed", "false");
    toggle.setAttribute("aria-label", "Reproducir");
    if (activeButton) paintActive(activeButton, false);
  });
  audio.addEventListener("loadedmetadata", () => {
    durationLabel.textContent = formatDuration(audio.duration);
    seek.disabled = !Number.isFinite(audio.duration) || audio.duration <= 0;
    renderTime();
  });
  audio.addEventListener("timeupdate", renderTime);
  audio.addEventListener("ended", () => {
    audio.currentTime = 0;
    renderTime();
  });
  audio.addEventListener("volumechange", () => {
    player.dataset.muted = String(audio.muted);
    mute.setAttribute("aria-pressed", String(audio.muted));
    mute.setAttribute("aria-label", audio.muted ? "Activar audio" : "Silenciar audio");
  });
  audio.addEventListener("error", () => {
    if (!player.hidden) showPlaybackError();
  });

  const applyCurrentFilters = () => {
    filters = new URLSearchParams(new FormData(form));
    void load(0);
  };
  form.addEventListener("submit", event => {
    event.preventDefault();
    clearTimeout(autoApplyTimer);
    applyCurrentFilters();
  });
  form.addEventListener("change", event => {
    if (event.target.matches("select, input[type=date]")) {
      clearTimeout(autoApplyTimer);
      applyCurrentFilters();
    }
  });
  form.addEventListener("input", event => {
    if (!event.target.matches("input:not([type=date])")) return;
    clearTimeout(autoApplyTimer);
    autoApplyTimer = setTimeout(applyCurrentFilters, 350);
  });
  form.addEventListener("reset", () => {
    clearTimeout(autoApplyTimer);
    setTimeout(applyCurrentFilters, 0);
  });
  previous.addEventListener("click", () => void load(Math.max(0, offset - pageSize)));
  next.addEventListener("click", () => void load(offset + pageSize));
  refresh?.addEventListener("click", () => void load(offset));
  return load;
}

export function openVoicePanel(panel) {
  if (!panels.has(panel)) panels.set(panel, createPanel(panel));
  return panels.get(panel)();
}
