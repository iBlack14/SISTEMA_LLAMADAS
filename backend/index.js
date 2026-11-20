import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureConsoleLogging } from "./shared/console-logger.js";

configureConsoleLogging();

// Load the app after the logger is active so even module startup messages use the same format.
const { createRuntime } = await import("./create-runtime.js");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { services } = createRuntime(projectRoot);
configureConsoleLogging();
services.bootstrap().catch(error => {
  console.error("Fallo critico al iniciar el servidor:", error);
  process.exit(1);
});
process.once("SIGTERM", () => services.gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => services.gracefulShutdown("SIGINT"));
