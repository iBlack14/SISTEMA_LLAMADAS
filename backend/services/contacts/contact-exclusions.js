import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultConfig = {
  excludedPrefixes: ["116", "105", "115", "114", "106", "111", "113", "0800", "0801", "911"],
  excludedNumbers: ["116", "105", "115", "114"],
  excludedNameKeywords: [
    "hospital", "hospitals", "hospitales", "hospitalario", "hospitalaria", "hospitalarios", "hospitalarias",
    "clinic", "clinics", "clínica", "clínicas", "medical center", "medical centre",
    "medical centers", "medical centres", "centro médico", "centros médicos", "centro de salud",
    "centros de salud", "health center", "health centre", "health centers", "health centres",
    "police", "police station", "police department", "law enforcement", "policía", "policía nacional",
    "comisaría", "comisarías", "comisarias", "municipal", "municipality", "municipalities",
    "municipal office", "municipalidad", "municipalidades", "serenazgo", "public safety",
    "seguridad ciudadana", "fire department", "fire station", "firefighter", "bomberos",
    "emergency", "emergencies", "emergency services", "emergency room", "emergency department",
    "emergencia", "emergencias", "urgencia", "urgencias", "ambulance", "ambulancia"
  ]
};

function loadConfig() {
  try {
    const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../config/excluded-numbers.json");
    return { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
  } catch {
    return defaultConfig;
  }
}

const config = loadConfig();
const excludedNumbers = new Set((config.excludedNumbers || []).map(value => String(value).replace(/\D/g, "")));
const excludedPrefixes = (config.excludedPrefixes || []).map(value => String(value).replace(/\D/g, "")).filter(Boolean);
const excludedKeywords = (config.excludedNameKeywords || []).map(value => normalizeName(value)).filter(Boolean);

function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").trim();
}

export function isExcludedCampaignPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return excludedNumbers.has(digits) || excludedPrefixes.some(prefix => digits.startsWith(prefix));
}

export function isExcludedCampaignContact(contact = {}, listName = "") {
  if (isExcludedCampaignPhone(contact.rawPhone || contact.phone)) return true;
  const searchable = normalizeName([listName, contact.list, contact.name, contact.company].filter(Boolean).join(" "));
  return excludedKeywords.some(keyword => (` ${searchable} `).includes(` ${keyword} `));
}

