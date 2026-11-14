import { createDashboardApp } from "./dashboard.js";

// Única entrada del dashboard; los módulos no arrancan otras instancias.
createDashboardApp().start();
