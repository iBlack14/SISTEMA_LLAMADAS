import { refs, setStatus, setBadge, setAckBadge } from '../shared/ui/dom.js';
import * as WhatsApp from '../features/messaging/whatsapp.js';
import { apiFetch as fetch, currentUser, bindAccountControls } from '../features/auth/auth-session.js';

/**
 * createDashboardLifecycle: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.bindEvents, dashboardActions.loadApkInfo, dashboardActions.renderCampaignPanel, dashboardActions.renderContacts, dashboardActions.restoreSavedSession, dashboardActions.syncAudioButtons, dashboardActions.initMessageContactsAdmin.
 * Se construye una vez por dashboard.
 */
export function createDashboardLifecycle(dashboardState, dashboardActions) {
  async function init() {
    console.log("Dashboard init starting...");
    // Authenticated accounts only load data from their authorized MySQL session.
    // The anonymous legacy browser database is deliberately left untouched.
    bindAccountControls();
    WhatsApp.loadWhatsAppPresetMessages();

    dashboardActions.renderContacts();
    dashboardActions.loadApkInfo().catch(e => console.error("Error loading APK info:", e));
    dashboardActions.bindEvents();
    dashboardActions.syncAudioButtons();
    dashboardActions.renderCampaignPanel();
    dashboardActions.restoreSavedSession();

    // Initialize admin message contacts when messages view is shown
    document.addEventListener("panel:view", (e) => {
      if (e.detail === "messages" && dashboardActions.initMessageContactsAdmin) {
        dashboardActions.initMessageContactsAdmin();
      }
    });

    setStatus("Listo.");
    console.log("Dashboard init complete.");
    window.dispatchEvent(new Event("dashboard:ready"));
  }
  return { init };
}
