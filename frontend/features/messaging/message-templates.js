/**
 * Sistema de plantillas de mensajes y mensajería
 * Gestiona plantillas con texto e imágenes, modales y envío a WhatsApp y Correo
 */

import { apiFetch, requireLogin, currentUser } from '../auth/auth-session.js';
import { recordSendStatus } from './message-send-status.js';

const STORAGE_KEY = 'voip_message_templates';
const DB_MIGRATION_KEY = 'voip_message_templates_db_migrated';
const CATEGORY_ORDER = ['Alimentos y hospedaje', 'Comercio y servicios', 'Educación', 'Hogar y construcción', 'Salud y bienestar', 'Tecnología y web', 'Otros'];

// Palabras clave para clasificar "Speech" (tipo de contenido del mensaje)
const SPEECH_KEYWORDS = {
  'Oferta': /oferta|descuento|promo|especial|gratis|hasta \d+%|ahorra/i,
  'Presentación': /present|somos|empresa|trabajamos|servicio|dedicad/i,
  'Seguimiento': /seguimiento|contactamos|hablamos|anterior|llamada/i,
  'Recordatorio': /recordar|recordatorio|no olvi|fecha|cita|reserva/i,
  'Agradecimiento': /gracias|agradec|apreciam|estimad/i,
  'Informativo': /informar|detall|adjunt|enviam|cotizac|presupuest/i,
};

// Palabras clave para clasificar "Precio"
const PRECIO_KEYWORDS = {
  'Con precio': /s\/\s*[\d,.]+|precio|costo|tarifa|inversión|paquete|plan desde|\$\s*[\d,.]+/i,
  'Sin precio': null,  // fallback: las que no caen en "Con precio"
};
// Palabras clave para clasificar "Combo" (paquetes o promociones agrupadas)
const COMBO_KEYWORDS = /combo|paquete|kit\b|promo|incluye|conjunto|duo|tr[íi]o|oferta conjunta/i;
const FLYERS_PATH = '/features/messaging/campaign-2027/';

/** Miniatura ligera solo para vistas previas; el envío sigue usando la imagen original. */
function templateThumbUrl(image) {
  const value = String(image || '');
  const index = value.indexOf(FLYERS_PATH);
  if (index === -1) return value;
  return `${value.slice(0, index + FLYERS_PATH.length)}thumbs/${value.slice(index + FLYERS_PATH.length)}`;
}

// ============================================================================
// STATE
// ============================================================================
let templates = [];
let currentEditingId = null;
let currentEditingType = 'both'; // Las plantillas nuevas siempre son para WhatsApp y Correo
let pendingTemplateCategory = ''; // Categoría preseleccionada al crear desde un filtro
let currentSendTab = 'whatsapp'; // Pestaña activa del modal de envío
let currentEditingImage = null; // Base64 o URL para templateModal
let currentSendImage = null;    // Base64 o URL para sendMessageModal
let emailAttachments = [];      // Archivos PDF/Word/Excel para envío SMTP
const EMAIL_FILE_PATTERN = /\.(pdf|doc|docx|xls|xlsx)$/i;
const EMAIL_MAX_FILES = 5;
const EMAIL_MAX_FILE_SIZE = 10 * 1024 * 1024;
const EMAIL_MAX_TOTAL_SIZE = 20 * 1024 * 1024;
let initializationPromise = null;
let eventsBound = false;
let currentSendContact = null;
// true cuando ya se resolvió el envío (éxito, error o plantilla suelta):
// al cerrar el modal sin enviar se marca "No contactado".
let contactSendResolved = true;

// Estado de los cuatro filtros dropdown
const activeFilters = { rubro: '', speech: '', precio: '', combo: '' };

// Categorías creadas por el usuario en cada filtro (se guardan en el navegador)
const CUSTOM_FILTER_KINDS = ['rubro', 'speech', 'precio', 'combo'];
const customFilters = { rubro: {}, speech: {}, precio: {}, combo: {} };

// ============================================================================
// TOAST NOTIFICATIONS
// ============================================================================
export function showToast(message, type = 'info', duration = 3200) {
  let container = document.getElementById('appToastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'appToastContainer';
    container.className = 'app-toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `app-toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : type === 'warning' ? '⚠' : type === 'error' ? '✕' : 'ℹ'}</span>
    <span class="toast-text">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));

  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

// ============================================================================
// IMAGE UTILITIES (Compresión cliente & Copiado al portapapeles)
// ============================================================================

/**
 * Procesa y comprime imágenes en el navegador mediante Canvas
 * Convierte a JPEG/WebP optimizado (< 150KB) para que quepan en localStorage y carguen al instante.
 */
export function processImageFile(file, maxWidth = 1200, maxHeight = 1200, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      return reject(new Error('El archivo seleccionado no es una imagen válida.'));
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.drawImage(img, 0, 0, width, height);

        // Convertir a JPEG comprimido para compatibilidad y tamaño óptimo
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('No se pudo decodificar la imagen.'));
      img.src = event.target.result;
    };
    reader.onerror = () => reject(new Error('Error al leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Copia una imagen al portapapeles usando ClipboardItem (image/png)
 * Permite que el usuario simplemente presione Ctrl+V en WhatsApp Web/Escritorio.
 */
export async function copyImageToClipboard(imageSource) {
  if (!imageSource) return false;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = imageSource;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) throw new Error('No se pudo generar PNG Blob');

    if (navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob })
      ]);
      return true;
    }
    return false;
  } catch (err) {
    console.warn('Error copiando imagen al portapapeles:', err);
    return false;
  }
}

// ============================================================================
// INIT
// ============================================================================
export function init() {
  if (initializationPromise) return initializationPromise;
  if (!eventsBound) {
    bindEvents();
    eventsBound = true;
  }
  initializationPromise = (async () => {
    try {
      await migrateLegacyTemplates();
      const data = await requestJson('/api/message-templates');
      templates = Array.isArray(data.templates) ? data.templates : [];
      const createButton = document.getElementById('createTemplateBtn');
      if (createButton) createButton.hidden = (currentUser || window.VOIP_VC_AUTH_USER)?.role !== 'ADMINISTRADOR';
    } catch (err) {
      console.error('Error cargando plantillas desde la base de datos:', err);
      templates = [];
      initializationPromise = null;
      showToast(err.message || 'No se pudieron cargar las plantillas.', 'error');
    }
    await loadCustomFilters();
    renderTemplates();
    renderSendTemplateList(document.getElementById('sendMessageModal')?.dataset.templateId || '');
  })();
  initializationPromise.finally(() => { initializationPromise = null; });
  return initializationPromise;
}

async function requestJson(url, options = {}) {
  const response = await apiFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
}

async function migrateLegacyTemplates() {
  if ((currentUser || window.VOIP_VC_AUTH_USER)?.role !== 'ADMINISTRADOR') return;
  try {
    if (localStorage.getItem(DB_MIGRATION_KEY) === 'true') return;
    const stored = localStorage.getItem(STORAGE_KEY);
    const legacy = stored ? JSON.parse(stored) : [];
    if (Array.isArray(legacy) && legacy.length) {
      const cleanLegacy = legacy
        .filter(item => item?.name && item?.message && !['Seguimiento de propuesta', 'Recordatorio de reunión', 'Agradecimiento'].includes(item.name))
        .map(item => ({
          ...item,
          id: /^[a-z0-9_-]{1,120}$/i.test(String(item.id || '')) ? String(item.id) : generateId(),
          category: item.category || inferCategory(item.name)
        }));
      if (cleanLegacy.length) {
        await requestJson('/api/message-templates/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templates: cleanLegacy })
        });
      }
      localStorage.removeItem(STORAGE_KEY);
    }
    localStorage.removeItem('voip_campaign_flyers_2027_seeded');
    localStorage.setItem(DB_MIGRATION_KEY, 'true');
  } catch (err) {
    console.warn('No se pudo migrar el catálogo local de plantillas:', err);
  }
}

