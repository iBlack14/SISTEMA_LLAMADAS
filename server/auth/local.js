import { spawn } from "node:child_process";
import { prepareLocalDatabase, appEnvironment, projectRoot } from "./local-runtime.js";

try {
  const config = await prepareLocalDatabase();
  if (!process.argv.includes("--setup-only")) {
    console.log("Inicio de sesión: http://127.0.0.1:3101/login");
    console.log("Cuentas sintéticas: .auth-local/test-accounts.json (no compartir ni versionar).");
    const child = spawn(process.execPath, ["server/server.js"], {
      cwd: projectRoot, env: appEnvironment(config), windowsHide: true, stdio: "inherit"
    });
    child.on("error", error => { console.error(error.message); process.exitCode = 1; });
    child.on("exit", code => { process.exitCode = code || 0; });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
