import { createHash } from "node:crypto";
import path from "node:path";

const hash = value => createHash("sha256").update(value).digest("hex");
export function runtimeIdentity(env, root) {
  const project = path.resolve(root);
  return hash(JSON.stringify([process.platform === "win32" ? project.toLowerCase() : project,
    process.platform === "win32" ? String(env.DB_NAME || "").toLowerCase() : env.DB_NAME || "",
    Number(env.DB_PORT || 3306), Number(env.PORT || 3000)]));
}
export function runtimeLockName(env) {
  // Named MySQL locks are server-wide, so isolate unrelated databases.
  return "voip_vc_" + hash(String(env.DB_NAME || "").toLowerCase()).slice(0, 40);
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