function inferCategory(name = '') {
  const value = String(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const groups = [
    ['Salud y bienestar', /BIOLOG|FARMAC|LABORATORIO|MEDICINA|ODONTO|OTORRINO|OPTICA|VETERIN|MANICURE|BELLEZA/],
    ['Educación', /CETPRO|INSTITUTO|UNIVERSIDAD|AULA VIRTUAL/],
    ['Tecnología y web', /DISENADOR|TECNOLOG|WEB RESPONSIVE|INTERNET|VIRTUAL|SOLUCIONES WEB|VIA COMUNICATIVA/],
    ['Hogar y construcción', /ARQUITECT|FERRETER|INGENIER|GEOLOG|LADRILL|MAQUINARIA|MECANICA|METAL MECANICA|TIENDAS? DE (MUEBLES|TELA)|CERAMIC|SASTRE/],
    ['Alimentos y hospedaje', /CHEF|RESTAURANTE|INDUSTRIAS ALIMENTARIAS|HOTEL|AGENCIA DE VIAJES/],
    ['Comercio y servicios', /ABOGADOS|ADMINISTRACI|AGUA|ASESOR|CALZADO|CALL CENTER|CONTABILIDAD|GRIFOS|IMPRENTA|PUBLICIDAD|TIENDA|VENDE|PRECIOS|NEGOCIO/]
  ];
  return groups.find(([, pattern]) => pattern.test(value))?.[0] || 'Otros';
}

function sortTemplates(items) {
  return [...items].sort((a, b) => {
    const categoryDiff = CATEGORY_ORDER.indexOf(a.category || 'Otros') - CATEGORY_ORDER.indexOf(b.category || 'Otros');
    return categoryDiff || String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' });
  });
}

// ============================================================================
// RENDER FULL VIEW (messagesView)
// ============================================================================
function renderTemplates() {
  const container = document.getElementById('templatesListContainer');
  if (!container) return;

  if (templates.length === 0) {
    container.innerHTML = `
      <div class="templates-empty">
        No hay plantillas guardadas. Haz clic en <strong>+ Crear nueva</strong> para agregar una.
      </div>
    `;
    return;
  }

  container.innerHTML = sortTemplates(templates).map(template => {
    const typeLabel = template.type === 'whatsapp' ? 'WhatsApp' :
      template.type === 'email' ? 'Correo' : 'WhatsApp y Correo';
    const hasImage = Boolean(template.image);

    return `
      <div class="template-card" data-id="${escapeHtml(template.id)}">
        <div class="template-header">
          <h4>${escapeHtml(template.name)}</h4>
          <div class="template-actions">
            ${template.shared ? '<span>Plantilla del administrador</span>' : `
            <button type="button" class="edit-template-btn" data-id="${escapeHtml(template.id)}" title="Editar plantilla">
              ✏️
            </button>
            <button type="button" class="delete-template-btn" data-id="${escapeHtml(template.id)}" title="Eliminar plantilla">
              🗑️
            </button>
            `}
          </div>
        </div>
        <div class="template-type">
          <span>${typeLabel}</span><span class="template-category-tag">${escapeHtml(template.category || 'Otros')}</span>
          ${hasImage ? '<span class="template-img-indicator">🖼️ Con imagen</span>' : ''}
        </div>
        ${hasImage ? `
          <div class="template-card-img-preview">
            <img src="${escapeHtml(templateThumbUrl(template.image))}" alt="Imagen plantilla" loading="lazy" decoding="async" />
          </div>
        ` : ''}
        <div class="template-message">
          ${escapeHtml(template.message).substring(0, 110)}${template.message.length > 110 ? '...' : ''}
        </div>
        <div class="template-footer">
          ${template.type !== 'email' ? `
            <button type="button" class="send-whatsapp-btn primary" data-id="${template.id}">
              📱 Enviar WhatsApp
            </button>
          ` : ''}
          ${template.type !== 'whatsapp' ? `
            <button type="button" class="send-email-btn secondary" data-id="${template.id}">
              📧 Enviar Email
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.edit-template-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      editTemplate(btn.dataset.id);
    });
  });

  container.querySelectorAll('.delete-template-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTemplate(btn.dataset.id);
    });
  });

  container.querySelectorAll('.send-whatsapp-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSendModal(btn.dataset.id, 'whatsapp');
    });
  });

  container.querySelectorAll('.send-email-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSendModal(btn.dataset.id, 'email');
    });
  });
}

// ============================================================================
// TEMPLATE MODAL (Crear / Actualizar Plantillas con Imagen)
// ============================================================================
function openTemplateModal(templateId = null, presetCategory = '', presetType = '') {
  const modal = document.getElementById('templateModal');
  const title = document.getElementById('templateModalTitle');
  const nameInput = document.getElementById('templateNameInput');
  const messageInput = document.getElementById('templateMessageInput');
  const footerInput = document.getElementById('templateFooterInput');
  const footerCharCount = document.getElementById('templateFooterCharCount');
  const charCount = document.getElementById('templateCharCount');
  const emptyWrap = document.getElementById('templateImageEmptyWrap');
  const previewWrap = document.getElementById('templateImagePreviewWrap');
  const previewImg = document.getElementById('templateImagePreviewImg');

  if (!modal) return;

  currentEditingId = templateId;
  currentEditingImage = null;

  if (templateId) {
    const template = templates.find(t => t.id === templateId);
    if (!template) return;

    if (title) title.textContent = 'Editar plantilla';
    if (nameInput) nameInput.value = template.name;
    currentEditingType = template.type || 'both';
    pendingTemplateCategory = template.category || '';
    if (messageInput) messageInput.value = template.message;
    if (footerInput) footerInput.value = template.footer || '';

    if (template.image && template.type !== 'email') {
      currentEditingImage = template.image;
      if (previewImg) previewImg.src = template.image;
      if (previewWrap) previewWrap.style.display = 'flex';
      if (emptyWrap) emptyWrap.style.display = 'none';
    } else {
      if (previewWrap) previewWrap.style.display = 'none';
      if (emptyWrap) emptyWrap.style.display = 'flex';
    }
  } else {
    if (title) title.textContent = presetType === 'email' ? 'Nueva plantilla de correo' : 'Nueva plantilla';
    if (nameInput) nameInput.value = '';
    currentEditingType = presetType === 'whatsapp' || presetType === 'email' ? presetType : 'both';
    pendingTemplateCategory = String(presetCategory || '').trim();
    if (messageInput) messageInput.value = '';
    if (footerInput) footerInput.value = '';
    if (previewWrap) previewWrap.style.display = 'none';
    if (emptyWrap) emptyWrap.style.display = 'flex';
  }

  if (charCount && messageInput) {
    charCount.textContent = String(messageInput.value.length);
  }
  if (footerCharCount && footerInput) {
    footerCharCount.textContent = String(footerInput.value.length);
  }
  updateTemplateFooterVisibility();

  modal.style.display = 'flex';
}

function updateTemplateFooterVisibility() {
  const footerField = document.getElementById('templateFooterField');
  if (footerField) footerField.style.display = currentEditingType === 'whatsapp' ? 'none' : '';
  const imageField = document.getElementById('templateImageField');
  if (imageField) imageField.style.display = currentEditingType === 'email' ? 'none' : '';
}

function closeTemplateModal() {
  const modal = document.getElementById('templateModal');
  if (modal) {
    modal.style.display = 'none';
    currentEditingId = null;
    currentEditingImage = null;
  }
}

async function handleTemplateImageSelect(file) {
  if (!file) return;
  try {
    const dataUrl = await processImageFile(file);
    currentEditingImage = dataUrl;

    const emptyWrap = document.getElementById('templateImageEmptyWrap');
    const previewWrap = document.getElementById('templateImagePreviewWrap');
    const previewImg = document.getElementById('templateImagePreviewImg');

    if (previewImg) previewImg.src = dataUrl;
    if (previewWrap) previewWrap.style.display = 'flex';
    if (emptyWrap) emptyWrap.style.display = 'none';

    showToast('Imagen cargada para la plantilla', 'success');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Error al procesar la imagen.', 'error');
  }
}

function removeTemplateImage() {
  currentEditingImage = null;
  const emptyWrap = document.getElementById('templateImageEmptyWrap');
  const previewWrap = document.getElementById('templateImagePreviewWrap');
  const previewImg = document.getElementById('templateImagePreviewImg');
  const fileInput = document.getElementById('templateImageFileInput');

  if (previewImg) previewImg.src = '';
  if (previewWrap) previewWrap.style.display = 'none';
  if (emptyWrap) emptyWrap.style.display = 'flex';
  if (fileInput) fileInput.value = '';
}

