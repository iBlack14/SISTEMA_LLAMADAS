

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
  const until = restriction?.nextAllowedAt || contact.callBlockedUntil;
  return until && Date.parse(until) > Date.now() ? until : null;
}

function contactActionButtons(contact, scope = "contacts") {
  const until = contactAnnualBlock(contact);
  const reason = until === "permanent" ? "NO VOLVER A LLAMAR: número inexistente o incorrecto" : until ? "Número llamado anteriormente. Disponible desde " + new Date(until).toLocaleDateString("es-PE",{timeZone:"America/Lima"}) : "";
  return `<div class="contact-action-buttons">
    <button type="button" class="wa-action-btn" data-action="whatsapp-direct" data-id="${dashboardActions.escHtml(contact.id || "")}" data-list-contact-scope="${scope}" aria-label="Contactar por WhatsApp" title="Contactar por WhatsApp">${dashboardActions.whatsappActionIcon()}<span>WHATSAPP</span></button>
    <button type="button" class="call-action-btn" data-action="call-direct" data-id="${dashboardActions.escHtml(contact.id || "")}" data-list="${dashboardActions.escHtml(contact.list || "Principal")}" data-list-contact-scope="${scope}" aria-label="Llamar a este contacto" title="${dashboardActions.escHtml(reason || "Llamar desde el equipo asignado")}" ${until ? "disabled" : ""}>${dashboardActions.mobileCallActionIcon()}<span>${until === "permanent" ? "NO VOLVER A LLAMAR" : until ? "YA LLAMADO" : "LLAMAR"}</span></button>
  </div>`;
}
return { contactAnnualBlock, contactActionButtons };
}
