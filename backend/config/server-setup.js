// Extracción de server/server.js, líneas 98–115 y 234–236: se conservan exactamente
// las políticas y valores existentes; solo cambia su ubicación y se inyectan dependencias.
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";

// Una única instancia conserva los timeouts y la conexión con Android.
export function createServerSetup() {
const app = express();
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
const server = http.createServer(app);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://llamada.viacomunicativa.com,https://lm.viacomunicativa.com,http://localhost:3000";
const corsOptions = {
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean),
  methods: ["GET", "POST", "OPTIONS"],
  credentials: false
};
app.use(cors(corsOptions));
const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT_MS || 20000),
  pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS || 25000),
  connectTimeout: 45000,
  maxHttpBufferSize: Number(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || 1048576)
});
server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
return { app, server, io, CORS_ORIGIN };
}
