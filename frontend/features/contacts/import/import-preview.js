import { refs, setStatus, setBadge, setAckBadge } from '../../../shared/ui/dom.js';

/**
 * createImportPreview: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardState.importPreviewBatches, dashboardState.importPreviewData.
 * Se construye una vez por dashboard.
 */
export function createImportPreview(dashboardState, dashboardActions) {
function showImportPreview(items, listName = "") {
  dashboardState.importPreviewBatches = [];
  dashboardState.importPreviewData = items.slice(0, 500);
  refs.previewBody.innerHTML = "";
  refs.previewCountEl.textContent = String(dashboardState.importPreviewData.length);

  const fragment = document.createDocumentFragment();
  for (const item of dashboardState.importPreviewData) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${dashboardActions.escHtml(listName || "Por definir")}</td>
      <td>${dashboardActions.escHtml(item.name)}</td>
      <td style="font-family:monospace;">${dashboardActions.escHtml(item.phone)}</td>
    `;
    fragment.appendChild(tr);
  }
  refs.previewBody.appendChild(fragment);

  refs.importPreview.style.display = dashboardState.importPreviewData.length ? "block" : "none";
}

function resetImportPreview() {
  dashboardState.importPreviewData = [];
  dashboardState.importPreviewBatches = [];
  refs.previewBody.innerHTML = "";
  refs.previewCountEl.textContent = "0";
  refs.importPreview.style.display = "none";
  if (refs.importFileEl) refs.importFileEl.value = "";
  if (refs.importFileNameEl) refs.importFileNameEl.textContent = "Ninguno seleccionado";
}
return { showImportPreview, resetImportPreview };
}
