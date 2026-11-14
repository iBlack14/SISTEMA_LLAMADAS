import { registerWorkspaceEvents } from "./workspace-events.js";
import { registerCallEvents } from "./call-events.js";
import { registerUtilityEvents } from "./utility-events.js";

export function registerSockets(runtime, services) {
  runtime.io.on("connection", socket => {
    registerWorkspaceEvents(runtime, services, socket);
    registerCallEvents(runtime, services, socket);
    registerUtilityEvents(runtime, services, socket);
  });
}
