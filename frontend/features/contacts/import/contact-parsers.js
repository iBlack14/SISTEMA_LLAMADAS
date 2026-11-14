

/**
 * createContactParsers: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.makeId, dashboardActions.normalizeImportedPhone.
 * Se construye una vez por dashboard.
 */
export function createContactParsers(dashboardState, dashboardActions) {
function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function mapRowByHeaders(row, headers) {
  const out = {};
  headers.forEach((header, index) => {
    out[header] = row[index];
  });
  return out;
}

function buildContactFromStructuredRow(row, fallbackIndex) {
  const entries = Object.entries(row || {});
  const normalized = Object.fromEntries(entries.map(([key, value]) => [normalizeHeader(key), String(value || "").trim()]));

  const rawName =
    normalized.name ||
    normalized.nombre ||
    normalized.company ||
    normalized.empresa ||
    normalized.businessname ||
    "";

  const rawPhone =
    normalized.mobilenumber ||
    normalized.mobile ||
    normalized.phone ||
    normalized.telefono ||
    normalized.telefono1 ||
    normalized.celular ||
    normalized.whatsapp ||
    normalized.tel ||
    "";

  const rawWebsite =
    normalized.website ||
    normalized.web ||
    normalized.url ||
    normalized.sitio ||
    "";

  const fallbackValues = entries.map(([, value]) => String(value || "").trim()).filter(Boolean);
  const detectedPhone = rawPhone || fallbackValues.find(v => /\+?\d[\d\s().-]{5,}/.test(v)) || "";
  if (!detectedPhone) return null;

  const detectedName =
    rawName ||
    fallbackValues.find(v => !/\+?\d[\d\s().-]{5,}/.test(v) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(v) && !/^https?:\/\//i.test(v) && !/^tel:/i.test(v)) ||
    `Contacto ${fallbackIndex + 1}`;

  const noteParts = [];
  if (rawWebsite) noteParts.push(rawWebsite);
  for (const value of fallbackValues) {
    if (value === detectedName || value === detectedPhone || value === rawWebsite) continue;
    if (!noteParts.includes(value)) noteParts.push(value);
  }

  return {
    id: dashboardActions.makeId(),
    name: detectedName,
    phone: dashboardActions.normalizeImportedPhone(detectedPhone),
    note: noteParts.join(" ").trim()
  };
}

function buildContactFromTableArrayRow(row, fallbackIndex) {
  const values = (row || []).map((value) => String(value || "").trim());
  if (!values.length) return null;

  const first = values[0] || "";
  const second = values[1] || "";
  const third = values[2] || "";
  const fourth = values[3] || "";

  const firstIsPhone = /\+?\d[\d\s().-]{5,}/.test(first);
  const secondIsPhone = /\+?\d[\d\s().-]{5,}/.test(second);

  const detectedName = !firstIsPhone && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(first)
    ? first
    : (!secondIsPhone && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(second) ? second : `Contacto ${fallbackIndex + 1}`);

  const detectedPhone = secondIsPhone
    ? second
    : (firstIsPhone ? first : "");

  if (!detectedPhone) return null;

  const noteParts = [third, fourth]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return {
    id: dashboardActions.makeId(),
    name: detectedName,
    phone: dashboardActions.normalizeImportedPhone(detectedPhone),
    note: noteParts.join(" ").trim()
  };
}

function extractContactsFromHtmlTable(doc) {
  const tables = [...doc.querySelectorAll("table")];
  for (const table of tables) {
    const rows = [...table.querySelectorAll("tr")];
    if (rows.length < 2) continue;

    const headerCells = [...rows[0].querySelectorAll("th,td")].map((cell) => normalizeHeader(cell.textContent || ""));
    const nameIdx = headerCells.findIndex((header) => ["name", "nombre", "company", "empresa", "businessname"].includes(header));
    const phoneIdx = headerCells.findIndex((header) => ["mobilenumber", "mobile", "phone", "telefono", "celular", "tel", "whatsapp"].includes(header));
    const websiteIdx = headerCells.findIndex((header) => ["website", "web", "url", "sitio"].includes(header));

    if (nameIdx === -1 && phoneIdx === -1) continue;

    const contacts = [];
    for (const row of rows.slice(1)) {
      const cols = [...row.querySelectorAll("th,td")].map((cell) => String(cell.textContent || "").trim());
      if (!cols.some(Boolean)) continue;

      const name = String(cols[nameIdx] || "").trim();
      const phone = dashboardActions.normalizeImportedPhone(cols[phoneIdx] || "");
      const website = websiteIdx >= 0 ? String(cols[websiteIdx] || "").trim() : "";

      if (!phone) continue;
      contacts.push({
        id: dashboardActions.makeId(),
        name: name || `Contacto ${contacts.length + 1}`,
        phone,
        note: website
      });
    }

    if (contacts.length) return contacts;
  }

  return [];
}

function extractContactsFromRows(rows) {
  const out = [];
  const list = rows || [];
  if (!list.length) return out;

  const firstRow = list[0];
  const headerCandidates = Array.isArray(firstRow) ? firstRow.map(normalizeHeader) : Object.keys(firstRow || {}).map(normalizeHeader);
  const hasStructuredHeaders = headerCandidates.some((header) =>
    ["name", "nombre", "mobilenumber", "mobile", "phone", "telefono", "celular", "website", "web", "url"].includes(header)
  );

  const structuredRows = hasStructuredHeaders
    ? list.slice(1).map((row) => Array.isArray(row) ? mapRowByHeaders(row, firstRow) : row)
    : list;

  for (const row of structuredRows) {
    if (Array.isArray(row)) {
      const tableContact = buildContactFromTableArrayRow(row, out.length);
      if (tableContact?.phone) {
        out.push(tableContact);
        continue;
      }
    }
    const contact = buildContactFromStructuredRow(row, out.length);
    if (!contact?.phone) continue;
    out.push(contact);
  }
  return out;
}

function parseDelimitedText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const rows = lines.map((line) => {
    if (line.includes("\t")) return line.split("\t");
    if (line.includes(";")) return line.split(";");
    return line.split(",");
  });
  return extractContactsFromRows(rows);
}
return { normalizeHeader, mapRowByHeaders, buildContactFromStructuredRow, buildContactFromTableArrayRow, extractContactsFromHtmlTable, extractContactsFromRows, parseDelimitedText };
}
