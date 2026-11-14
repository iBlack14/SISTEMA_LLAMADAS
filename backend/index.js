import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./create-runtime.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { services } = createRuntime(projectRoot);
services.bootstrap().catch(error => {
  console.error("Fallo critico al iniciar el servidor:", error);
  process.exit(1);
});
process.once("SIGTERM", () => services.gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => services.gracefulShutdown("SIGINT"));
