import { nanoid } from "nanoid";

/**
 * registerReservations: Manejo de reservas de contacto y cotizaciones agendadas.
 * Endpoints CRUD y emisión en tiempo real vía socket.
 */
export function registerReservations(runtime, services) {
  const { app, io, sessions } = runtime;
  const { saveSoon, getConnectedPhoneWorkers, sendPersistedDial, emitState } = services;

  // Obtener todas las reservas de una sesión
  app.get("/api/session/:code/reservations", (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    const reservations = Array.isArray(session.contactReservations) ? session.contactReservations : [];
    res.json({ ok: true, reservations });
  });

  // Crear una nueva reserva de cotización
  app.post("/api/session/:code/reservations", (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    const { phone, name, company, quote, price, date, time, notes, status } = req.body || {};
    const cleanPhone = String(phone || "").trim();
    if (!cleanPhone) {
      return res.status(400).json({ ok: false, error: "El número de teléfono es obligatorio" });
    }

    if (!Array.isArray(session.contactReservations)) {
      session.contactReservations = [];
    }

    const newReservation = {
      id: nanoid(10),
      phone: cleanPhone,
      name: String(name || company || cleanPhone).trim().slice(0, 120),
      company: String(company || name || "").trim().slice(0, 120),
      quote: String(quote || "").trim().slice(0, 500),
      price: String(price || "").trim().slice(0, 50),
      date: String(date || new Date().toISOString().slice(0, 10)).trim(),
      time: String(time || "10:00").trim().slice(0, 10),
      notes: String(notes || "").trim().slice(0, 500),
      status: ["scheduled", "paused", "completed"].includes(status) ? status : "scheduled",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    session.contactReservations.unshift(newReservation);
    saveSoon(code);

    io.to(`session:${code}`).emit("reservations:changed", {
      action: "create",
      reservation: newReservation,
      reservations: session.contactReservations
    });

    res.json({ ok: true, reservation: newReservation });
  });

  // Modificar una reserva (actualizar estado, editar datos)
  app.patch("/api/session/:code/reservations/:id", (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const id = String(req.params.id || "").trim();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    if (!Array.isArray(session.contactReservations)) {
      session.contactReservations = [];
    }

    const index = session.contactReservations.findIndex(r => r.id === id);
    if (index === -1) {
      return res.status(404).json({ ok: false, error: "Reserva no encontrada" });
    }

    const current = session.contactReservations[index];
    const updates = req.body || {};

    const updated = {
      ...current,
      ...(updates.phone !== undefined ? { phone: String(updates.phone).trim() } : {}),
      ...(updates.name !== undefined ? { name: String(updates.name).trim().slice(0, 120) } : {}),
      ...(updates.company !== undefined ? { company: String(updates.company).trim().slice(0, 120) } : {}),
      ...(updates.quote !== undefined ? { quote: String(updates.quote).trim().slice(0, 500) } : {}),
      ...(updates.price !== undefined ? { price: String(updates.price).trim().slice(0, 50) } : {}),
      ...(updates.date !== undefined ? { date: String(updates.date).trim() } : {}),
      ...(updates.time !== undefined ? { time: String(updates.time).trim().slice(0, 10) } : {}),
      ...(updates.notes !== undefined ? { notes: String(updates.notes).trim().slice(0, 500) } : {}),
      ...(updates.status !== undefined && ["scheduled", "paused", "completed"].includes(updates.status) ? { status: updates.status } : {}),
      updatedAt: new Date().toISOString()
    };

    session.contactReservations[index] = updated;
    saveSoon(code);

    io.to(`session:${code}`).emit("reservations:changed", {
      action: "update",
      reservation: updated,
      reservations: session.contactReservations
    });

    res.json({ ok: true, reservation: updated });
  });

  // Eliminar una reserva
  app.delete("/api/session/:code/reservations/:id", (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const id = String(req.params.id || "").trim();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    if (!Array.isArray(session.contactReservations)) {
      session.contactReservations = [];
    }

    const initialLen = session.contactReservations.length;
    session.contactReservations = session.contactReservations.filter(r => r.id !== id);

    if (session.contactReservations.length !== initialLen) {
      saveSoon(code);
      io.to(`session:${code}`).emit("reservations:changed", {
        action: "delete",
        id,
        reservations: session.contactReservations
      });
    }

    res.json({ ok: true });
  });

  // Llamar directamente a un contacto de reserva agendada
  app.post("/api/session/:code/reservations/:id/call", async (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const id = String(req.params.id || "").trim();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    const reservation = (session.contactReservations || []).find(r => r.id === id);
    if (!reservation) return res.status(404).json({ ok: false, error: "Reserva no encontrada" });

    const availableWorkers = getConnectedPhoneWorkers(session).filter(w =>
      w.connected && !["dialing", "ringing", "in_call"].includes(w.callState)
    );

    if (!availableWorkers.length) {
      return res.status(503).json({ ok: false, error: "No hay teléfonos conectados y libres para realizar la llamada." });
    }

    const worker = availableWorkers[0];
    const dialCommandId = nanoid(12);

    try {
      if (typeof sendPersistedDial === "function") {
        sendPersistedDial(code, worker, {
          commandId: dialCommandId,
          phoneNumber: reservation.phone,
          contactName: reservation.name || reservation.company || reservation.phone,
          companyName: reservation.company || reservation.name || "",
          contactId: `reservation_${reservation.id}`
        });
      } else {
        io.to(worker.socketId).emit("call:dial", {
          commandId: dialCommandId,
          phoneNumber: reservation.phone,
          contactName: reservation.name || reservation.company || reservation.phone,
          companyName: reservation.company || reservation.name || ""
        });
      }

      res.json({
        ok: true,
        message: `Llamada iniciada en ${worker.name || 'teléfono'} a ${reservation.phone}`,
        workerId: worker.id,
        phone: reservation.phone
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || "Error al solicitar llamada" });
    }
  });
}
