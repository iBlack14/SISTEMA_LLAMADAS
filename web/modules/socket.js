import { requireLogin } from "./auth.js";
const user = await requireLogin();
const API_BASE = window.location.origin;

// Note: Assuming io is already available globally from the <script> tag in index.html
export const socket = io(API_BASE, { 
  auth: { client: "dashboard", userId: user.id },
  transports: ["websocket"],
  timeout: 60000
});
socket.on("connect_error", error => {
  if (error.message === "AUTH_REQUIRED") window.location.replace("/login");
  if (error.message === "AUTH_CHANGED") window.location.replace("/");
});
export { API_BASE };
