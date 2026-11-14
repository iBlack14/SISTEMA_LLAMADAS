/**
 * Sistema de plantillas de mensajes
 * Gestiona plantillas, modales y envío de WhatsApp/Email
 */

const STORAGE_KEY = 'voip_message_templates';

// ============================================================================
// STATE
// ============================================================================
let templates = [];
let currentEditingId = null;
let initialized = false;
let currentSendContact = null;

// ============================================================================
// INIT
// ============================================================================
export function init() {
  if (initialized) return;
  initialized = true;
  loadTemplates();
  initializeSampleTemplates();
  bindEvents();
  renderTemplates();
}

// ============================================================================
// STORAGE
// ============================================================================
function loadTemplates() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    templates = stored ? JSON.parse(stored) : [];
  } catch (err) {
    console.error('Error cargando plantillas:', err);
    templates = [];
  }
}

function saveTemplates() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
  } catch (err) {
    console.error('Error guardando plantillas:', err);
    alert('Error al guardar plantillas. Verifica el espacio disponible.');
  }
}

function initializeSampleTemplates() {
  // Add sample templates only if storage is empty
  if (templates.length === 0) {
    templates = [
      {
        id: generateId(),
        name: 'Seguimiento de propuesta',
        type: 'both',
        message: 'Hola {nombre}, espero que estés muy bien. Te escribo para hacerte seguimiento a la propuesta que te envié para {empresa}. ¿Tienes alguna duda al respecto?',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: generateId(),
        name: 'Recordatorio de reunión',
        type: 'whatsapp',
        message: 'Hola {nombre}! Te recuerdo que tenemos programada una reunión mañana a las 10:00 AM para hablar sobre el proyecto de {empresa}. ¿Sigues disponible?',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: generateId(),
        name: 'Agradecimiento',
        type: 'email',
        message: 'Estimado/a {nombre},\n\nQuiero agradecerte por tu tiempo y confianza en nuestra reunión. Ha sido un placer conocer más sobre {empresa} y cómo podemos colaborar.\n\nQuedo atento a tus comentarios.\n\nSaludos cordiales',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];
    saveTemplates();
  }
}

// ============================================================================
// RENDER
// ============================================================================
function renderTemplates() {
  const container = document.getElementById('templatesListContainer');
  if (!container) return;

  if (templates.length === 0) {
    container.innerHTML = `
      <div class="templates-empty">
        No hay plantillas guardadas. Crea tu primera plantilla.
      </div>
    `;
    return;
  }

  container.innerHTML = templates.map(template => {
    const typeIcon = template.type === 'whatsapp' ? '📱' :
                     template.type === 'email' ? '📧' : '📱📧';
    const typeLabel = template.type === 'whatsapp' ? 'WhatsApp' :
                      template.type === 'email' ? 'Email' : 'Ambos';
    
    return `
      <div class="template-card" data-id="${template.id}">
        <div class="template-header">
          <h4>${escapeHtml(template.name)}</h4>
          <div class="template-actions">
            <button class="edit-template-btn" data-id="${template.id}" title="Editar">
              ✏️
            </button>
            <button class="delete-template-btn" data-id="${template.id}" title="Eliminar">
              🗑️
            </button>
          </div>
        </div>
        <div class="template-type">
          <span>${typeIcon} ${typeLabel}</span>
        </div>
        <div class="template-message">
          ${escapeHtml(template.message).substring(0, 100)}${template.message.length > 100 ? '...' : ''}
        </div>
        <div class="template-footer">
          ${template.type !== 'email' ? `
            <button class="send-whatsapp-btn primary" data-id="${template.id}">
              📱 Enviar WhatsApp
            </button>
          ` : ''}
          ${template.type !== 'whatsapp' ? `
            <button class="send-email-btn secondary" data-id="${template.id}">
              📧 Enviar Email
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Bind events para cada card
  container.querySelectorAll('.edit-template-btn').forEach(btn => {
    btn.addEventListener('click', () => editTemplate(btn.dataset.id));
  });

  container.querySelectorAll('.delete-template-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteTemplate(btn.dataset.id));
  });

  container.querySelectorAll('.send-whatsapp-btn').forEach(btn => {
    btn.addEventListener('click', () => openSendModal(btn.dataset.id, 'whatsapp'));
  });

  container.querySelectorAll('.send-email-btn').forEach(btn => {
    btn.addEventListener('click', () => openSendModal(btn.dataset.id, 'email'));
  });
}

// ============================================================================
// TEMPLATE MODAL (Create/Edit)
// ============================================================================
function openTemplateModal(templateId = null) {
  const modal = document.getElementById('templateModal');
  const title = document.getElementById('templateModalTitle');
  const nameInput = document.getElementById('templateNameInput');
  const typeSelect = document.getElementById('templateTypeInput');
  const messageInput = document.getElementById('templateMessageInput');
  const charCount = null; // Not in HTML yet

  if (!modal) return;

  currentEditingId = templateId;

  if (templateId) {
    // Edit mode
    const template = templates.find(t => t.id === templateId);
    if (!template) return;

    title.textContent = 'Editar plantilla';
    nameInput.value = template.name;
    typeSelect.value = template.type;
    messageInput.value = template.message;
  } else {
    // Create mode
    title.textContent = 'Nueva plantilla';
    nameInput.value = '';
    typeSelect.value = 'both';
    messageInput.value = '';
  }

  if (charCount) {
    updateCharCount(messageInput, charCount);
  }
  modal.style.display = 'flex';
}

function closeTemplateModal() {
  const modal = document.getElementById('templateModal');
  if (modal) {
    modal.style.display = 'none';
    currentEditingId = null;
  }
}

function saveTemplate() {
  const nameInput = document.getElementById('templateNameInput');
  const typeSelect = document.getElementById('templateTypeInput');
  const messageInput = document.getElementById('templateMessageInput');

  if (!nameInput || !typeSelect || !messageInput) return;

  const name = nameInput.value.trim();
  const type = typeSelect.value;
  const message = messageInput.value.trim();

  if (!name) {
    alert('Por favor ingresa un nombre para la plantilla.');
    nameInput.focus();
    return;
  }

  if (!message) {
    alert('Por favor ingresa el mensaje de la plantilla.');
    messageInput.focus();
    return;
  }

  if (currentEditingId) {
    // Update existing
    const template = templates.find(t => t.id === currentEditingId);
    if (template) {
      template.name = name;
      template.type = type;
      template.message = message;
      template.updatedAt = new Date().toISOString();
    }
  } else {
    // Create new
    templates.push({
      id: generateId(),
      name,
      type,
      message,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  saveTemplates();
  renderTemplates();
  closeTemplateModal();
}

function editTemplate(templateId) {
  openTemplateModal(templateId);
}

function deleteTemplate(templateId) {
  const template = templates.find(t => t.id === templateId);
  if (!template) return;

  if (!confirm(`¿Eliminar la plantilla "${template.name}"?`)) {
    return;
  }

  templates = templates.filter(t => t.id !== templateId);
  saveTemplates();
  renderTemplates();
}

// ============================================================================
// SEND MESSAGE MODAL
// ============================================================================
function openSendModal(templateId, initialTab = 'whatsapp') {
  const template = templates.find(t => t.id === templateId);
  if (!template) return;

  const modal = document.getElementById('sendMessageModal');
  if (!modal) return;

  // Store current template in modal's dataset
  modal.dataset.templateId = templateId;

  const message = replaceVariables(template.message);
  setSendModalValues({ message, subject: template.name });
  currentSendContact = null;
  const contactName = document.getElementById('sendMessageContactName');
  if (contactName) contactName.textContent = 'Plantilla guardada';
  renderSendTemplateList(template.id);
  switchSendTab(initialTab);
  modal.style.display = 'grid';
}

function openContactSendModal(contact, initialTab = 'whatsapp') {
  init();
  const modal = document.getElementById('sendMessageModal');
  if (!modal) return;

  const digits = String(contact?.phone || '').replace(/\D/g, '');
  const phone = digits.startsWith('51') || digits.length !== 9 ? digits : `51${digits}`;
  const email = String(contact?.email || contact?.correo || '').trim();
  const template = templates.find(item => item.type === 'both' || item.type === initialTab);
  const message = replaceVariables(template?.message || '', contact?.name || '', contact?.company || contact?.empresa || '');

  modal.dataset.templateId = '';
  currentSendContact = contact;
  const contactName = document.getElementById('sendMessageContactName');
  if (contactName) contactName.textContent = contact?.name || phone || email || 'Contacto';
  setSendModalValues({ phone, email, message, subject: template?.name || '' });
  renderSendTemplateList(template?.id);
  switchSendTab(initialTab);
  modal.style.display = 'grid';
}

function renderSendTemplateList(selectedId = '') {
  const list = document.getElementById('sendMessageTemplates');
  const count = document.getElementById('sendTemplateCount');
  if (!list) return;

  if (count) count.textContent = String(templates.length);
  list.replaceChildren();
  if (!templates.length) {
    const empty = document.createElement('p');
    empty.className = 'send-template-empty';
    empty.textContent = 'Aún no tienes plantillas guardadas.';
    list.appendChild(empty);
    return;
  }

  templates.forEach(template => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'send-template-option';
    button.classList.toggle('is-selected', template.id === selectedId);
    button.dataset.sendTemplateId = template.id;

    const name = document.createElement('strong');
    name.textContent = template.name;
    const preview = document.createElement('span');
    preview.textContent = template.message;
    const type = document.createElement('small');
    type.textContent = template.type === 'email' ? 'Correo' : template.type === 'whatsapp' ? 'WhatsApp' : 'WhatsApp y correo';

    button.append(name, preview, type);
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
  const emailSubject = document.getElementById('sendEmailSubject');
  setSendModalValues({
    phone: document.getElementById('sendWhatsAppNumber')?.value || '',
    email: document.getElementById('sendEmailAddress')?.value || '',
    message,
    subject: template.name
  });
  if (emailSubject) emailSubject.value = template.name;
  const modal = document.getElementById('sendMessageModal');
  if (modal) modal.dataset.templateId = template.id;
  renderSendTemplateList(template.id);
}

function setSendModalValues({ phone = '', email = '', message = '', subject = '' }) {
  const phoneInput = document.getElementById('sendWhatsAppNumber');
  const emailInput = document.getElementById('sendEmailAddress');
  const subjectInput = document.getElementById('sendEmailSubject');
  const waMessage = document.getElementById('sendWhatsAppMessage');
  const emailMessage = document.getElementById('sendEmailMessage');

  if (phoneInput) phoneInput.value = phone;
  if (emailInput) emailInput.value = email;
  if (subjectInput) subjectInput.value = subject;
  if (waMessage) waMessage.value = message;
  if (emailMessage) emailMessage.value = message;

  updateCharCount(waMessage, document.getElementById('whatsappCharCount'));
  updateCharCount(emailMessage, document.getElementById('emailCharCount'));
}

function closeSendModal() {
  const modal = document.getElementById('sendMessageModal');
  if (modal) {
    modal.style.display = 'none';
    modal.dataset.templateId = '';
  }
  currentSendContact = null;
}

function switchSendTab(tab) {
  // Update tab buttons
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
// SEND WHATSAPP
// ============================================================================
function sendWhatsApp() {
  const phoneInput = document.getElementById('sendWhatsAppNumber');
  const messageInput = document.getElementById('sendWhatsAppMessage');

  if (!phoneInput || !messageInput) return;

  const phone = phoneInput.value.trim();
  const message = messageInput.value.trim();

  if (!phone) {
    alert('Por favor ingresa un número de WhatsApp.');
    phoneInput.focus();
    return;
  }

  if (!message) {
    alert('Por favor ingresa un mensaje.');
    messageInput.focus();
    return;
  }

  // Clean phone number (remove spaces, dashes, parentheses)
  const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');

  // Generate WhatsApp link
  const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;

  // Open in new tab
  window.open(waUrl, '_blank');

  // Close modal
  closeSendModal();
}

// ============================================================================
// SEND EMAIL
// ============================================================================
function sendEmail() {
  const emailInput = document.getElementById('sendEmailAddress');
  const subjectInput = document.getElementById('sendEmailSubject');
  const messageInput = document.getElementById('sendEmailMessage');

  if (!emailInput || !messageInput) return;

  const email = emailInput.value.trim();
  const subject = subjectInput ? subjectInput.value.trim() : 'Mensaje';
  const message = messageInput.value.trim();

  if (!email) {
    alert('Por favor ingresa una dirección de email.');
    emailInput.focus();
    return;
  }

  if (!isValidEmail(email)) {
    alert('Por favor ingresa una dirección de email válida.');
    emailInput.focus();
    return;
  }

  if (!message) {
    alert('Por favor ingresa un mensaje.');
    messageInput.focus();
    return;
  }

  // Generate mailto link
  const mailtoUrl = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;

  // Open default email client
  window.location.href = mailtoUrl;

  // Close modal
  closeSendModal();
}

// ============================================================================
// UTILITIES
// ============================================================================
function replaceVariables(message, name = '', company = '') {
  return message
    .replace(/\{nombre\}/gi, name || '[nombre]')
    .replace(/\{empresa\}/gi, company || '[empresa]');
}

function updateCharCount(textarea, countElement) {
  if (!textarea || !countElement) return;
  const length = textarea.value.length;
  countElement.textContent = `${length} caracteres`;
}

function generateId() {
  return `tpl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ============================================================================
// EVENT BINDINGS
// ============================================================================
function bindEvents() {
  // Create new template button
  const createBtn = document.getElementById('createTemplateBtn');
  if (createBtn) {
    createBtn.addEventListener('click', () => openTemplateModal());
  }

  // Template modal close
  const templateCloseBtn = document.getElementById('templateCloseBtn');
  if (templateCloseBtn) {
    templateCloseBtn.addEventListener('click', closeTemplateModal);
  }

  // Template modal save
  const templateSaveBtn = document.getElementById('templateSaveBtn');
  if (templateSaveBtn) {
    templateSaveBtn.addEventListener('click', saveTemplate);
  }

  // Template modal cancel
  const templateCancelBtn = document.getElementById('templateCancelBtn');
  if (templateCancelBtn) {
    templateCancelBtn.addEventListener('click', closeTemplateModal);
  }

  // Template message char count
  const templateMessageInput = document.getElementById('templateMessageInput');
  if (templateMessageInput) {
    templateMessageInput.addEventListener('input', () => {
      // Character count display not in current HTML
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
      updateCharCount(waMessageInput, waCharCount);
    });
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
      updateCharCount(emailMessageInput, emailCharCount);
    });
  }

  // Close modals on outside click
  const templateModal = document.getElementById('templateModal');
  const sendModal = document.getElementById('sendMessageModal');

  if (sendModal) {
    sendModal.addEventListener('click', event => {
      const option = event.target.closest('[data-send-template-id]');
      if (option) applySendTemplate(option.dataset.sendTemplateId);
    });
  }

  if (templateModal) {
    templateModal.addEventListener('click', (e) => {
      if (e.target === templateModal) {
        closeTemplateModal();
      }
    });
  }

  if (sendModal) {
    sendModal.addEventListener('click', (e) => {
      if (e.target === sendModal) {
        closeSendModal();
      }
    });
  }
}

// ============================================================================
// EXPORT
// ============================================================================
export { renderTemplates, openTemplateModal, openSendModal, openContactSendModal };
