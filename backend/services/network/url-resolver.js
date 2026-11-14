import os from "os";

/**
 * createUrlResolver: conserva los contratos y reglas existentes.
 * Dependencias: .
 * Se construye una vez por proceso.
 */
export function createUrlResolver(runtime, services) {
function parseEnvUrlCandidates(rawValue) {
  const raw = String(rawValue || "").trim().replace(/^=+/, "");
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .filter((v) => /^https?:\/\//i.test(v));
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function getHostName(urlValue) {
  try {
    return new URL(urlValue).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isLocalNetworkHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return isLoopbackHost(normalized)
    || /^10\./.test(normalized)
    || /^192\.168\./.test(normalized)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized);
}

function isLikelyVirtualInterface(name) {
  const value = String(name || "").toLowerCase();
  return ["vethernet", "virtual", "vmware", "hyper-v", "loopback", "docker", "wsl"].some((part) => value.includes(part));
}

function rankLanAddress(address, interfaceName) {
  const ip = String(address || "").trim();
  const iface = String(interfaceName || "").trim().toLowerCase();

  let score = 0;
  if (/^192\.168\./.test(ip)) score += 50;
  else if (/^10\./.test(ip)) score += 40;
  else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) score += 30;

  if (iface.includes("wi-fi") || iface.includes("wifi") || iface.includes("wlan")) score += 15;
  if (iface === "ethernet" || iface.includes("ethernet")) score += 12;
  if (isLikelyVirtualInterface(iface)) score -= 100;

  return score;
}

function getFirstLanAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== "IPv4") continue;
      candidates.push({
        name,
        address: entry.address,
        score: rankLanAddress(entry.address, name)
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || "";
}

function getLocalLanBaseUrl(req) {
  // A loopback-only listener is reached from Android through adb reverse.
  // Advertising a LAN address here makes pairing succeed but the socket fail.
  if (isLoopbackHost(process.env.HOST)) return getRequestBaseUrl(req);

  const envCandidates = parseEnvUrlCandidates(process.env.LOCAL_LAN_BASE_URL);
  if (envCandidates.length) return envCandidates[0];

  const reqBase = getRequestBaseUrl(req);
  const reqUrl = new URL(reqBase);
  if (!isLoopbackHost(reqUrl.hostname)) return reqBase;

  const lanAddress = getFirstLanAddress();
  if (!lanAddress) return "";
  const port = reqUrl.port ? `:${reqUrl.port}` : "";
  return `${reqUrl.protocol}//${lanAddress}${port}`;
}

function pickConfiguredBase(req, envName) {
  const reqBase = getRequestBaseUrl(req);
  const reqHost = String(req.get("host") || "").toLowerCase();
  const candidates = parseEnvUrlCandidates(process.env[envName]);
  if (!candidates.length) return "";

  const byHost = candidates.find((candidate) => {
    try {
      return new URL(candidate).host.toLowerCase() === reqHost;
    } catch {
      return false;
    }
  });

  return byHost || candidates[0] || "";
}

function getAndroidApiBaseUrl(req) {
  const reqBase = getRequestBaseUrl(req);
  if (isLocalNetworkHost(getHostName(reqBase))) {
    return getLocalLanBaseUrl(req) || reqBase;
  }

  const publicBase = pickConfiguredBase(req, "PUBLIC_BASE_URL");
  if (publicBase) return publicBase;

  const localLanBase = getLocalLanBaseUrl(req);
  if (localLanBase) return localLanBase;

  if (reqBase) return reqBase;

  return "https://lm.viacomunicativa.com";
}

function getWebBaseUrl(req) {
  const reqBase = getRequestBaseUrl(req);
  if (isLocalNetworkHost(getHostName(reqBase))) {
    return getLocalLanBaseUrl(req) || reqBase;
  }

  const publicWebBase = pickConfiguredBase(req, "PUBLIC_WEB_BASE_URL");
  if (publicWebBase) return publicWebBase;

  if (reqBase) return reqBase;

  return "https://llamada.viacomunicativa.com";
}

function getPairingLink(req, code, token) {
  const webBase = getWebBaseUrl(req);
  const apiBase = getAndroidApiBaseUrl(req);
  return `${webBase}/pairing?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}&apiBase=${encodeURIComponent(apiBase)}`;
}
return { parseEnvUrlCandidates, getRequestBaseUrl, getHostName, isLoopbackHost, isLocalNetworkHost, isLikelyVirtualInterface, rankLanAddress, getFirstLanAddress, getLocalLanBaseUrl, pickConfiguredBase, getAndroidApiBaseUrl, getWebBaseUrl, getPairingLink };
}
