/**
 * Sistema de plantillas de mensajes y mensajería
 * Gestiona plantillas con texto e imágenes, modales y envío a WhatsApp y Correo
 */

import { apiFetch } from '../auth/auth-session.js';
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
let currentEditingImage = null; // Base64 o URL para templateModal
let currentSendImage = null;    // Base64 o URL para sendMessageModal
let initializationPromise = null;
let eventsBound = false;
let currentSendContact = null;
// true cuando ya se resolvió el envío (éxito, error o plantilla suelta):
// al cerrar el modal sin enviar se marca "No contactado".
let contactSendResolved = true;

// Estado de los tres filtros dropdown
const activeFilters = { rubro: '', speech: '', precio: '' };

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
    } catch (err) {
      console.error('Error cargando plantillas desde la base de datos:', err);
      templates = [];
      initializationPromise = null;
      showToast(err.message || 'No se pudieron cargar las plantillas.', 'error');
    }
    renderTemplates();
    renderSendTemplateList(document.getElementById('sendMessageModal')?.dataset.templateId || '');
  })();
  return initializationPromise;
}

async function requestJson(url, options = {}) {
  const response = await apiFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
}

async function migrateLegacyTemplates() {
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
            <button type="button" class="edit-template-btn" data-id="${escapeHtml(template.id)}" title="Editar plantilla">
              ✏️
            </button>
            <button type="button" class="delete-template-btn" data-id="${escapeHtml(template.id)}" title="Eliminar plantilla">
              🗑️
            </button>
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
function openTemplateModal(templateId = null) {
  const modal = document.getElementById('templateModal');
  const title = document.getElementById('templateModalTitle');
  const nameInput = document.getElementById('templateNameInput');
  const typeSelect = document.getElementById('templateTypeInput');
  const messageInput = document.getElementById('templateMessageInput');
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
    if (typeSelect) typeSelect.value = template.type || 'both';
    if (messageInput) messageInput.value = template.message;

    if (template.image) {
      currentEditingImage = template.image;
      if (previewImg) previewImg.src = template.image;
      if (previewWrap) previewWrap.style.display = 'flex';
      if (emptyWrap) emptyWrap.style.display = 'none';
    } else {
      if (previewWrap) previewWrap.style.display = 'none';
      if (emptyWrap) emptyWrap.style.display = 'flex';
    }
  } else {
    if (title) title.textContent = 'Nueva plantilla';
    if (nameInput) nameInput.value = '';
    if (typeSelect) typeSelect.value = 'both';
    if (messageInput) messageInput.value = '';
    if (previewWrap) previewWrap.style.display = 'none';
    if (emptyWrap) emptyWrap.style.display = 'flex';
  }

  if (charCount && messageInput) {
    charCount.textContent = String(messageInput.value.length);
  }

  modal.style.display = 'flex';
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
  const typeSelect = document.getElementById('templateTypeInput');
  const messageInput = document.getElementById('templateMessageInput');

  if (!nameInput || !typeSelect || !messageInput) return;

  const name = nameInput.value.trim();
  const type = typeSelect.value;
  const message = messageInput.value.trim();

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
    id: currentEditingId || generateId(), name, category: inferCategory(name), type, message,
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
  setSendModalValues({
    message,
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
  const phone = digits.startsWith('51') || digits.length !== 9 ? digits : `51${digits}`;
  const email = String(contact?.email || contact?.correo || '').trim();
  const template = templates.find(item => item.type === 'both' || item.type === initialTab) || templates[0];
  const message = replaceVariables(template?.message || '', contact?.name || '', contact?.company || contact?.empresa || '');

  modal.dataset.templateId = template?.id || '';
  currentSendContact = contact;
  contactSendResolved = false;
  const contactName = document.getElementById('sendMessageContactName');
  if (contactName) contactName.textContent = contact?.name || phone || email || 'Contacto';
  setSendModalValues({
    phone,
    email,
    message,
    subject: template?.name || '',
    image: template?.image || null
  });
  renderSendTemplateList(template?.id);
  switchSendTab(initialTab);
  modal.style.display = 'grid';
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

/** Cierra todos los menus desplegables del filtro. */
function closeAllStfMenus(except = null) {
  ['stfRubroDropdown', 'stfSpeechDropdown', 'stfPrecioDropdown'].forEach(id => {
    if (id === except) return;
    const wrap = document.getElementById(id);
    if (!wrap) return;
    wrap.querySelector('.stf-dropdown-menu')?.classList.remove('is-open');
    const btn = wrap.querySelector('.stf-dropdown-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

/** Genera las opciones de un menu a partir de un Set de valores. */
function buildStfMenu(menuEl, values, currentValue, onSelect) {
  if (!menuEl) return;
  menuEl.innerHTML = '';
  const allLi = document.createElement('li');
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.textContent = 'Todos';
  if (!currentValue) allBtn.classList.add('is-selected');
  allBtn.addEventListener('click', () => onSelect(''));
  allLi.appendChild(allBtn);
  menuEl.appendChild(allLi);
  [...values].forEach(val => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = val;
    if (val === currentValue) btn.classList.add('is-selected');
    btn.addEventListener('click', () => onSelect(val));
    li.appendChild(btn);
    menuEl.appendChild(li);
  });
}

/** Actualiza el label y el estado visual del boton segun si hay filtro activo. */
function updateStfBtnState(btnId, labelId, defaultLabel, activeValue) {
  const btn = document.getElementById(btnId);
  const lbl = document.getElementById(labelId);
  if (!btn || !lbl) return;
  if (activeValue) {
    lbl.textContent = activeValue;
    btn.classList.add('is-active');
  } else {
    lbl.textContent = defaultLabel;
    btn.classList.remove('is-active');
  }
}

/** Muestra u oculta el boton "Limpiar filtros" segun si algun filtro esta activo. */
function syncClearBtn() {
  const btn = document.getElementById('stfClearFiltersBtn');
  if (!btn) return;
  const anyActive = activeFilters.rubro || activeFilters.speech || activeFilters.precio;
  btn.hidden = !anyActive;
}

/** Inicializa o refresca los tres dropdowns de filtro. */
function refreshStfDropdowns() {
  const rubroBtnEl  = document.getElementById('stfRubroBtn');
  const speechBtnEl = document.getElementById('stfSpeechBtn');
  const precioBtnEl = document.getElementById('stfPrecioBtn');
  if (!rubroBtnEl) return;

  const rubros   = new Set(templates.map(t => t.category || 'Otros').filter(Boolean));
  const speeches = new Set(templates.map(inferSpeech).filter(Boolean));
  const precios  = new Set(templates.map(inferPrecio).filter(Boolean));

  const refresh = () => {
    renderSendTemplateList(document.getElementById('sendMessageModal')?.dataset.templateId || '');
  };

  buildStfMenu(document.getElementById('stfRubroMenu'), rubros, activeFilters.rubro, (val) => {
    activeFilters.rubro = val;
    updateStfBtnState('stfRubroBtn', 'stfRubroLabel', 'Rubro', val);
    closeAllStfMenus();
    rubroBtnEl.setAttribute('aria-expanded', 'false');
    syncClearBtn();
    refresh();
  });

  buildStfMenu(document.getElementById('stfSpeechMenu'), speeches, activeFilters.speech, (val) => {
    activeFilters.speech = val;
    updateStfBtnState('stfSpeechBtn', 'stfSpeechLabel', 'Speech', val);
    closeAllStfMenus();
    speechBtnEl.setAttribute('aria-expanded', 'false');
    syncClearBtn();
    refresh();
  });

  buildStfMenu(document.getElementById('stfPrecioMenu'), precios, activeFilters.precio, (val) => {
    activeFilters.precio = val;
    updateStfBtnState('stfPrecioBtn', 'stfPrecioLabel', 'Precio', val);
    closeAllStfMenus();
    precioBtnEl.setAttribute('aria-expanded', 'false');
    syncClearBtn();
    refresh();
  });

  updateStfBtnState('stfRubroBtn',  'stfRubroLabel',  'Rubro',  activeFilters.rubro);
  updateStfBtnState('stfSpeechBtn', 'stfSpeechLabel', 'Speech', activeFilters.speech);
  updateStfBtnState('stfPrecioBtn', 'stfPrecioLabel', 'Precio', activeFilters.precio);
  syncClearBtn();
}

function renderSendTemplateList(selectedId = '') {
  const list = document.getElementById('sendMessageTemplates');
  const count = document.getElementById('sendTemplateCount');
  const search = document.getElementById('sendTemplateSearch');
  const resultCount = document.getElementById('sendTemplateResultCount');
  if (!list) return;

  if (count) count.textContent = String(templates.length);

  refreshStfDropdowns();
  list.replaceChildren();

  if (!templates.length) {
    const empty = document.createElement('p');
    empty.className = 'send-template-empty';
    empty.textContent = 'No hay plantillas en la base de datos. Haz clic en "+ Nueva" para crear una.';
    list.appendChild(empty);
    if (resultCount) resultCount.textContent = '0 plantillas';
    return;
  }

  const query = String(search?.value || '').trim().toLocaleLowerCase('es');

  const visibleTemplates = sortTemplates(templates.filter(template => {
    if (activeFilters.rubro && (template.category || 'Otros') !== activeFilters.rubro) return false;
    if (activeFilters.speech && inferSpeech(template) !== activeFilters.speech) return false;
    if (activeFilters.precio && inferPrecio(template) !== activeFilters.precio) return false;
    if (query) {
      const searchable = `${template.name} ${template.message} ${template.category || ''}`.toLocaleLowerCase('es');
      if (!searchable.includes(query)) return false;
    }
    return true;
  }));

  if (resultCount) {
    const anyFilter = activeFilters.rubro || activeFilters.speech || activeFilters.precio || query;
    resultCount.textContent = anyFilter
      ? `${visibleTemplates.length} de ${templates.length} plantillas`
      : `${templates.length} plantillas`;
  }

  if (!visibleTemplates.length) {
    const empty = document.createElement('p');
    empty.className = 'send-template-empty';
    empty.textContent = 'No hay plantillas que coincidan con esos filtros.';
    list.appendChild(empty);
    return;
  }

  visibleTemplates.forEach(template => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'send-template-option';
    button.classList.toggle('is-selected', template.id === selectedId);
    button.dataset.sendTemplateId = template.id;

    const hasImage = Boolean(template.image);
    const typeLabel = template.type === 'email' ? 'Correo' :
                      template.type === 'whatsapp' ? 'WhatsApp' : 'WhatsApp y Correo';

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
        </div>
      </div>
      <div class="send-template-option-bottom">
        <small class="template-category-tag">${escapeHtml(template.category || "Otros")}</small>
        <small class="type-tag">${typeLabel}</small>
        ${hasImage ? `<span class="has-img-chip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:3px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Con imagen</span>` : ""}
      </div>
    `;

    list.appendChild(button);
  });
}

function applySendTemplate(templateId) {
  const template = templates.find(item => item.id === templateId);
  if (!template) return;

  const message = replaceVariables(
    template.message,
    currentSendContact?.name || '',
    currentSendContact?.company || currentSendContact?.empresa || ''
  );

  setSendModalValues({
    phone: document.getElementById('sendWhatsAppNumber')?.value || '',
    email: document.getElementById('sendEmailAddress')?.value || '',
    message,
    subject: template.name,
    image: template.image || null
  });

  const modal = document.getElementById('sendMessageModal');
  if (modal) modal.dataset.templateId = template.id;
  renderSendTemplateList(template.id);
}

function setSendModalValues({ phone = '', email = '', message = '', subject = '', image = null }) {
  const phoneInput = document.getElementById('sendWhatsAppNumber');
  const emailInput = document.getElementById('sendEmailAddress');
  const subjectInput = document.getElementById('sendEmailSubject');
  const waMessage = document.getElementById('sendWhatsAppMessage');
  const emailMessage = document.getElementById('sendEmailMessage');

  if (phoneInput && phone) phoneInput.value = phone;
  if (emailInput && email) emailInput.value = email;
  if (subjectInput && subject) subjectInput.value = subject;
  if (waMessage) waMessage.value = message;
  if (emailMessage) emailMessage.value = message;

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
}

function switchSendTab(tab) {
  const waTab = document.getElementById('tabWhatsAppBtn');
  const emailTab = document.getElementById('tabEmailBtn');
  const waContent = document.getElementById('whatsappContent');
  const emailContent = document.getElementById('emailContent');

  if (!waTab || !emailTab || !waContent || !emailContent) return;

  if (tab === 'whatsapp') {
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

  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;

  const waWindow = window.open(waUrl, '_blank');
  const opened = Boolean(waWindow);
  // El estado se registra para el contacto de la fila, no para el número tecleado.
  recordSendStatus(currentSendContact?.phone || phone, opened ? 'sent' : 'failed', 'whatsapp');
  contactSendResolved = true;
  if (!opened) {
    showToast('El navegador bloqueó WhatsApp Web. Permite las ventanas emergentes y reintenta.', 'warning');
    return;
  }
  closeSendModal();
}

function sendEmail() {
  const emailInput = document.getElementById('sendEmailAddress');
  const subjectInput = document.getElementById('sendEmailSubject');
  const messageInput = document.getElementById('sendEmailMessage');

  if (!emailInput || !messageInput) return;

  const email = emailInput.value.trim();
  const subject = subjectInput ? subjectInput.value.trim() : 'Mensaje';
  const message = messageInput.value.trim();

  if (!email) {
    showToast('Por favor ingresa una dirección de email.', 'warning');
    emailInput.focus();
    return;
  }

  if (!isValidEmail(email)) {
    showToast('Por favor ingresa un email válido.', 'warning');
    emailInput.focus();
    return;
  }

  if (!message) {
    showToast('Por favor ingresa un mensaje.', 'warning');
    messageInput.focus();
    return;
  }

  if (currentSendImage) {
    copyImageToClipboard(currentSendImage).then(copied => {
      if (copied) {
        showToast('📋 Imagen copiada al portapapeles para pegarla en tu correo.', 'info');
      }
    });
  }

  const mailtoUrl = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
  window.location.href = mailtoUrl;
  recordSendStatus(currentSendContact?.phone || email, 'sent', 'email');
  contactSendResolved = true;
  closeSendModal();
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

  // Dropdown toggle buttons (Rubro / Speech / Precio)
  ['stfRubroBtn', 'stfSpeechBtn', 'stfPrecioBtn'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const dropId = btn.id.replace('Btn', 'Dropdown');
    const menuId = btn.id.replace('Btn', 'Menu');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById(menuId);
      const isOpen = menu?.classList.contains('is-open');
      closeAllStfMenus(isOpen ? null : dropId);
      menu?.classList.toggle('is-open', !isOpen);
      btn.setAttribute('aria-expanded', String(!isOpen));
    });
  });

  // Clear all filters button
  const clearBtn = document.getElementById('stfClearFiltersBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.rubro = '';
      activeFilters.speech = '';
      activeFilters.precio = '';
      updateStfBtnState('stfRubroBtn',  'stfRubroLabel',  'Rubro',  '');
      updateStfBtnState('stfSpeechBtn', 'stfSpeechLabel', 'Speech', '');
      updateStfBtnState('stfPrecioBtn', 'stfPrecioLabel', 'Precio', '');
      syncClearBtn();
      renderSendTemplateList(sendModal?.dataset.templateId || '');
    });
  }

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#stfDropdownRow')) {
      closeAllStfMenus();
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
      openTemplateModal();
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

  // Chips para insertar variables {nombre} y {empresa}
  document.querySelectorAll('.template-vars-row .var-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const variable = chip.dataset.var;
      if (!variable || !templateMessageInput) return;
      const start = templateMessageInput.selectionStart || templateMessageInput.value.length;
      const end = templateMessageInput.selectionEnd || templateMessageInput.value.length;
      const val = templateMessageInput.value;
      templateMessageInput.value = val.substring(0, start) + variable + val.substring(end);
      templateMessageInput.focus();
      templateMessageInput.selectionStart = templateMessageInput.selectionEnd = start + variable.length;
      if (templateCharCount) {
        updateCharCount(templateMessageInput, templateCharCount, 1000);
      }
    });
  });

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

  // Email image attach/copy/remove buttons
  const emailAttachBtn = document.getElementById('sendEmailAttachBtn');
  const emailImageFileInput = document.getElementById('sendEmailImageInput');
  const emailCopyBtn = document.getElementById('sendEmailCopyImageBtn');
  const emailRemoveBtn = document.getElementById('sendEmailRemoveImageBtn');

  if (emailAttachBtn && emailImageFileInput) {
    emailAttachBtn.addEventListener('click', () => emailImageFileInput.click());
    emailImageFileInput.addEventListener('change', () => {
      if (emailImageFileInput.files && emailImageFileInput.files[0]) {
        handleSendImageSelect(emailImageFileInput.files[0]);
      }
    });
  }

  if (emailCopyBtn) {
    emailCopyBtn.addEventListener('click', copySendImage);
  }

  if (emailRemoveBtn) {
    emailRemoveBtn.addEventListener('click', removeSendImage);
  }

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
  editTemplate,
  deleteTemplate,
  saveTemplate,
  closeTemplateModal,
  closeSendModal
};