async function saveTemplate() {
  const nameInput = document.getElementById('templateNameInput');
  const messageInput = document.getElementById('templateMessageInput');
  const footerInput = document.getElementById('templateFooterInput');

  if (!nameInput || !messageInput) return;

  const name = nameInput.value.trim();
  const type = currentEditingType;
  const message = messageInput.value.trim();
  const footer = String(footerInput?.value || '').trim();

  if (!name) {
    showToast('Ingresa un nombre para la plantilla.', 'warning');
    nameInput.focus();
    return;
  }

  if (!message) {
    showToast('Ingresa el texto del mensaje para la plantilla.', 'warning');
    messageInput.focus();
    return;
  }

  const isEditing = Boolean(currentEditingId);
  const template = {
    id: currentEditingId || generateId(), name,
    category: pendingTemplateCategory || inferCategory(name), type, message, footer,
    image: currentEditingImage || null
  };
  const saveButton = document.getElementById('templateSaveBtn');
  if (saveButton) saveButton.disabled = true;
  try {
    const data = await requestJson(isEditing ? `/api/message-templates/${encodeURIComponent(template.id)}` : '/api/message-templates', {
      method: isEditing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(template)
    });
    const saved = data.template || template;
    if (isEditing) templates = templates.map(item => item.id === saved.id ? saved : item);
    else templates.push(saved);
    showToast(isEditing ? 'Plantilla actualizada con éxito' : 'Plantilla creada con éxito', 'success');
    renderTemplates();
    const sendModal = document.getElementById('sendMessageModal');
    if (sendModal && sendModal.style.display !== 'none') renderSendTemplateList(currentEditingId || sendModal.dataset.templateId);
    closeTemplateModal();
    pendingTemplateCategory = '';
  } catch (err) {
    showToast(err.message || 'No se pudo guardar la plantilla en la base de datos.', 'error');
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function editTemplate(templateId) {
  openTemplateModal(templateId);
}

async function deleteTemplate(templateId) {
  const template = templates.find(t => t.id === templateId);
  if (!template) return;

  if (!confirm(`¿Eliminar la plantilla "${template.name}"?`)) {
    return;
  }

  try {
    await requestJson(`/api/message-templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
    templates = templates.filter(t => t.id !== templateId);
    renderTemplates();
    const sendModal = document.getElementById('sendMessageModal');
    if (sendModal && sendModal.style.display !== 'none') renderSendTemplateList();
    showToast('Plantilla eliminada', 'info');
  } catch (err) {
    showToast(err.message || 'No se pudo eliminar la plantilla.', 'error');
  }
}

// ============================================================================
// SEND MESSAGE MODAL (Envío, Plantillas laterales e Imagen adjunta)
// ============================================================================
async function openSendModal(templateId, initialTab = 'whatsapp') {
  await init();
  const template = templates.find(t => t.id === templateId);
  if (!template) return;

  const modal = document.getElementById('sendMessageModal');
  if (!modal) return;

  modal.dataset.templateId = templateId;

  const message = replaceVariables(template.message);
  const footer = replaceVariables(template.footer || '');
  currentSendTab = initialTab === 'email' ? 'email' : 'whatsapp';
  setSendModalValues({
    message,
    emailBody: composeEmailBody(message, footer),
    subject: template.name,
    image: template.image || null
  });
  currentSendContact = null;
  contactSendResolved = true;
  const contactName = document.getElementById('sendMessageContactName');
  if (contactName) contactName.textContent = 'Plantilla guardada';
  renderSendTemplateList(template.id);
  switchSendTab(initialTab);
  modal.style.display = 'grid';
}

async function openContactSendModal(contact, initialTab = 'whatsapp') {
  await init();
  const modal = document.getElementById('sendMessageModal');
  if (!modal) return;

  const digits = String(contact?.phone || '').replace(/\D/g, '');
  const phone = !digits ? '' : digits.startsWith('51') || digits.length !== 9 ? digits : `51${digits}`;
  const email = String(contact?.email || contact?.correo || '').trim();
  const emailMode = initialTab === 'email';
  // Correo no hereda plantillas de WhatsApp: se abre en blanco para redactar.
  const template = emailMode
    ? null
    : (templates.find(item => item.type === 'both' || item.type === 'whatsapp') || templates[0]);
  const contactNameValue = contact?.name || '';
  const contactCompanyValue = contact?.company || contact?.empresa || '';
  const message = replaceVariables(template?.message || '', contactNameValue, contactCompanyValue);
  const footer = replaceVariables(template?.footer || '', contactNameValue, contactCompanyValue);

  modal.dataset.templateId = template?.id || '';
  currentSendTab = emailMode ? 'email' : 'whatsapp';
  currentSendContact = contact;
  contactSendResolved = false;
  const contactName = document.getElementById('sendMessageContactName');
  if (contactName) contactName.textContent = contact?.name || phone || email || 'Contacto';
  setSendModalValues({
    phone,
    email,
    message,
    emailBody: emailMode ? '' : composeEmailBody(message, footer),
    subject: emailMode ? '' : (template?.name || ''),
    image: emailMode ? null : (template?.image || null)
  });
  renderSendTemplateList(template?.id);
  switchSendTab(initialTab);
  modal.style.display = 'grid';
}

async function openDirectMessageModal() {
  await openContactSendModal({ phone: '', name: '' }, 'whatsapp');
  currentSendContact = null;
  contactSendResolved = true;
  const contactName = document.getElementById('sendMessageContactName');
  if (contactName) contactName.textContent = 'Número directo';
  document.getElementById('sendWhatsAppNumber')?.focus();
}

// ============================================================================
// DROPDOWN FILTER HELPERS
// ============================================================================

/** Infiere la categoria "Speech" (tipo de mensaje) a partir de su contenido. */
function inferSpeech(template) {
  const text = `${template.name} ${template.message}`;
  for (const [label, pattern] of Object.entries(SPEECH_KEYWORDS)) {
    if (pattern && pattern.test(text)) return label;
  }
  return 'General';
}

/** Infiere si la plantilla menciona precio o no. */
function inferPrecio(template) {
  const text = `${template.name} ${template.message}`;
  return PRECIO_KEYWORDS['Con precio'].test(text) ? 'Con precio' : 'Sin precio';
}

/** Infiere si la plantilla corresponde a un combo/paquete. */
function inferCombo(template) {
  const text = `${template.name} ${template.message}`;
  return COMBO_KEYWORDS.test(text) ? 'Con combo' : 'Sin combo';
}

/** Cierra todos los menus desplegables del filtro. */
let activeStfTab = 'rubro';
let browsingStfCategories = false;
function closeAllStfMenus() {
  syncStfTabs();
}

function syncStfTabs() {
  for (const [kind, [buttonId]] of Object.entries(STF_BTN)) {
    const selected = browsingStfCategories && kind === activeStfTab;
    const button = document.getElementById(buttonId);
    const panel = document.getElementById(buttonId.replace('Btn', 'Menu'));
    button?.setAttribute('aria-selected', String(selected));
    button?.setAttribute('aria-controls', buttonId.replace('Btn', 'Menu'));
    if (button) button.tabIndex = selected ? 0 : -1;
    if (panel) {
      panel.hidden = !selected;
      panel.classList.toggle('is-open', selected);
    }
  }
}

/** Genera las opciones de un menu a partir de un Set de valores. */
/** Genera las opciones de un menu a partir de un Set de valores (formato lista limpia) */

/** Metadatos visuales del filtro RUBRO */
const RUBRO_UI = {
  'Comercio y servicios': {
    description: 'Negocios y atención comercial',
    icon: '<path d="M3 10h18l-2-6H5l-2 6Z"/><path d="M5 10v10h14V10M9 20v-7h6v7"/>'
  },
  'Alimentos y hospedaje': {
    description: 'Restaurantes, hoteles y turismo',
    icon: '<path d="M4 3v7a3 3 0 0 0 6 0V3M7 3v18M17 21V3c-4 2-5 6-5 10h5"/>'
  },
  'Hogar y construcción': {
    description: 'Obras, viviendas y materiales',
    icon: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z"/><path d="M9 21v-8h6v8"/>'
  },
  'Salud y bienestar': {
    description: 'Salud, clínicas y cuidado personal',
    icon: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/><path d="M3.5 12h5l2-3 3 6 2-3h5"/>'
  },
  'Educación': {
    description: 'Institutos, colegios y formación',
    icon: '<path d="m2 10 10-5 10 5-10 5ZM6 12v5c4 3 8 3 12 0v-5M22 10v7"/>'
  },
  'Tecnología y web': {
    description: 'Software y soluciones digitales',
    icon: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22h8M12 18v4M9 9l-2 2 2 2m6-4 2 2-2 2"/>'
  },
  'Otros': {
    description: 'Otras actividades y sectores',
    icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'
  }
};

/** Metadatos visuales del filtro SPEECH */
const SPEECH_UI = {
  'Oferta': {
    description: 'Promociones y descuentos',
    icon: '<path d="M20 13 12 21l-9-9V3h9l8 8Z"/><circle cx="8" cy="8" r="1.2"/>'
  },
  'Presentación': {
    description: 'Datos de la empresa y servicios',
    icon: '<path d="M3 11v2a1 1 0 0 0 1 1h3l8 5V5L7 10H4a1 1 0 0 0-1 1Z"/><path d="M18 9a4 4 0 0 1 0 6"/>'
  },
  'Seguimiento': {
    description: 'Contactos y llamadas anteriores',
    icon: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/>'
  },
  'Recordatorio': {
    description: 'Fechas, citas y reservas',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  },
  'Agradecimiento': {
    description: 'Gratitud hacia el cliente',
    icon: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>'
  },
  'Informativo': {
    description: 'Detalles, cotizaciones y adjuntos',
    icon: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h8"/>'
  },
  'General': {
    description: 'Mensajes sin categoría específica',
    icon: '<path d="M21 11.5a8 8 0 0 1-8 8 9 9 0 0 1-3-.5L4 21l1.5-4a8 8 0 1 1 15.5-5.5Z"/>'
  }
};

/** Metadatos visuales del filtro PRECIO */
const PRECIO_UI = {
  'Con precio': {
    description: 'Incluye montos o tarifas',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5a3 3 0 0 0-3-1.5 3 3 0 0 0 0 6 3 3 0 0 1 0 6 3 3 0 0 0 3-1.5M12 6v12"/>'
  },
  'Sin precio': {
    description: 'Sin montos en el mensaje',
    icon: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>'
  }
};

/** Metadatos visuales del filtro COMBO */
const COMBO_UI = {
  'Con combo': {
    description: 'Paquetes y promociones agrupadas',
    icon: '<path d="M3 8h18l-1.5 12h-15L3 8Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>'
  },
  'Sin combo': {
    description: 'Mensajes individuales',
    icon: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/>'
  }
};

/** Configuración compartida de los cuatro menús con formato enriquecido */
const STF_MENU_UI = {
  rubro: {
    allLabel: 'Todos los rubros',
    allDescription: 'Mostrar todas las categorías',
    fallbackDescription: 'Otras actividades',
    options: RUBRO_UI
  },
  speech: {
    allLabel: 'Todos los tipos',
    allDescription: 'Mostrar todos los mensajes',
    fallbackDescription: 'Tipo de mensaje',
    options: SPEECH_UI
  },
  precio: {
    allLabel: 'Todos los precios',
    allDescription: 'Mostrar todas las opciones',
    fallbackDescription: 'Opción de precio',
    options: PRECIO_UI
  },
  combo: {
    allLabel: 'Todos los combos',
    allDescription: 'Mostrar todas las opciones',
    fallbackDescription: 'Opción de combo',
    options: COMBO_UI
  }
};

const STF_CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

const STF_X_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/** Devuelve true si todas las plantillas de una opción tienen imagen adjunta. */
function optionHasAllImages(kind, value) {
  if (!value) {
    return templates.length > 0 && templates.every(template => Boolean(template.image));
  }

  const matches = templates.filter(template => {
    if (kind === 'rubro') return (template.category || 'Otros') === value;
    if (kind === 'speech') return inferSpeech(template) === value;
    if (kind === 'precio') return inferPrecio(template) === value;
    if (kind === 'combo') return inferCombo(template) === value;
    return false;
  });

  return matches.length > 0 && matches.every(template => Boolean(template.image));
}

/** Carga desde la base de datos las categorías creadas por los usuarios. */
async function loadCustomFilters() {
  CUSTOM_FILTER_KINDS.forEach(kind => { customFilters[kind] = {}; });
  try {
    const response = await apiFetch('/api/message-filter-options', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || 'No se pudieron cargar las categorías.');

    CUSTOM_FILTER_KINDS.forEach(kind => {
      (data.options?.[kind] || []).forEach(option => {
        const value = String(option.value || '').trim();
        if (!value) return;
        const description = String(option.description || '');
        customFilters[kind][value] = { description, canDelete: option.canDelete !== false };
        STF_MENU_UI[kind].options[value] = {
          description: description || STF_MENU_UI[kind].fallbackDescription,
          icon: ''
        };
      });
    });
  } catch (error) {
    console.error('Error cargando categorías de filtros:', error);
  }
}

/** Elimina una categoría de la base de datos y actualiza los menús. */
async function deleteStfOption(kind, value) {
  if (!STF_MENU_UI[kind] || !customFilters[kind]) return;
  const entry = customFilters[kind][value];
  if (!entry || entry.canDelete === false) return;

  try {
    const params = new URLSearchParams({ kind, value });
    const response = await apiFetch(`/api/message-filter-options?${params}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || 'No se pudo eliminar la categoría.');
  } catch (error) {
    showToast(error.message || 'No se pudo eliminar la categoría.', 'error');
    return;
  }

  delete customFilters[kind][value];
  delete STF_MENU_UI[kind].options[value];
  if (activeFilters[kind] === value) activeFilters[kind] = '';

  refreshStfDropdowns();
  renderSendTemplateList(document.getElementById('sendMessageModal')?.dataset.templateId || '');
  showToast(`Categoría "${value}" eliminada`, 'success');
}

/** Genera opciones sin modificar la lógica de filtrado */
function buildStfMenu(menuEl, values, currentValue, onSelect, kind = '') {
  if (!menuEl) return;

  const ui = STF_MENU_UI[kind] || null;
  menuEl.replaceChildren();
  menuEl.classList.toggle('stf-rich-menu', Boolean(ui));

  const appendOption = (value, title, description = '') => {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'stf-option-row';
    const btn = document.createElement('button');

    btn.type = 'button';
    btn.className = 'stf-menu-option';

    const selected = value === currentValue;
    btn.classList.toggle('is-selected', selected);
    btn.setAttribute('aria-pressed', String(selected));

    if (ui) {
      const copy = document.createElement('span');
      copy.className = 'stf-option-copy';

      const name = document.createElement('span');
      name.className = 'stf-option-title';
      name.textContent = title;

      const desc = document.createElement('span');
      desc.className = 'stf-option-description';
      desc.textContent = description;

      copy.append(name, desc);

      const hasAllImages = optionHasAllImages(kind, value);
      const visual = document.createElement('span');
      visual.className = `stf-option-visual ${hasAllImages ? 'stf-visual-ok' : 'stf-visual-missing'}`;
      visual.title = hasAllImages
        ? 'Todas las plantillas tienen imagen'
        : 'Al menos una plantilla no tiene imagen';
      visual.innerHTML = hasAllImages ? STF_CHECK_SVG : STF_X_SVG;

      btn.append(copy, visual);
    } else {
      btn.textContent = title;
    }

    btn.addEventListener('click', () => onSelect(value));
    row.appendChild(btn);

    if (value && ui) {
      const addTemplateBtn = document.createElement('button');
      addTemplateBtn.type = 'button';
      addTemplateBtn.className = 'stf-option-add-template';
      addTemplateBtn.title = `Agregar plantilla en ${value}`;
      addTemplateBtn.setAttribute('aria-label', `Agregar plantilla en ${value}`);
      addTemplateBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
      addTemplateBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        closeAllStfMenus();
        openTemplateModal(null, value);
      });
      row.appendChild(addTemplateBtn);
    }

    const customEntry = value ? customFilters[kind]?.[value] : null;
    if (customEntry && customEntry.canDelete !== false) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'stf-option-delete';
      deleteBtn.title = 'Eliminar categoría';
      deleteBtn.setAttribute('aria-label', `Eliminar categoría ${value}`);
      deleteBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 4h4l1 3H9l1-3ZM6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>';
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteStfOption(kind, value);
      });
      row.appendChild(deleteBtn);
    }

    li.appendChild(row);
    menuEl.appendChild(li);
  };

  appendOption(
    '',
    ui?.allLabel || 'Todos',
    ui?.allDescription || ''
  );

  [...values].forEach(value => {
    const meta = ui?.options[value];

    appendOption(
      value,
      value,
      meta?.description || ui?.fallbackDescription || ''
    );
  });
}


