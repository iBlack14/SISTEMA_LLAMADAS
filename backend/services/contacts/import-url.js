import net from "net";
import dns from "dns/promises";

/**
 * createImportUrl: conserva los contratos y reglas existentes.
 * Dependencias: .
 * Se construye una vez por proceso.
 */
export function createImportUrl(runtime, services) {
function isPrivateNetworkAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc")
      || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("ff") || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

async function validatePublicImportUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || "")); }
  catch { throw Object.assign(new Error("URL invalida."), { statusCode: 400 }); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw Object.assign(new Error("Solo se permiten URLs HTTP o HTTPS."), { statusCode: 400 });
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw Object.assign(new Error("No se permiten direcciones locales o internas."), { statusCode: 400 });
  }
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateNetworkAddress(entry.address))) {
    throw Object.assign(new Error("La URL apunta a una red privada o no permitida."), { statusCode: 400 });
  }
  return parsed.toString();
}
return { isPrivateNetworkAddress, validatePublicImportUrl };
}
