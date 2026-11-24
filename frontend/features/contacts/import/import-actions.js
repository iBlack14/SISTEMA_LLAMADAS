import { socket, API_BASE } from '../../../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../../shared/ui/dom.js';
import * as Contacts from '../contacts-repository.js';
import { apiFetch as fetch, currentUser, bindAccountControls } from '../../auth/auth-session.js';
import { loadBrowserLibrary } from '../../../shared/utils/browser-libraries.js';

/**
 * createImportActions: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardActions.extractContactsFromHtmlTable, dashboardActions.extractContactsFromRows, dashboardActions.loadPairingData, dashboardActions.parseDelimitedText, dashboardActions.renderCampaignPanel, dashboardActions.renderContacts, dashboardActions.renderTabs, dashboardActions.requestListName, dashboardActions.resetImportPreview, dashboardActions.showImportPreview, dashboardState.currentImportFileName, dashboardState.importPreviewBatches, dashboardState.importPreviewData, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createImportActions(dashboardState, dashboardActions) {
function showImportSaveFeedback(message, isError = false) {
  const feedback = refs.importSaveFeedback;
  if (!feedback) return;
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.dataset.error = String(isError);
  const notice = document.getElementById("contactsImportNotice");
  if (notice) {
    notice.textContent = message;
    notice.dataset.error = String(isError);
    notice.hidden = !message;
  }
}

async function addImportedContacts() {
  if (refs.importConfirm?.disabled) return;
  if (!dashboardState.importPreviewBatches.length && !dashboardState.importPreviewData.length) return;
  const button = refs.importConfirm;
  const originalLabel = button?.textContent || "Guardar contactos";
  if (button) {
    button.disabled = true;
    button.textContent = "Guardando…";
  }
  showImportSaveFeedback("Guardando los contactos en MySQL…");

  try {
    await Contacts.flushDatabase();
    let successMessage = "";
    if (dashboardState.importPreviewBatches.length) {
      let totalAdded = 0;
      let processedLists = 0;
      let omitted = 0;
      for (const batch of dashboardState.importPreviewBatches) {
        Contacts.addList(batch.listName);
        const added = Contacts.addContacts(batch.contacts, batch.listName);
        totalAdded += added;
        omitted += Math.max(0, batch.contacts.length - added);
        processedLists += 1;
      }
      Contacts.setActiveList(dashboardState.importPreviewBatches[0].listName);
      await Contacts.flushDatabase();
      successMessage = `${processedLists} lista(s) guardada(s): ${totalAdded} contacto(s) agregado(s)${omitted ? ` y ${omitted} duplicado(s) omitido(s)` : ""}.`;
    } else {
      const defaultTab = dashboardState.currentImportFileName ? dashboardState.currentImportFileName.split('.')[0] : "Lista Nueva";
      const listName = await dashboardActions.requestListName({ title: "Guardar contactos importados", defaultValue: defaultTab });
      if (!listName) {
        showImportSaveFeedback("Guardado cancelado; los contactos siguen en la vista previa.");
        return;
      }
      Contacts.addList(listName);
      Contacts.setActiveList(listName);
      const addedCount = Contacts.addContacts(dashboardState.importPreviewData, listName);
      await Contacts.flushDatabase();
      successMessage = `Lista "${listName}" guardada con ${addedCount} contacto(s).`;
    }

    setStatus(successMessage, true);
    dashboardActions.resetImportPreview();
    dashboardActions.renderTabs();
    dashboardActions.renderContacts();
    dashboardActions.renderCampaignPanel();
    showImportSaveFeedback(successMessage);
    if (dashboardState.sessionCode) dashboardActions.loadPairingData(dashboardState.sessionCode);
  } catch (error) {
    const message = error?.message || "No se pudo confirmar el guardado en MySQL.";
    setStatus(`No se guardaron los contactos: ${message}`, true);
    showImportSaveFeedback(`No se guardaron los contactos: ${message}`, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

async function parseContactsFromFile(file) {
  const lowerName = file.name.toLowerCase();
  let contacts = [];

  if (lowerName.endsWith(".csv") || lowerName.endsWith(".txt")) {
    contacts = dashboardActions.parseDelimitedText(await file.text());
  } else if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
    const XLSX = await loadBrowserLibrary("xlsx");
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: "array" });
    const firstSheet = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { header: 1 });
    contacts = dashboardActions.extractContactsFromRows(rows);
  } else if (lowerName.endsWith(".docx")) {
    const mammoth = await loadBrowserLibrary("mammoth");
    const data = await file.arrayBuffer();
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer: data });
    const doc = new DOMParser().parseFromString(htmlResult.value || "", "text/html");
    contacts = dashboardActions.extractContactsFromHtmlTable(doc);
    if (!contacts.length) {
      const textResult = await mammoth.extractRawText({ arrayBuffer: data });
      contacts = dashboardActions.parseDelimitedText(textResult.value);
    }
  } else {
    throw new Error(`Formato no soportado: ${file.name}`);
  }
  return contacts;
}

function listNameFromFile(fileName) {
  return String(fileName || "Lista")
    .replace(/\.[^.]+$/, "")
    .trim()
    .replace(/\s+/g, " ") || "Lista";
}

async function handleImportFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  refs.importFileNameEl.textContent = files.length === 1
    ? `Archivo elegido: ${files[0].name}`
    : `Archivos elegidos: ${files.length}`;

  const results = await Promise.all(files.map(async (file) => {
    try {
      const contacts = await parseContactsFromFile(file);
      return { file, listName: listNameFromFile(file.name), contacts, error: null };
    } catch (error) {
      console.error("Import file error:", file.name, error);
      return { file, listName: listNameFromFile(file.name), contacts: [], error };
    }
  }));

  dashboardState.importPreviewBatches = results.filter((batch) => !batch.error && batch.contacts.length);
  dashboardState.importPreviewData = dashboardState.importPreviewBatches.flatMap((batch) =>
    batch.contacts.map((contact) => ({ ...contact, importListName: batch.listName }))
  );
  refs.previewBody.innerHTML = "";
  refs.previewCountEl.textContent = String(dashboardState.importPreviewData.length);
  const fragment = document.createDocumentFragment();
  for (const item of dashboardState.importPreviewData.slice(0, 500)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="padding:8px;border-bottom:1px solid #f3f4f6;">${dashboardActions.escHtml(item.company || item.name || "")}</td><td style="padding:8px;border-bottom:1px solid #f3f4f6;font-family:monospace;">${dashboardActions.escHtml(item.phone)}</td>`;
    fragment.appendChild(tr);
  }
  refs.previewBody.appendChild(fragment);
  refs.importPreview.style.display = dashboardState.importPreviewData.length ? "block" : "none";

  const failed = results.filter((batch) => batch.error || !batch.contacts.length);
  const detail = failed.length ? ` ${failed.length} archivo(s) no tenían contactos válidos o no pudieron leerse.` : "";
  setStatus(dashboardState.importPreviewData.length
    ? `${dashboardState.importPreviewBatches.length} lista(s) preparada(s) con ${dashboardState.importPreviewData.length} contacto(s).${detail}`
    : `No se detectaron contactos válidos.${detail}`, true);
}

async function handleImportUrl() {
  const url = String(refs.importUrlEl.value || "").trim();
  if (!url) {
    setStatus("Pega una URL para importar.", true);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/fetch-url?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok || !data.ok || !data.html) {
      setStatus(data.error || "No se pudo leer la URL.", true);
      return;
    }

    const doc = new DOMParser().parseFromString(data.html, "text/html");
    const directTableContacts = dashboardActions.extractContactsFromHtmlTable(doc);
    if (directTableContacts.length) {
      dashboardActions.showImportPreview(directTableContacts);
      setStatus(`Se detectaron ${directTableContacts.length} contactos desde la URL.`, true);
      return;
    }

    const rows = [];
    doc.querySelectorAll("table tr").forEach((tr) => {
      const cols = [...tr.querySelectorAll("th,td")].map((el) => el.textContent?.trim() || "");
      if (cols.some(Boolean)) rows.push(cols);
    });
    if (!rows.length) {
      doc.querySelectorAll("li, p").forEach((el) => {
        const text = el.textContent?.trim() || "";
        if (text) rows.push([text]);
      });
    }

    const contacts = dashboardActions.extractContactsFromRows(rows);
    dashboardActions.showImportPreview(contacts);
    setStatus(contacts.length ? `Se detectaron ${contacts.length} contactos desde la URL.` : "No se detectaron contactos en la URL.", true);
  } catch (error) {
    console.error("Import URL error:", error);
    setStatus("No se pudo importar desde la URL.", true);
  }
}
return { addImportedContacts, parseContactsFromFile, listNameFromFile, handleImportFiles, handleImportUrl };
}