/** Actualiza el label y el estado visual del boton segun si hay filtro activo. */
function updateStfBtnState(btnId, labelId, defaultLabel, activeValue) {
  const btn = document.getElementById(btnId);
  const lbl = document.getElementById(labelId);
  if (!btn || !lbl) return;
  const fullLabel = btn.getAttribute('aria-label') || defaultLabel;
  if (activeValue) {
    lbl.textContent = activeValue;
    btn.title = `${fullLabel}: ${activeValue}`;
    btn.classList.add('is-active');
  } else {
    lbl.textContent = defaultLabel;
    btn.title = fullLabel;
    btn.classList.remove('is-active');
  }
}

/** Muestra u oculta el boton "Limpiar filtros" segun si algun filtro esta activo. */
function syncClearBtn() {
  const btn = document.getElementById('stfClearFiltersBtn');
  if (!btn) return;
  const anyActive = activeFilters.rubro || activeFilters.speech || activeFilters.precio || activeFilters.combo;
  btn.hidden = !anyActive;
}

/** Botones de los tres filtros: id del botón, id del label y texto corto. */
const STF_BTN = {
  rubro: ['stfRubroBtn', 'stfRubroLabel', 'R'],
  speech: ['stfSpeechBtn', 'stfSpeechLabel', 'S'],
  precio: ['stfPrecioBtn', 'stfPrecioLabel', 'P'],
  combo: ['stfComboBtn', 'stfComboLabel', 'C']
};

/** Aplica un valor a un filtro y actualiza la lista de plantillas. */
function setStfFilter(kind, value) {
  const [btnId, labelId, shortLabel] = STF_BTN[kind] || [];
  if (!btnId) return;
  if (browsingStfCategories) {
    const search = document.getElementById('sendTemplateSearch');
    if (search) search.value = '';
  }
  activeStfTab = kind;
  browsingStfCategories = false;
  for (const [filterKind, [buttonId, filterLabelId, label]] of Object.entries(STF_BTN)) {
    activeFilters[filterKind] = filterKind === kind ? value : '';
    updateStfBtnState(buttonId, filterLabelId, label, activeFilters[filterKind]);
  }
  closeAllStfMenus();
  syncClearBtn();
  renderSendTemplateList(document.getElementById('sendMessageModal')?.dataset.templateId || '');
}

let stfOptionKind = '';

/** Abre el cuadro para crear una nueva categoría en el filtro indicado. */
function openStfOptionModal(kind) {
  if (!STF_MENU_UI[kind]) return;
  const modal = document.getElementById('stfOptionModal');
  if (!modal) return;

  stfOptionKind = kind;
  const titles = {
    rubro: 'Nuevo rubro',
    speech: 'Nuevo speech',
    precio: 'Nuevo precio',
    combo: 'Nuevo combo'
  };
  document.getElementById('stfOptionModalTitle').textContent = titles[kind];
  document.getElementById('stfOptionModalHint').textContent =
    `Se agregará al filtro ${kind} y quedará guardada en este navegador.`;
  document.getElementById('stfOptionName').value = '';
  document.getElementById('stfOptionDescription').value = '';
  modal.classList.add('is-open');
  document.getElementById('stfOptionName')?.focus();
}

