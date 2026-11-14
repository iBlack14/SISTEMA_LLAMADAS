import path from "path";
import fs from "fs";

/**
 * createApkManager: conserva los contratos y reglas existentes.
 * Dependencias: runtime.APK_PATHS, runtime.APK_SEARCH_DIRS.
 * Se construye una vez por proceso.
 */
export function createApkManager(runtime, services) {
function walkDirForApk(dir, out) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDirForApk(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".apk")) {
      out.push(full);
    }
  }
}

function parseApkVersion(fileName) {
  const base = fileName.replace(/\.apk$/i, "");
  const semver = base.match(/(\d+\.\d+\.\d+(?:[-+._]?[a-zA-Z0-9]+)*)/);
  if (semver) return semver[1].replace(/_/g, ".");

  const vTag = base.match(/(?:^|[-_])v(\d+(?:[._]\d+)*)/i);
  if (vTag) return `v${vTag[1].replace(/_/g, ".")}`;

  if (/release/i.test(base)) return "release";
  if (/debug/i.test(base)) return "debug";
  return "custom";
}

function getAvailableApks() {
  const found = [];
  for (const dir of runtime.APK_SEARCH_DIRS) {
    walkDirForApk(dir, found);
  }
  for (const p of runtime.APK_PATHS) {
    if (fs.existsSync(p)) found.push(p);
  }

  const unique = [...new Set(found.map(p => path.resolve(p)))];
  const versions = unique
    .filter(p => fs.existsSync(p))
    .map((p) => {
      const stat = fs.statSync(p);
      const file = path.basename(p);
      const version = parseApkVersion(file);
      const type = /release/i.test(file) ? "release" : (/debug/i.test(file) ? "debug" : "custom");
      return {
        id: Buffer.from(p).toString("base64url"),
        name: file,
        version,
        type,
        size: stat.size,
        sizeKb: Math.round(stat.size / 1024),
        modified: stat.mtime,
        fullPath: p
      };
    })
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  return versions;
}

function getApkById(id) {
  if (!id) return null;
  const versions = getAvailableApks();
  return versions.find(v => v.id === id) || null;
}
return { walkDirForApk, parseApkVersion, getAvailableApks, getApkById };
}
