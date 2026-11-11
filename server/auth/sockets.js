export function installSocketAuth(io, auth, { onAdminSubscribe } = {}) {
  const deny = (socket, next, reason, message) => {
    socket.emit("session:error", { reason, message });
    next(new Error(reason));
  };
  io.use(async (socket, next) => {
    if (socket.handshake.auth?.client !== "dashboard") return next();
    try {
      if (!auth.validOrigin(socket.request)) return next(new Error("AUTH_ORIGIN"));
      const user = await auth.resolve(socket.request);
      if (!user) return next(new Error("AUTH_REQUIRED"));
      if (socket.handshake.auth.userId !== undefined && String(socket.handshake.auth.userId) !== String(user.id)) {
        return next(new Error("AUTH_CHANGED"));
      }
      socket.data.authUser = user;
      socket.join(`auth:${user.tokenHash}`);
      next();
    } catch { next(new Error("AUTH_UNAVAILABLE")); }
  });
  io.on("connection", socket => {
    socket.use(async ([event, payload], next) => {
      if (["session:create", "session:join"].includes(event)
          && payload !== undefined && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
        return deny(socket, next, "INVALID_PAYLOAD", "Solicitud inválida.");
      }
      // Android has its own per-device credential, checked by session:join.
      if (event === "session:join" && payload?.role === "phone") return next();
      if (socket.data.role === "phone" && event !== "session:create" && event !== "session:join"
          && event !== "admin:subscribe") return next();
      try {
        if (!auth.validOrigin(socket.request)) return deny(socket, next, "AUTH_ORIGIN", "Origen no autorizado.");
        const user = await auth.resolve(socket.request);
        if (!user) return deny(socket, next, "AUTH_REQUIRED", "Inicia sesión para continuar.");
        socket.data.authUser = user;
        socket.join(`auth:${user.tokenHash}`);
        if (event === "admin:subscribe") {
          if (user.role !== "ADMINISTRADOR") return deny(socket, next, "FORBIDDEN", "Acceso exclusivo de administrador.");
        } else if (event !== "session:create") {
          const code = event === "session:join" ? String(payload?.code || "").trim().toUpperCase() : socket.data.code;
          if (!await auth.canAccess(user, code)) return deny(socket, next, "SESSION_FORBIDDEN", "No tienes acceso a esta sesión operativa.");
        }
        next();
      } catch { deny(socket, next, "AUTH_UNAVAILABLE", "No se pudo validar el acceso."); }
    });
    // Packet middleware rejects are expected and must not become unhandled errors.
    socket.on("error", () => {});
    socket.on("admin:subscribe", async acknowledge => {
      if (socket.data.authUser?.role !== "ADMINISTRADOR") return;
      socket.join("admin:network");
      try { await onAdminSubscribe?.(socket); }
      catch { socket.emit("admin:network", { unavailable: true }); }
      if (typeof acknowledge === "function") acknowledge({ ok: true });
    });
  });

  // Revoke passive sockets too: they must stop receiving data without sending a packet.
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      for (const socket of io.sockets.sockets.values()) {
        if (!socket.data.authUser || socket.data.role === "phone") continue;
        const user = await auth.resolve(socket.request, false);
        if (!user || (socket.data.code && !await auth.canAccess(user, socket.data.code))
            || (socket.rooms.has("admin:network") && user.role !== "ADMINISTRADOR")) {
          socket.emit("session:error", { reason: "AUTH_REQUIRED", message: "Tu acceso ha caducado. Inicia sesión de nuevo." });
          socket.disconnect(true);
        }
      }
    } catch {
      for (const socket of io.sockets.sockets.values()) {
        if (socket.data.authUser && socket.data.role !== "phone") socket.disconnect(true);
      }
    } finally { checking = false; }
  }, 5000);
  timer.unref();
  return tokenHash => io.in(`auth:${tokenHash}`).disconnectSockets(true);
}