/** Cierra el cuadro de nueva categoría. */
function closeStfOptionModal() {
  document.getElementById('stfOptionModal')?.classList.remove('is-open');
  stfOptionKind = '';
}

/** Guarda la categoría nueva en la base de datos, la agrega al menú y la deja seleccionada. */
async function createStfOption() {
  const kind = stfOptionKind;
  if (!STF_MENU_UI[kind]) return;

  const nameInput = document.getElementById('stfOptionName');
  const value = nameInput?.value.trim() || '';
  if (!value) {
    nameInput?.focus();
    showToast('Escribe el nombre de la categoría.', 'error');
    return;
  }

  const exists = Boolean(STF_MENU_UI[kind].options[value]) ||
    Object.keys(customFilters[kind]).some(item => item.toLowerCase() === value.toLowerCase());
  if (exists) {
    showToast('Esa categoría ya existe en el filtro.', 'error');
    return;
  }

  const description = document.getElementById('stfOptionDescription')?.value.trim() || '';
  const saveBtn = document.getElementById('stfOptionSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const response = await apiFetch('/api/message-filter-options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, value, description })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || 'No se pudo crear la categoría.');
  } catch (error) {
    showToast(error.message || 'No se pudo crear la categoría.', 'error');
    return;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }

  customFilters[kind][value] = { description, canDelete: true };
  STF_MENU_UI[kind].options[value] = {
    description: description || STF_MENU_UI[kind].fallbackDescription,
    icon: ''
  };
  closeStfOptionModal();
  refreshStfDropdowns();
  setStfFilter(kind, value);
  showToast(`Categoría "${value}" creada`, 'success');
}

/** Inicializa o refresca los tres dropdowns de filtro. */
function refreshStfDropdowns() {
  if (!document.getElementById('stfRubroBtn')) return;

  const rubros = new Set(templates.map(t => t.category || 'Otros').filter(Boolean));
  const speeches = new Set(templates.map(inferSpeech).filter(Boolean));
  const precios = new Set(templates.map(inferPrecio).filter(Boolean));
  const combos = new Set(templates.map(inferCombo).filter(Boolean));

  Object.keys(customFilters.rubro).forEach(value => rubros.add(value));
  Object.keys(customFilters.speech).forEach(value => speeches.add(value));
  Object.keys(customFilters.precio).forEach(value => precios.add(value));
  Object.keys(customFilters.combo).forEach(value => combos.add(value));

  buildStfMenu(document.getElementById('stfRubroMenu'), rubros, activeFilters.rubro,
    (val) => setStfFilter('rubro', val), 'rubro');

  buildStfMenu(document.getElementById('stfSpeechMenu'), speeches, activeFilters.speech,
    (val) => setStfFilter('speech', val), 'speech');

  buildStfMenu(document.getElementById('stfPrecioMenu'), precios, activeFilters.precio,
    (val) => setStfFilter('precio', val), 'precio');

  buildStfMenu(document.getElementById('stfComboMenu'), combos, activeFilters.combo,
    (val) => setStfFilter('combo', val), 'combo');

  updateStfBtnState('stfRubroBtn', 'stfRubroLabel', 'R', activeFilters.rubro);
  updateStfBtnState('stfSpeechBtn', 'stfSpeechLabel', 'S', activeFilters.speech);
  updateStfBtnState('stfPrecioBtn', 'stfPrecioLabel', 'P', activeFilters.precio);
  updateStfBtnState('stfComboBtn', 'stfComboLabel', 'C', activeFilters.combo);
  syncClearBtn();
}

function emailModeHasTemplate(templateId) {
  if (!templateId) return false;
  const template = templates.find(item => item.id === templateId);
  if (!template) return false;
  return currentSendTab === 'email'
    ? template.type === 'email'
    : (template.type === 'whatsapp' || template.type === 'both');
}

