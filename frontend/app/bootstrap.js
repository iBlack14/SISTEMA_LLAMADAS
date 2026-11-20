import { createDashboardApp } from "./dashboard.js?v=20261119-users-ui3";

// Única entrada del dashboard; los módulos no arrancan otras instancias.
createDashboardApp().start();
