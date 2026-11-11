import { defineConfig } from "vite";
export default defineConfig({
  base: "/panel/",
  server: { port: 5173, proxy: {
    "/socket.io": { target: process.env.PANEL_API_TARGET || "http://127.0.0.1:3000", ws: true, changeOrigin: false },
    "/api": { target: process.env.PANEL_API_TARGET || "http://127.0.0.1:3000", changeOrigin: false },
    "/login": { target: process.env.PANEL_API_TARGET || "http://127.0.0.1:3000", changeOrigin: false }
  }},
  build: { outDir: "dist", emptyOutDir: true }
});
