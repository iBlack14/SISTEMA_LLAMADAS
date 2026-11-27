import { nanoid } from "nanoid";
import { registerWorkspaceEvents } from "./workspace-events.js";
import { registerCallEvents } from "./call-events.js";
import { registerUtilityEvents } from "./utility-events.js";

// Identificador único de arranque del servidor: si cambia tras un deploy,
// el dashboard conectado detecta el cambio al reconectar y recarga la página.
const SERVER_BOOT_ID = nanoid(12);

export function registerSockets(runtime, services) {
  runtime.io.on("connection", socket => {
    socket.emit?.("app:version", { bootId: SERVER_BOOT_ID });
    registerWorkspaceEvents(runtime, services, socket);
    registerCallEvents(runtime, services, socket);
    registerUtilityEvents(runtime, services, socket);
  });
}
