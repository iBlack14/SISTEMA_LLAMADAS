

/**
 * createContactActions: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardActions.mobileCallActionIcon, dashboardActions.normalizeValidPeruPhone, dashboardActions.whatsappActionIcon, dashboardState.latestSessionState.
 * Se construye una vez por dashboard.
 */
export function createContactActions(dashboardState, dashboardActions) {
function contactAnnualBlock(contact) {
  const phone = dashboardActions.normalizeValidPeruPhone(contact.phone);
  const restriction = dashboardState.latestSessionState?.callRestrictions?.[phone];
  if (restriction?.permanent || contact.doNotCall) return "permanent";
  if (restriction?.manualBlocked) return "blocked";
  const until = restriction?.nextAllowedAt || contact.callBlockedUntil;
  return until && Date.parse(until) > Date.now() ? until : null;
}

function contactActionButtons(contact, scope = "contacts") {
  const until = contactAnnualBlock(contact);
  const manualRetry = Boolean(until && until !== "blocked" && until !== "permanent");
  const reason = until === "blocked" ? "Número en la lista global de bloqueos"
    : until === "permanent" ? "NO VOLVER A LLAMAR: número inexistente o incorrecto"
    : manualRetry ? "Solo se permite una rellamada manual. Las campañas automáticas seguirán excluyendo este número."
    : until ? "Número llamado anteriormente. Disponible desde " + new Date(until).toLocaleDateString("es-PE",{timeZone:"America/Lima"}) : "";
  const actionLabel = until === "blocked" ? "BLOQUEADO"
    : until === "permanent" ? "NO VOLVER A LLAMAR"
    : manualRetry ? "REINTENTAR"
    : until ? "YA LLAMADO" : "LLAMAR";
  const disabled = Boolean(until && !manualRetry);
  return `<div class="contact-action-buttons">
    <button type="button" class="wa-action-btn" data-action="whatsapp-direct" data-id="${dashboardActions.escHtml(contact.id || "")}" data-list-contact-scope="${scope}" aria-label="Contactar por WhatsApp" title="Contactar por WhatsApp">${dashboardActions.whatsappActionIcon()}<span>WHATSAPP</span></button>
    <button type="button" class="call-action-btn" data-action="call-direct" data-id="${dashboardActions.escHtml(contact.id || "")}" data-list="${dashboardActions.escHtml(contact.list || "Principal")}" data-list-contact-scope="${scope}" aria-label="${manualRetry ? "Reintentar llamada manualmente" : "Llamar a este contacto"}" title="${dashboardActions.escHtml(reason || "Llamar desde el equipo asignado")}" ${disabled ? "disabled" : ""}>${dashboardActions.mobileCallActionIcon()}<span>${actionLabel}</span></button>
  </div>`;
}
return { contactAnnualBlock, contactActionButtons };
}
