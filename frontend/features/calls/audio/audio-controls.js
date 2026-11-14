import { refs, setStatus, setBadge, setAckBadge } from '../../../shared/ui/dom.js';

/**
 * createAudioControls: conserva los contratos y reglas existentes.
 * Dependencias: dashboardState.micEnabled, dashboardState.speakerEnabled.
 * Se construye una vez por dashboard.
 */
export function createAudioControls(dashboardState, dashboardActions) {
function syncAudioButtons() {
  if (refs.muteBtnEl) {
    refs.muteBtnEl.textContent = dashboardState.micEnabled ? "🎙️ Micrófono" : "🔇 Micrófono";
    refs.muteBtnEl.classList.toggle("btn-audio-active", dashboardState.micEnabled);
  }
  if (refs.speakerBtnEl) {
    refs.speakerBtnEl.textContent = dashboardState.speakerEnabled ? "🔊 Altavoz activo" : "🔈 Altavoz";
    refs.speakerBtnEl.classList.toggle("btn-audio-active", dashboardState.speakerEnabled);
  }
  if (refs.micBadgeEl) {
    refs.micBadgeEl.textContent = dashboardState.micEnabled ? "🎙️ Mic activo" : "🔇 Mic apagado";
    refs.micBadgeEl.classList.toggle("is-active", dashboardState.micEnabled);
    refs.micBadgeEl.classList.toggle("muted", !dashboardState.micEnabled);
  }
}
return { syncAudioButtons };
}
