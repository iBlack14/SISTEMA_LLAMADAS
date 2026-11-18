import { createHash } from "node:crypto";
import path from "node:path";

const hash = value => createHash("sha256").update(value).digest("hex");
export function runtimeIdentity(env, root) {
  const project = path.resolve(root);
  return hash(JSON.stringify([process.platform === "win32" ? project.toLowerCase() : project,
    String(env.DB_HOST || "").toLowerCase(),
    process.platform === "win32" ? String(env.DB_NAME || "").toLowerCase() : env.DB_NAME || "",
    Number(env.DB_PORT || 3306), Number(env.PORT || 3000)]));
}
export function runtimeLockName(env) {
  // Named locks are scoped to a MySQL server, so identify the complete DB target.
  const target = [String(env.DB_HOST || "").toLowerCase(), Number(env.DB_PORT || 3306), String(env.DB_NAME || "").toLowerCase()];
  return "voip_vc_" + hash(JSON.stringify(target)).slice(0, 40);
}
export async function probeRuntime(port, identity) {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/health", {
      signal: AbortSignal.timeout(1200), redirect: "manual"
    });
    const data = await response.json().catch(() => ({}));
    return response.ok && data.ok && data.application === "voip-vc" && data.instance === identity
      ? "same" : "other";
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return "absent";
    if (error.name === "TimeoutError") return "other";
    return "absent";
  }
}
export async function waitForRuntime(port, identity) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await probeRuntime(port, identity);
    if (result !== "absent") return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return "absent";
}