function renderSendTemplateList(selectedId = '') {
  const list = document.getElementById('sendMessageTemplates');
  const count = document.getElementById('sendTemplateCount');
  const search = document.getElementById('sendTemplateSearch');
  const resultCount = document.getElementById('sendTemplateResultCount');
  const filterTools = document.getElementById('sendTemplateFilterTools');
  const templateCount = document.getElementById('sendTemplateCount');
  if (!list) return;

  const emailMode = currentSendTab === 'email';
  const browsingCategories = !emailMode && browsingStfCategories;
  const selectedFilter = emailMode ? '' : Object.values(activeFilters).find(Boolean);
  if (search) {
    search.placeholder = browsingCategories
      ? 'Buscar categoría…'
      : selectedFilter ? `Buscar en ${selectedFilter}…` : 'Nombre o contenido…';
    search.setAttribute('aria-label', browsingCategories
      ? 'Buscar categoría'
      : selectedFilter ? `Buscar plantilla en ${selectedFilter}` : 'Buscar plantilla');
  }

  // En Correo no hay categorías: solo la lista de plantillas corporativas.
  if (filterTools) filterTools.style.display = emailMode ? 'none' : '';
  const heading = document.getElementById('sendTemplatesTitle');
  if (heading) heading.textContent = emailMode ? 'Plantillas de correo' : 'Mensajes guardados';
  const intro = document.getElementById('sendTemplateIntro');
  if (intro) {
    intro.textContent = emailMode
      ? 'Plantillas de correo sin imágenes. Edita el contenido y el pie de página; adjunta PDF, Word o Excel al enviar.'
      : browsingCategories
        ? 'Elige una categoría para ver sus plantillas.'
        : 'Elige un texto para cargarlo en el mensaje.';
  }

  // Correo empieza vacío: las plantillas de WhatsApp no se reutilizan aquí.
  const pool = templates.filter(t => emailMode
    ? t.type === 'email'
    : (t.type === 'whatsapp' || t.type === 'both'));
  if (!emailMode) refreshStfDropdowns();
  if (!emailMode) syncStfTabs();
  if (!emailMode && search) {
    const categoryQuery = search.value.trim().toLocaleLowerCase('es');
    const activeMenu = document.getElementById(STF_BTN[activeStfTab]?.[0]?.replace('Btn', 'Menu'));
    activeMenu?.querySelectorAll(':scope > li').forEach(item => {
      item.hidden = Boolean(categoryQuery) && !item.textContent.toLocaleLowerCase('es').includes(categoryQuery);
    });
  }
  list.hidden = browsingCategories;
  if (templateCount) templateCount.hidden = browsingCategories;
  if (search?.parentElement) search.parentElement.hidden = emailMode;
  if (browsingCategories && resultCount) resultCount.textContent = 'Elige una categoría para ver sus plantillas';
  if (count) count.textContent = String(pool.length);
  list.replaceChildren();

  if (!pool.length) {
    const empty = document.createElement('p');
    empty.className = 'send-template-empty';
    empty.textContent = emailMode
      ? 'Aún no hay plantillas de correo. Crea la primera con + Nueva.'
      : 'No hay plantillas en la base de datos. Haz clic en "+ Nueva" para crear una.';
    list.appendChild(empty);
    if (resultCount) resultCount.textContent = '0 plantillas';
    return;
  }

  const query = emailMode ? '' : String(search?.value || '').trim().toLocaleLowerCase('es');

  const hasActiveFilters = Boolean(activeFilters.rubro || activeFilters.speech || activeFilters.precio || activeFilters.combo);
  const visibleTemplates = sortTemplates(pool.filter(template => {
    if (query) {
      const searchable = `${template.name} ${template.message}`.toLocaleLowerCase('es');
      if (!searchable.includes(query)) return false;
    }
    if (!emailMode) {
      if (activeFilters.rubro && (template.category || 'Otros') !== activeFilters.rubro) return false;
      if (activeFilters.speech && inferSpeech(template) !== activeFilters.speech) return false;
      if (activeFilters.precio && inferPrecio(template) !== activeFilters.precio) return false;
      if (activeFilters.combo && inferCombo(template) !== activeFilters.combo) return false;
    }
    return true;
  }));

  if (count) count.textContent = String(visibleTemplates.length);
  if (resultCount) {
    resultCount.textContent = query || hasActiveFilters
      ? `${visibleTemplates.length} de ${pool.length} plantillas`
      : `${pool.length} plantillas`;
  }

  if (!visibleTemplates.length) {
    const empty = document.createElement('p');
    empty.className = 'send-template-empty';
    empty.textContent = 'No hay plantillas que coincidan con la búsqueda.';
    list.appendChild(empty);
    return;
  }

  visibleTemplates.forEach(template => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'send-template-option';
    button.classList.toggle('is-selected', template.id === selectedId);
    button.classList.toggle('is-email', emailMode);
    button.dataset.sendTemplateId = template.id;

    const hasImage = !emailMode && Boolean(template.image);
    const typeLabel = template.type === 'email' ? 'Correo' :
      template.type === 'whatsapp' ? 'WhatsApp' : 'WhatsApp y Correo';
    const footerSnippet = emailMode && template.footer
      ? `<div class="send-template-footer">${escapeHtml(template.footer)}</div>`
      : '';

    button.innerHTML = `
      <div class="send-template-card-main">
        ${hasImage ? `<img src="${escapeHtml(templateThumbUrl(template.image))}" class="send-template-mini-thumb" alt="" loading="lazy" decoding="async" />` : ""}
        <div class="send-template-card-content">
          <div class="send-template-option-top">
            <strong class="send-template-title" title="${escapeHtml(template.name)}">${escapeHtml(template.name)}</strong>
            <div class="send-template-actions">
              <span class="btn-action edit" data-action="edit" data-id="${template.id}" title="Editar plantilla"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></span>
              <span class="btn-action delete" data-action="delete" data-id="${template.id}" title="Eliminar plantilla"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></span>
            </div>
          </div>
          <div class="send-template-snippet">${escapeHtml(template.message)}</div>
          ${footerSnippet}
        </div>
      </div>
      <div class="send-template-option-bottom">
        <small class="type-tag">${typeLabel}</small>
        ${hasImage ? `<span class="has-img-chip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:3px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Con imagen</span>` : ""}
      </div>
    `;

    list.appendChild(button);
  });
}

function composeEmailBody(message, footer = '') {
  const cleanFooter = String(footer || '').trim();
  return cleanFooter ? `${message}\n\n${cleanFooter}` : message;
}

function applySendTemplate(templateId) {
  const template = templates.find(item => item.id === templateId);
  if (!template) return;

  const message = replaceVariables(
    template.message,
    currentSendContact?.name || '',
    currentSendContact?.company || currentSendContact?.empresa || ''
  );
  const footer = replaceVariables(
    template.footer || '',
    currentSendContact?.name || '',
    currentSendContact?.company || currentSendContact?.empresa || ''
  );

  setSendModalValues({
    phone: document.getElementById('sendWhatsAppNumber')?.value || '',
    email: document.getElementById('sendEmailAddress')?.value || '',
    message,
    emailBody: composeEmailBody(message, footer),
    subject: template.name,
    image: template.image || null
  });

  const modal = document.getElementById('sendMessageModal');
  if (modal) modal.dataset.templateId = template.id;
  renderSendTemplateList(template.id);
}

function setSendModalValues({ phone = '', email = '', message = '', emailBody = null, subject = '', image = null }) {
  const phoneInput = document.getElementById('sendWhatsAppNumber');
  const emailInput = document.getElementById('sendEmailAddress');
  const subjectInput = document.getElementById('sendEmailSubject');
  const waMessage = document.getElementById('sendWhatsAppMessage');
  const emailMessage = document.getElementById('sendEmailMessage');

  // Asignar también cadenas vacías para limpiar el modal al cambiar de canal.
  if (phoneInput && phone !== undefined) phoneInput.value = phone;
  if (emailInput && email !== undefined) emailInput.value = email;
  if (subjectInput && subject !== undefined) subjectInput.value = subject;
  if (waMessage && message !== undefined) waMessage.value = message;
  if (emailMessage) emailMessage.value = emailBody ?? message;

  updateCharCount(waMessage, document.getElementById('whatsappCharCount'), 1000);
  updateCharCount(emailMessage, document.getElementById('emailCharCount'), 5000);

  // Cargar imagen en los paneles de WhatsApp y Correo
  setSendImage(image);
}

function setSendImage(imageSource) {
  currentSendImage = imageSource;

  // WhatsApp panel image preview
  const waPreviewWrap = document.getElementById('sendWhatsAppImagePreviewWrap');
  const waThumb = document.getElementById('sendWhatsAppImageThumb');
  if (waPreviewWrap && waThumb) {
    if (imageSource) {
      waThumb.src = imageSource;
      waPreviewWrap.style.display = 'flex';
    } else {
      waThumb.src = '';
      waPreviewWrap.style.display = 'none';
    }
  }

  // Email panel image preview
  const emailPreviewWrap = document.getElementById('sendEmailImagePreviewWrap');
  const emailThumb = document.getElementById('sendEmailImageThumb');
  if (emailPreviewWrap && emailThumb) {
    if (imageSource) {
      emailThumb.src = imageSource;
      emailPreviewWrap.style.display = 'flex';
    } else {
      emailThumb.src = '';
      emailPreviewWrap.style.display = 'none';
    }
  }

  updateWhatsAppNote();
}

function removeSendImage() {
  currentSendImage = null;
  const waPreviewWrap = document.getElementById('sendWhatsAppImagePreviewWrap');
  const emailPreviewWrap = document.getElementById('sendEmailImagePreviewWrap');
  const waThumb = document.getElementById('sendWhatsAppImageThumb');
  const emailThumb = document.getElementById('sendEmailImageThumb');
  const waFileInput = document.getElementById('sendWhatsAppImageInput');
  const emailFileInput = document.getElementById('sendEmailImageInput');

  if (waThumb) waThumb.src = '';
  if (emailThumb) emailThumb.src = '';
  if (waPreviewWrap) waPreviewWrap.style.display = 'none';
  if (emailPreviewWrap) emailPreviewWrap.style.display = 'none';
  if (waFileInput) waFileInput.value = '';
  if (emailFileInput) emailFileInput.value = '';

  updateWhatsAppNote();
  showToast('Imagen quitada del mensaje', 'info');
}

function updateWhatsAppNote() {
  const noteText = document.getElementById('whatsappNoteText');
  if (!noteText) return;
  if (currentSendImage) {
    noteText.innerHTML = '<strong>Imagen lista:</strong> Al hacer clic en <em>Continuar en WhatsApp</em>, se copiará automáticamente al portapapeles. Solo pulsa <strong>Ctrl + V</strong> en el chat para pegarla.';
  } else {
    noteText.textContent = 'Edita el texto y confirma en WhatsApp. Guardará registrado en la base de datos.';
  }
}

async function handleSendImageSelect(file) {
  if (!file) return;
  try {
    const dataUrl = await processImageFile(file);
    setSendImage(dataUrl);
    showToast('Imagen lista para enviar', 'success');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Error al procesar la imagen.', 'error');
  }
}

async function copySendImage() {
  if (!currentSendImage) {
    showToast('No hay ninguna imagen adjunta para copiar.', 'warning');
    return;
  }
  const ok = await copyImageToClipboard(currentSendImage);
  if (ok) {
    showToast('📋 ¡Imagen copiada al portapapeles! Lista para pegar (Ctrl+V) en WhatsApp.', 'success');
    const waCopyBtn = document.getElementById('sendWhatsAppCopyImageBtn');
    if (waCopyBtn) {
      const orig = waCopyBtn.innerHTML;
      waCopyBtn.innerHTML = '✓ ¡Copiada!';
      waCopyBtn.classList.add('is-copied');
      setTimeout(() => {
        waCopyBtn.innerHTML = orig;
        waCopyBtn.classList.remove('is-copied');
      }, 2000);
    }
  } else {
    showToast('No se pudo copiar directo. Haz clic derecho en la imagen y selecciona "Copiar imagen".', 'warning');
  }
}

function closeSendModal() {
  const modal = document.getElementById('sendMessageModal');
  // Si se abrió desde un contacto y no se llegó a enviar, queda "No contactado".
  if (currentSendContact && !contactSendResolved) {
    const emailActive = document.getElementById('tabEmailBtn')?.classList.contains('active');
    recordSendStatus(currentSendContact.phone, 'failed', emailActive ? 'email' : 'whatsapp');
  }
  if (modal) {
    modal.style.display = 'none';
    modal.dataset.templateId = '';
  }
  currentSendContact = null;
  contactSendResolved = true;
  currentSendImage = null;
  emailAttachments = [];
  renderEmailAttachments();
  const filesInput = document.getElementById('sendEmailFilesInput');
  if (filesInput) filesInput.value = '';
}

function switchSendTab(tab) {
  const waTab = document.getElementById('tabWhatsAppBtn');
  const emailTab = document.getElementById('tabEmailBtn');
  const waContent = document.getElementById('whatsappContent');
  const emailContent = document.getElementById('emailContent');

  if (!waTab || !emailTab || !waContent || !emailContent) return;

  const modal = document.getElementById('sendMessageModal');
  const nextTab = tab === 'email' ? 'email' : 'whatsapp';
  const changed = currentSendTab !== nextTab;
  currentSendTab = nextTab;
  modal?.classList.toggle('is-email-mode', nextTab === 'email');

  if (changed && nextTab === 'email' && !emailModeHasTemplate(modal?.dataset.templateId || '')) {
    const subjectInput = document.getElementById('sendEmailSubject');
    const bodyInput = document.getElementById('sendEmailMessage');
    if (subjectInput) subjectInput.value = '';
    if (bodyInput) bodyInput.value = '';
    updateCharCount(bodyInput, document.getElementById('emailCharCount'), 5000);
  }

  if (nextTab === 'whatsapp') {
    waTab.classList.add('active');
    emailTab.classList.remove('active');
    waTab.setAttribute('aria-selected', 'true');
    emailTab.setAttribute('aria-selected', 'false');
    waContent.style.display = 'grid';
    emailContent.style.display = 'none';
  } else {
    emailTab.classList.add('active');
    waTab.classList.remove('active');
    emailTab.setAttribute('aria-selected', 'true');
    waTab.setAttribute('aria-selected', 'false');
    emailContent.style.display = 'grid';
    waContent.style.display = 'none';
  }

  if (changed) {
    const selectedId = modal?.dataset.templateId || '';
    if (emailModeHasTemplate(selectedId)) applySendTemplate(selectedId);
    else renderSendTemplateList(selectedId);
  }
}

// ============================================================================
// ENVÍO DE MENSAJES (WhatsApp & Correo)
// ============================================================================
async function sendWhatsApp() {
  const phoneInput = document.getElementById('sendWhatsAppNumber');
  const messageInput = document.getElementById('sendWhatsAppMessage');

  if (!phoneInput || !messageInput) return;

  const phone = phoneInput.value.trim();
  const message = messageInput.value.trim();

  if (!phone) {
    showToast('Ingresa un número de WhatsApp con código de país.', 'warning');
    phoneInput.focus();
    return;
  }

  if (!message) {
    showToast('Ingresa el texto del mensaje.', 'warning');
    messageInput.focus();
    return;
  }

  // Si hay imagen adjunta, copiarla al portapapeles automáticamente
  if (currentSendImage) {
    try {
      const copied = await copyImageToClipboard(currentSendImage);
      if (copied) {
        showToast('📋 ¡Imagen copiada! Pégala con Ctrl + V en el chat de WhatsApp.', 'success', 4000);
      }
    } catch {
      // Ignorar fallo silencioso y continuar abriendo WhatsApp
    }
  }

  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length === 9) cleanPhone = `51${cleanPhone}`;
  if (cleanPhone.length < 8 || cleanPhone.length > 15) {
    showToast('Revisa el número e incluye el código de país si corresponde.', 'warning');
    phoneInput.focus();
    return;
  }
  const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;

  const waWindow = window.open(waUrl, '_blank');
  const opened = Boolean(waWindow);
  // El estado se registra para el contacto de la fila, no para el número tecleado.
  recordSendStatus(currentSendContact?.phone || cleanPhone, opened ? 'sent' : 'failed', 'whatsapp');
  contactSendResolved = true;
  if (!opened) {
    showToast('El navegador bloqueó WhatsApp Web. Permite las ventanas emergentes y reintenta.', 'warning');
    return;
  }
  closeSendModal();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function addEmailAttachments(fileList) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;

  if (incoming.some(file => !EMAIL_FILE_PATTERN.test(file.name || ''))) {
    showToast('Solo se permiten archivos PDF, Word o Excel.', 'warning');
    return;
  }
  const oversized = incoming.find(file => file.size > EMAIL_MAX_FILE_SIZE);
  if (oversized) {
    showToast(`"${oversized.name}" supera el límite de 10 MB.`, 'warning');
    return;
  }

  const room = EMAIL_MAX_FILES - emailAttachments.length;
  if (room <= 0) {
    showToast(`Máximo ${EMAIL_MAX_FILES} archivos adjuntos.`, 'warning');
    return;
  }
  if (incoming.length > room) {
    showToast(`Solo puedes agregar ${room} archivo(s) más.`, 'warning');
  }

  const accepted = incoming.slice(0, room);
  const currentSize = emailAttachments.reduce((total, file) => total + file.size, 0);
  const incomingSize = accepted.reduce((total, file) => total + file.size, 0);
  if (currentSize + incomingSize > EMAIL_MAX_TOTAL_SIZE) {
    showToast('Los archivos superan el límite total de 20 MB.', 'warning');
    return;
  }

  emailAttachments = [...emailAttachments, ...accepted];
  renderEmailAttachments();
}

function removeEmailAttachment(index) {
  if (!Number.isInteger(index) || index < 0 || index >= emailAttachments.length) return;
  emailAttachments.splice(index, 1);
  renderEmailAttachments();
}

function renderEmailAttachments() {
  const list = document.getElementById('sendEmailFilesList');
  if (!list) return;
  list.replaceChildren();

  emailAttachments.forEach((file, index) => {
    const row = document.createElement('div');
    row.className = 'sm-file-row';

    const name = document.createElement('span');
    name.className = 'sm-file-name';
    name.textContent = file.name;
    name.title = file.name;

    const size = document.createElement('span');
    size.className = 'sm-file-size';
    size.textContent = formatFileSize(file.size);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sm-file-remove';
    remove.dataset.removeEmailFile = String(index);
    remove.title = 'Quitar archivo';
    remove.setAttribute('aria-label', `Quitar ${file.name}`);
    remove.textContent = '✕';

    row.append(name, size, remove);
    list.appendChild(row);
  });
}

async function sendEmail() {
  const emailInput = document.getElementById('sendEmailAddress');
  const subjectInput = document.getElementById('sendEmailSubject');
  const messageInput = document.getElementById('sendEmailMessage');

  if (!emailInput || !subjectInput || !messageInput) return;

  const email = emailInput.value.trim();
  const subject = subjectInput.value.trim();
  const message = messageInput.value.trim();

  if (!email || !isValidEmail(email)) {
    showToast('Por favor ingresa un correo válido.', 'warning');
    emailInput.focus();
    return;
  }
  if (!subject) {
    showToast('Por favor ingresa el asunto del correo.', 'warning');
    subjectInput.focus();
    return;
  }
  if (!message) {
    showToast('Por favor ingresa un mensaje.', 'warning');
    messageInput.focus();
    return;
  }

  const button = document.getElementById('sendEmailBtn');
  const originalLabel = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.textContent = 'Enviando correo...';
  }

  try {
    await requireLogin();
    const form = new FormData();
    form.append('to', email);
    form.append('subject', subject);
    form.append('body', message);
    emailAttachments.forEach(file => form.append('attachments', file, file.name));

    const response = await apiFetch('/api/email/send', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || 'No se pudo enviar el correo.');
    }

    showToast('Correo enviado correctamente.', 'success');
    recordSendStatus(currentSendContact?.phone || email, 'sent', 'email');
    contactSendResolved = true;
    emailAttachments = [];
    renderEmailAttachments();
    closeSendModal();
  } catch (error) {
    recordSendStatus(currentSendContact?.phone || email, 'failed', 'email');
    contactSendResolved = true;
    showToast(error.message || 'No se pudo enviar el correo.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = originalLabel;
    }
  }
}

// ============================================================================
// UTILITIES
// ============================================================================
function replaceVariables(message, name = '', company = '') {
  return String(message || '')
    .replace(/\{nombre\}/gi, name || '[nombre]')
    .replace(/\{empresa\}/gi, company || '[empresa]');
}

function updateCharCount(textarea, countElement, max = 1000) {
  if (!textarea || !countElement) return;
  const length = textarea.value.length;
  countElement.textContent = `${length}`;
  if (length > max) {
    countElement.classList.add('text-danger');
  } else {
    countElement.classList.remove('text-danger');
  }
}

function generateId() {
  return `tpl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================================
// EVENT BINDINGS
// ============================================================================
function bindEvents() {
  const templateSearch = document.getElementById('sendTemplateSearch');
  const sendModal = document.getElementById('sendMessageModal');
  const refreshTemplateFilter = () => renderSendTemplateList(sendModal?.dataset.templateId || '');
  templateSearch?.addEventListener('input', refreshTemplateFilter);

  // Clear all filters button
  const clearBtn = document.getElementById('stfClearFiltersBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.rubro = '';
      activeFilters.speech = '';
      activeFilters.precio = '';
      activeFilters.combo = '';
      browsingStfCategories = false;
      updateStfBtnState('stfRubroBtn', 'stfRubroLabel', 'R', '');
      updateStfBtnState('stfSpeechBtn', 'stfSpeechLabel', 'S', '');
      updateStfBtnState('stfPrecioBtn', 'stfPrecioLabel', 'P', '');
      updateStfBtnState('stfComboBtn', 'stfComboLabel', 'C', '');
      syncClearBtn();
      renderSendTemplateList(sendModal?.dataset.templateId || '');
    });
  }

  // Delegate dropdown clicks so re-rendered controls keep working.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const addBtn = target.closest('.stf-add-btn');
    if (addBtn) {
      closeAllStfMenus();
      openStfOptionModal(addBtn.dataset.kind);
      return;
    }

    const btn = target.closest('.stf-dropdown-btn');
    if (btn && btn.closest('#stfDropdownRow')) {
      const kind = Object.keys(STF_BTN).find(key => STF_BTN[key][0] === btn.id);
      if (kind) {
        activeStfTab = kind;
        browsingStfCategories = true;
        const search = document.getElementById('sendTemplateSearch');
        if (search) search.value = '';
        activeFilters.rubro = '';
        activeFilters.speech = '';
        activeFilters.precio = '';
        activeFilters.combo = '';
        for (const [filterKind, [buttonId, labelId, label]] of Object.entries(STF_BTN)) {
          updateStfBtnState(buttonId, labelId, label, '');
        }
        syncClearBtn();
        renderSendTemplateList(sendModal?.dataset.templateId || '');
      }
      return;
    }

    if (!target.closest('#stfDropdownRow')) closeAllStfMenus();
  });

  // Nueva categoría desde los botones "+" de R / S / P
  document.getElementById('stfOptionSaveBtn')?.addEventListener('click', createStfOption);
  document.getElementById('stfOptionCancelBtn')?.addEventListener('click', closeStfOptionModal);
  document.getElementById('stfOptionModal')?.addEventListener('click', (event) => {
    if (event.target?.id === 'stfOptionModal') closeStfOptionModal();
  });
  document.getElementById('stfOptionName')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') createStfOption();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.getElementById('stfOptionModal')?.classList.contains('is-open')) {
      closeStfOptionModal();
    }
  });

  // Crear nueva plantilla desde messagesView
  const createBtn = document.getElementById('createTemplateBtn');
  if (createBtn) {
    createBtn.addEventListener('click', () => openTemplateModal());
  }

  // Crear nueva plantilla desde sendMessageModal (botón + Nueva en el panel izquierdo)
  const sendModalNewBtn = document.getElementById('sendModalNewTemplateBtn');
  if (sendModalNewBtn) {
    sendModalNewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const presetType = currentSendTab === 'email' ? 'email' : 'whatsapp';
      openTemplateModal(null, '', presetType);
    });
  }

  // Template modal close & cancel
  const templateCloseBtn = document.getElementById('templateCloseBtn');
  if (templateCloseBtn) {
    templateCloseBtn.addEventListener('click', closeTemplateModal);
  }
  const templateCancelBtn = document.getElementById('templateCancelBtn');
  if (templateCancelBtn) {
    templateCancelBtn.addEventListener('click', closeTemplateModal);
  }

  // Template modal save
  const templateSaveBtn = document.getElementById('templateSaveBtn');
  if (templateSaveBtn) {
    templateSaveBtn.addEventListener('click', saveTemplate);
  }

  // Template message char count
  const templateMessageInput = document.getElementById('templateMessageInput');
  const templateCharCount = document.getElementById('templateCharCount');
  if (templateMessageInput && templateCharCount) {
    templateMessageInput.addEventListener('input', () => {
      updateCharCount(templateMessageInput, templateCharCount, 1000);
    });
  }

  // Pie de página de la plantilla de correo
  const templateFooterInput = document.getElementById('templateFooterInput');
  const templateFooterCharCount = document.getElementById('templateFooterCharCount');
  if (templateFooterInput && templateFooterCharCount) {
    templateFooterInput.addEventListener('input', () => {
      updateCharCount(templateFooterInput, templateFooterCharCount, 2000);
    });
  }

  // Selector y DropZone de imagen para templateModal
  const tplImageFileInput = document.getElementById('templateImageFileInput');
  const tplDropZone = document.getElementById('templateImageDropZone');
  const tplRemoveImgBtn = document.getElementById('templateImageRemoveBtn');

  if (tplDropZone && tplImageFileInput) {
    tplDropZone.addEventListener('click', (e) => {
      if (e.target.closest('#templateImageRemoveBtn')) return;
      tplImageFileInput.click();
    });

    tplImageFileInput.addEventListener('change', () => {
      if (tplImageFileInput.files && tplImageFileInput.files[0]) {
        handleTemplateImageSelect(tplImageFileInput.files[0]);
      }
    });

    tplDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      tplDropZone.classList.add('is-dragover');
    });

    tplDropZone.addEventListener('dragleave', () => {
      tplDropZone.classList.remove('is-dragover');
    });

    tplDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      tplDropZone.classList.remove('is-dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleTemplateImageSelect(e.dataTransfer.files[0]);
      }
    });
  }

  if (tplRemoveImgBtn) {
    tplRemoveImgBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeTemplateImage();
    });
  }

  // Send modal close
  const sendCloseBtn = document.getElementById('sendMessageCloseBtn');
  if (sendCloseBtn) {
    sendCloseBtn.addEventListener('click', closeSendModal);
  }

  // Send modal tabs
  const waTab = document.getElementById('tabWhatsAppBtn');
  const emailTab = document.getElementById('tabEmailBtn');
  if (waTab) {
    waTab.addEventListener('click', () => switchSendTab('whatsapp'));
  }
  if (emailTab) {
    emailTab.addEventListener('click', () => switchSendTab('email'));
  }

  // WhatsApp send button
  const waSendBtn = document.getElementById('continueWhatsAppBtn');
  if (waSendBtn) {
    waSendBtn.addEventListener('click', sendWhatsApp);
  }

  // WhatsApp message char count
  const waMessageInput = document.getElementById('sendWhatsAppMessage');
  const waCharCount = document.getElementById('whatsappCharCount');
  if (waMessageInput && waCharCount) {
    waMessageInput.addEventListener('input', () => {
      updateCharCount(waMessageInput, waCharCount, 1000);
    });
  }

  // WhatsApp Image attach/copy/remove buttons
  const waAttachBtn = document.getElementById('sendWhatsAppAttachBtn');
  const waImageFileInput = document.getElementById('sendWhatsAppImageInput');
  const waCopyBtn = document.getElementById('sendWhatsAppCopyImageBtn');
  const waRemoveBtn = document.getElementById('sendWhatsAppRemoveImageBtn');

  if (waAttachBtn && waImageFileInput) {
    waAttachBtn.addEventListener('click', () => waImageFileInput.click());
    waImageFileInput.addEventListener('change', () => {
      if (waImageFileInput.files && waImageFileInput.files[0]) {
        handleSendImageSelect(waImageFileInput.files[0]);
      }
    });
  }

  if (waCopyBtn) {
    waCopyBtn.addEventListener('click', copySendImage);
  }

  if (waRemoveBtn) {
    waRemoveBtn.addEventListener('click', removeSendImage);
  }

  // Adjuntos de correo (PDF/Word/Excel) para envío SMTP
  const emailAttachBtn = document.getElementById('sendEmailAttachBtn');
  const emailFilesInput = document.getElementById('sendEmailFilesInput');
  if (emailAttachBtn && emailFilesInput) {
    emailAttachBtn.addEventListener('click', () => emailFilesInput.click());
    emailFilesInput.addEventListener('change', () => {
      addEmailAttachments(emailFilesInput.files);
      emailFilesInput.value = '';
    });
  }
  renderEmailAttachments();

  // Email send button
  const emailSendBtn = document.getElementById('sendEmailBtn');
  if (emailSendBtn) {
    emailSendBtn.addEventListener('click', sendEmail);
  }

  // Email message char count
  const emailMessageInput = document.getElementById('sendEmailMessage');
  const emailCharCount = document.getElementById('emailCharCount');
  if (emailMessageInput && emailCharCount) {
    emailMessageInput.addEventListener('input', () => {
      updateCharCount(emailMessageInput, emailCharCount, 5000);
    });
  }

  // Selección y acciones en la lista lateral de plantillas en sendMessageModal
  if (sendModal) {
    sendModal.addEventListener('click', (event) => {
      // 0. Quitar un adjunto del correo
      const removeFileBtn = event.target.closest('[data-remove-email-file]');
      if (removeFileBtn) {
        event.stopPropagation();
        removeEmailAttachment(Number(removeFileBtn.dataset.removeEmailFile));
        return;
      }

      // 1. Clic en botón editar plantilla en la tarjeta
      const editBtn = event.target.closest('[data-action="edit"]');
      if (editBtn) {
        event.stopPropagation();
        const id = editBtn.dataset.id;
        if (id) editTemplate(id);
        return;
      }

      // 2. Clic en botón eliminar plantilla en la tarjeta
      const deleteBtn = event.target.closest('[data-action="delete"]');
      if (deleteBtn) {
        event.stopPropagation();
        const id = deleteBtn.dataset.id;
        if (id) deleteTemplate(id);
        return;
      }

      // 3. Clic en la tarjeta de plantilla para seleccionarla
      const option = event.target.closest('[data-send-template-id]');
      if (option) {
        applySendTemplate(option.dataset.sendTemplateId);
        return;
      }

      // 4. Cerrar al hacer clic en el backdrop
      if (event.target === sendModal) {
        closeSendModal();
      }
    });
  }

  const templateModal = document.getElementById('templateModal');
  if (templateModal) {
    templateModal.addEventListener('click', (e) => {
      if (e.target === templateModal) {
        closeTemplateModal();
      }
    });
  }

  // Soporte universal para pegar imágenes con Ctrl+V
  window.addEventListener('paste', (e) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData || !clipboardData.items) return;

    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (!file) continue;

        // Si el modal de plantilla está abierto, asignar a la plantilla
        if (templateModal && templateModal.style.display !== 'none') {
          handleTemplateImageSelect(file);
          e.preventDefault();
          break;
        }

        // Si el modal de enviar mensaje está abierto, asignar al mensaje actual
        if (sendModal && sendModal.style.display !== 'none') {
          handleSendImageSelect(file);
          e.preventDefault();
          break;
        }
      }
    }
  });
}

// ============================================================================
// EXPORT
// ============================================================================
export {
  renderTemplates,
  openTemplateModal,
  openSendModal,
  openContactSendModal,
  openDirectMessageModal,
  editTemplate,
  deleteTemplate,
  saveTemplate,
  closeTemplateModal,
  closeSendModal
};
