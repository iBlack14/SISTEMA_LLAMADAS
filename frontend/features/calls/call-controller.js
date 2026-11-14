import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import * as Contacts from '../contacts/contacts-repository.js';
import * as AudioBridge from './audio/audio-bridge.js';

/**
 * createCallController: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.addHistoryEntry, dashboardActions.formatCallDuration, dashboardActions.renderContacts, dashboardActions.syncAudioButtons, dashboardState.callCtx, dashboardState.callStartedAt, dashboardState.callTimerId, dashboardState.currentCallingContactId, dashboardState.currentState, dashboardState.lastCallDuration, dashboardState.micEnabled, dashboardState.pendingCommandTimeouts, dashboardState.speakerEnabled.
 * Se construye una vez por dashboard.
 */
export function createCallController(dashboardState, dashboardActions) {
function startDialForContact(c) {
  if (["dialing", "ringing", "in_call"].includes(dashboardState.currentState)) return;
  dashboardState.currentCallingContactId = c.id;
  Contacts.calledCounts[c.id] = (Contacts.calledCounts[c.id] || 0) + 1;
  Contacts.saveCalledCounts();
  dashboardActions.renderContacts();
  openCallWindow(c.phone, { contactName: c.name, note: c.note });
  emitCallActionWithAck("dial", { phoneNumber: c.phone, contactName: c.name, contactId: c.id });
}

function openCallWindow(phone, opts = {}) {
  dashboardState.callCtx = {
    phone: phone || "",
    contactName: opts.contactName || "Sin contacto",
    note: opts.note || "",
    answered: false
  };
  if (dashboardState.callTimerId) {
    clearInterval(dashboardState.callTimerId);
    dashboardState.callTimerId = null;
  }
  dashboardState.callStartedAt = null;
  if (refs.callKickerEl) refs.callKickerEl.textContent = "Enviando orden...";
  if (refs.callNameEl) refs.callNameEl.textContent = dashboardState.callCtx.contactName || "Sin contacto";
  if (refs.callNumberEl) refs.callNumberEl.textContent = dashboardState.callCtx.phone || "-";
  if (refs.callNoteEl) refs.callNoteEl.textContent = dashboardState.callCtx.note || "-";
  if (refs.callDurEl) refs.callDurEl.textContent = "00:00";
  refs.callModalEl.style.display = "grid";
  setBadge("idle", refs.callBadgeEl);
  if (refs.callHintEl) {
    refs.callHintEl.textContent = "Enviando orden al celular...";
  }
}

function stopCallTimer(clearStart = true) {
  if (dashboardState.callTimerId) {
    clearInterval(dashboardState.callTimerId);
    dashboardState.callTimerId = null;
  }
  if (clearStart) dashboardState.callStartedAt = null;
}

function startCallTimer() {
  stopCallTimer();
  if (!dashboardState.callStartedAt) dashboardState.callStartedAt = Date.now();
  if (refs.callDurEl) {
    refs.callDurEl.textContent = dashboardActions.formatCallDuration(Math.floor((Date.now() - dashboardState.callStartedAt) / 1000));
  }
    dashboardState.callTimerId = setInterval(() => {
        if (!dashboardState.callStartedAt || !refs.callDurEl) return;
        const dur = Math.floor((Date.now() - dashboardState.callStartedAt) / 1000);
        refs.callDurEl.textContent = dashboardActions.formatCallDuration(dur);
        dashboardState.lastCallDuration = dur; // Store the last duration
    }, 1000);
}

async function toggleMute() {
  dashboardState.micEnabled = !dashboardState.micEnabled;

  if (dashboardState.micEnabled) {
    await AudioBridge.startMic();
    if (dashboardState.currentState === "in_call") {
      await AudioBridge.startWebMicStreaming();
    }
    emitCallActionWithAck("unmute");
  } else {
    AudioBridge.stopMic();
    emitCallActionWithAck("mute");
  }

  dashboardActions.syncAudioButtons();
}

function toggleSpeaker() {
  dashboardState.speakerEnabled = !dashboardState.speakerEnabled;
  AudioBridge.setPhoneAudioEnabled(dashboardState.speakerEnabled && dashboardState.currentState === "in_call");

  // Enviar comando al APK para el altavoz físico
  emitCallActionWithAck(dashboardState.speakerEnabled ? "speaker_on" : "speaker_off");

  dashboardActions.syncAudioButtons();
}

function applyState(state, lastNum, opts = {}) {
  const previousState = dashboardState.currentState;
  dashboardState.currentState = state;

  if (opts.micMuted !== undefined) {
    const newMicEnabled = !opts.micMuted;
    if (newMicEnabled !== dashboardState.micEnabled) {
      dashboardState.micEnabled = newMicEnabled;
      if (!dashboardState.micEnabled) {
        AudioBridge.stopMic();
      }
    }
  }
  if (opts.isSpeakerOn !== undefined) {
    const newSpeakerEnabled = opts.isSpeakerOn;
    if (newSpeakerEnabled !== dashboardState.speakerEnabled) {
      dashboardState.speakerEnabled = newSpeakerEnabled;
      AudioBridge.setPhoneAudioEnabled(dashboardState.speakerEnabled && state === "in_call");
    }
  }

  dashboardActions.syncAudioButtons();

  setBadge(state, refs.callBadgeEl);
  if (refs.callNumberEl && lastNum) refs.callNumberEl.textContent = lastNum;
  if (refs.callNameEl && opts.contactName) refs.callNameEl.textContent = opts.contactName;
  if (refs.callKickerEl) {
    refs.callKickerEl.className = `call-kicker state-${state}`;
    const kickerMap = {
      idle: "Listo",
      dialing: "Llamando...",
      ringing: "Sonando...",
      in_call: "Contestada",
      ended: dashboardState.callStartedAt ? "Llamada finalizada" : "No contestó",
      failed: "No se pudo llamar"
    };
    refs.callKickerEl.textContent = kickerMap[state] || "Estado";
  }
  if (refs.callHintEl) {
    const hints = {
      idle: "Esperando acción del celular.",
      dialing: "El celular inició el marcado.",
      ringing: "La llamada está sonando.",
      in_call: "Llamada contestada y en curso.",
      ended: dashboardState.callStartedAt ? `Duración: ${refs.callDurEl?.textContent || "00:00"}` : "La llamada no fue contestada.",
      failed: "No se pudo iniciar la llamada."
    };
    refs.callHintEl.textContent = hints[state] || "";
  }

  // New state handling logic
    if (state === "in_call") {
        if (!dashboardState.callStartedAt) {
            dashboardState.callStartedAt = Date.now();
            startCallTimer();
        }
        refs.callModalEl.classList.add("is-active-call");
        refs.callModalEl.classList.remove("is-ringing");
        refs.callRingEl.classList.add("is-in-call");
    } else if (state === "idle" || state === "ended" || state === "failed") {
        stopCallTimer(false); // Stop but don't clear Last Duration yet
        refs.callModalEl.classList.remove("is-active-call");
        refs.callModalEl.classList.remove("is-ringing");
        refs.callRingEl.classList.remove("is-in-call");

        if (state === "ended" && dashboardState.lastCallDuration > 0) {
            if (dashboardState.currentCallingContactId) {
                Contacts.callDurations[dashboardState.currentCallingContactId] = (Contacts.callDurations[dashboardState.currentCallingContactId] || 0) + dashboardState.lastCallDuration;
                Contacts.saveCallDurations();
            }

            // Add to history
            dashboardActions.addHistoryEntry(lastNum || dashboardState.callCtx?.phone, dashboardState.lastCallDuration);

            refs.callHintEl.textContent = `Llamada finalizada. Duración: ${dashboardActions.formatCallDuration(dashboardState.lastCallDuration)}`;
            // Keep duration visible in the badge for a moment
            if (refs.callDurEl) refs.callDurEl.textContent = dashboardActions.formatCallDuration(dashboardState.lastCallDuration);
            dashboardState.lastCallDuration = 0;
            dashboardActions.renderContacts();
        }

        if (state === "idle" || state === "ended" || state === "failed") {
            if (state === "idle") {
              dashboardState.callStartedAt = null;
              if (refs.callDurEl) refs.callDurEl.textContent = "00:00";
            }
            AudioBridge.stopPhoneAudio();
            AudioBridge.stopMic();
            dashboardState.micEnabled = false;
            dashboardActions.syncAudioButtons();

            // Close modal faster (2s instead of 4s) to keep campaign moving
            setTimeout(() => {
                if (dashboardState.currentState === "idle" || dashboardState.currentState === "ended" || dashboardState.currentState === "failed") {
                    refs.callModalEl.style.display = "none";
                }
            }, 2000);
        }
    } else {
        refs.callModalEl.classList.remove("is-active-call");
        if (state === "ringing" || state === "dialing") {
          refs.callModalEl.classList.add("is-ringing");
        } else {
          refs.callModalEl.classList.remove("is-ringing");
        }
        refs.callRingEl.classList.remove("is-in-call");
    }

    if (state === "ringing" || state === "dialing") {
        refs.callRingEl.classList.add("is-calling");
    } else {
        refs.callRingEl.classList.remove("is-calling");
    }
    dashboardActions.syncAudioButtons();
}

function emitCallActionWithAck(action, payload = {}) {
  const commandId = (typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  const existing = dashboardState.pendingCommandTimeouts.get(commandId);
  if (existing) clearTimeout(existing);
  socket.emit("call:action", { action, commandId, ...payload });
  setAckBadge(refs.apkAckBadgeEl, "pending", `APK · ${action}...`);
  const timeoutId = setTimeout(() => {
    dashboardState.pendingCommandTimeouts.delete(commandId);
    setAckBadge(refs.apkAckBadgeEl, "warn", `APK · sin respuesta`);
    if (refs.callHintEl && action === "dial" && ["idle", "failed", "ended"].includes(dashboardState.currentState)) {
      refs.callHintEl.textContent = "El celular no confirmó la orden. Revisa permisos, marcador predeterminado o conexión del APK.";
    }
  }, 8000);
  dashboardState.pendingCommandTimeouts.set(commandId, timeoutId);
  return commandId;
}
return { startDialForContact, openCallWindow, stopCallTimer, startCallTimer, toggleMute, toggleSpeaker, applyState, emitCallActionWithAck };
}
