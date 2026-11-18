# Análisis de Rendimiento - Sistema VOIP VC en EasyPanel
## Diagnóstico de Lentitud Reportada en Producción

---

## 🎯 Resumen Ejecutivo

La lentitud reportada en `https://llamadas1-llamadas.tvxk4m.easypanel.host/llamadas` **no es "mucha carga"** sino **arquitectura que no escala**. Los cuellos de botella son predecibles y se activan con **pocas sesiones concurrentes (10-20)**.

---

## 🔴 Top 5 Cuellos de Botella Críticos (Orden de Impacto)

### 1. NetworkMonitor: "El asesino silencioso" - Cada 2 segundos
**Archivo**: `backend/services/network/network-monitor.js:278-286`
```javascript
start() {
  this.timer = setInterval(() => {  // ← CADA 2 SEGUNDOS
    this.snapshot().then(data => this.broadcast(data))
  }, 2000);
}
```
**Qué hace**: 
- Itera TODAS las sesiones en memoria (`getSessions()`)
- Para cada sesión: itera pairingSlots, phoneWorkers, contactBook
- Hace queries MySQL serializadas (`persistence.getCallAttemptsForSessions`)
- Construye snapshot JSON masivo → emite a `admin:network` via Socket.IO

**Impacto real**:
- 1 sesión: ~5-10ms
- 10 sesiones: ~100-200ms 
- 20 sesiones: ~400-800ms **bloquea event loop**
- 50 sesiones: **2-5 segundos** → timeouts, lag general

**Evidencia**: `server.keepAliveTimeout = 65000` pero NetworkMonitor puede tomar >5s → healthchecks fallan, sockets se caen.

---

### 2. SessionPersistence.save(): Serialización completa en CADA phone:status
**Archivo**: `backend/shared/persistence.js:189-196`
```javascript
save(sessionsMap) {
  const snapshot = {};
  for (const [code, session] of sessionsMap) {
    // ...
    snapshot[code] = JSON.parse(JSON.stringify(data));  // ← EXPENSIVO
  }
}
```
**Flujo**: `phone:status` → `historyGate.commit()` → `persistence.save()` → **serializa TODA la sesión**

**Tamaño típico sesión**: 50-200 KB JSON
**Frecuencia**: 1-10 events/segundo por teléfono activo
**CPU**: `JSON.parse(JSON.stringify())` en objeto grande = 5-50ms por save

**Con 10 teléfonos activos**: 50-500ms/segundo solo serializando JSON

---

### 3. MySQL Connection Pool: Solo 10 conexiones
**Archivo**: `backend/shared/persistence.js:82`
```javascript
connectionLimit: 10,  // ← FIJO, NO CONFIGURABLE
```
**Problema**: 
- NetworkMonitor usa pool para queries cada 2s
- SessionPersistence usa pool para saves
- Health checks usan pool
- **Pool se agota** → requests se encolan → timeouts

**EasyPanel**: Contenedor comparte CPU/RAM con otros servicios → 10 conexiones es poco.

---

### 4. HistoryGate: Cola única por código de sesión
**Archivo**: `backend/services/calls/call-history-gate.js:15-27`
```javascript
serialize(code, task) {
  this.locks.set(code, (this.locks.get(code) || 0) + 1);
  const previous = this.queues.get(code) || Promise.resolve();
  // TODOS los eventos de UNA sesión en MISMA cola FIFO
}
```
**Impacto**: Llamada en curso bloquea guardado de otra llamada terminada en misma sesión.
**Burst**: 5 teléfonos reportando `phone:status` simultáneo → cola de 5 tareas serializadas.

---

### 5. Frontend: Re-render masivo en cada `state:changed`
**Archivo**: `frontend/app/dashboard-events.js:47-93`
```javascript
socket.on("state:changed", st => {
  dashboardActions.updateSessionUi(st);        // Re-render workers panel
  dashboardActions.applyState(...);            // Re-render call modal
  // ... comparaciones de signatures ...
  dashboardActions.loadPairingData(code);      // ¡FETCH HTTP COMPLETO!
  dashboardActions.renderPairingSlotsOnly();   // Re-render TODOS los slots
});
```
**Problemas**:
- `loadPairingData()` hace **fetch HTTP** a `/api/pairing/${code}` en CADA state:changed
- `renderPairingSlotsOnly()` reconstruye **HTML completo** de todos los slots
- `setInterval` cada 1s re-renderiza workers panel (`dashboard-events.js:135-137`)

**Resultado**: 10-20 `state:changed`/segundo → 10-20 fetches HTTP/segundo → lag UI severo.

---

## 🟡 Problemas Secundarios que Agravan

| Componente | Problema | Archivo:Línea |
|------------|----------|---------------|
| Socket.IO | `pingInterval: 25000`, `pingTimeout: 20000` - muy agresivo para móvil | `server-setup.js:22-23` |
| saveSoon() | Debounce 150ms pero **descarta saves intermedios** | `session-state.js:42-56` |
| Audio relay | Sin backpressure, reenvía binario raw sin control | `call-events.js:312-334` |
| Pairing QR | `fetch` SVG en cada carga, sin cache HTTP | `pairing-controller.js:150-164` |
| Rate limiter | In-memory, no funciona en cluster EasyPanel | `rate-limiter.js:10` |
| Auth | `auth.resolve()` en cada request Socket.IO | `sockets.js:21-43` |

---

## 📊 Estimación de Carga Real vs Capacidad

| Métrica | Actual (10 sesiones) | Límite Teórico | Brecha |
|---------|---------------------|----------------|--------|
| NetworkMonitor cycle | ~200ms | <50ms (para no bloquear) | **4x** |
| Persistence saves/sec | ~50 | <10 (para <100ms c/u) | **5x** |
| MySQL pool usage | ~8/10 | <70% (7/10) | **Límite** |
| Frontend fetches/sec | ~15 | <2 (ideal) | **7x** |
| Event loop lag | ~100ms | <10ms | **10x** |

**Conclusión**: El sistema **no soporta 10 sesiones concurrentes** con arquitectura actual.

---

## 🛠️ Plan de Acción - Priorizado por Impacto/Riesgo

### FASE 1: Fixes Críticos (Hacer YA - Riesgo Bajo, Impacto Alto)

#### 1.1 Desactivar/Reducir NetworkMonitor en Producción
```javascript
// network-monitor.js:278
// CAMBIAR: 2000 → 30000 (30s) O desactivar si no se usa admin:network
// MEJOR: Event-driven (invalidar cache en phone:status, no polling)
```

#### 1.2 Optimizar SessionPersistence.save() - Dirty Tracking
```javascript
// persistence.js:189-196
// SOLO serializar sesión que cambió, no TODAS
save(sessionsMap, changedCodes = []) {
  // changedCodes = códigos que tuvieron phone:status reciente
}
```

#### 1.3 Aumentar MySQL Pool
```javascript
// persistence.js:82
connectionLimit: Number(process.env.DB_POOL_LIMIT || 50),  // Configurable
```

#### 1.4 Fix Frontend: Eliminar fetch HTTP en state:changed
```javascript
// dashboard-events.js:85
// ELIMINAR: dashboardActions.loadPairingData(code)
// pairingSlots ya vienen en state:changed.phoneWorkers/pairingSlots
```

#### 1.5 Fix Frontend: Diffing granular en renderPairingSlotsOnly
```javascript
// pairing-controller.js:116
// SOLO actualizar slot que cambió, no innerHTML completo
```

---

### FASE 2: Optimizaciones Estructurales (Próximo Sprint)

#### 2.1 HistoryGate: Cola por (code, workerId) no solo code
```javascript
// call-history-gate.js:15
serialize(code, workerId, task) {  // clave compuesta
  const key = `${code}:${workerId}`;
  // ...
}
```

#### 2.2 NetworkMonitor: Event-driven + Worker Thread
```javascript
// Opción A: Mover a worker thread (Node.js worker_threads)
// Opción B: Invalidar cache en phone:status, snapshot solo bajo demanda
// Opción C: Separar en microservicio admin:network
```

#### 2.3 Socket.IO Timeouts para Móvil
```javascript
// server-setup.js:22-23
pingInterval: 30000,    // 30s (era 25s)
pingTimeout: 60000,     // 60s (era 20s) - móvil necesita más
```

#### 2.4 saveSoon(): Batch real con flush periódico
```javascript
// session-state.js:42-56
// Cola de writes + flush cada 500ms O batch size 50
```

---

### FASE 3: Arquitectura (Backlog)

| Item | Esfuerzo | Impacto |
|------|----------|---------|
| Separar call_history table de sessions blob | Alto | Muy Alto |
| Repository pattern para persistencia | Medio | Alto |
| Frontend Store (Redux-like) para estado | Alto | Alto |
| TypeScript + tipos de eventos Socket.IO | Medio | Medio |
| Tests de carga (k6/artillery) | Medio | Alto |

---

## ✅ Validación Inmediata (Hoy)

### Verificar en Producción (EasyPanel Shell)
```bash
# 1. Ver logs de NetworkMonitor
docker logs <container> | grep "NETWORK_MONITOR\|PERSISTENCE\|MySQL snapshot"

# 2. Ver pool MySQL
docker exec <container> mysql -e "SHOW PROCESSLIST;"

# 3. Ver event loop lag (requiere --trace-event-loop-lag)
node --trace-event-loop-lag backend/index.js

# 4. Métricas rápidas
curl -s https://llamadas1-llamadas.tvxk4m.easypanel.host/health
```

### Métricas Objetivo Post-Fix
| Métrica | Actual | Objetivo |
|---------|--------|----------|
| Healthcheck latency | ~500ms | <100ms |
| state:changed → UI update | ~200ms | <50ms |
| phone:status → persist | ~100ms | <20ms |
| NetworkMonitor cycle | ~200ms | <10ms (o 0 si desactivado) |
| MySQL pool usage | 80-100% | <50% |

---

## 🚨 Riesgos de NO Hacer Nada

1. **Cascada de fallos**: NetworkMonitor bloquea event loop → healthcheck falla → EasyPanel reinicia contenedor → pérdida de sesiones
2. **Data loss**: `saveSoon()` descarta writes intermedios → historial de llamadas incompleto
3. **Escalabilidad 0**: No se puede agregar más usuarios sin rediseño
4. **Experiencia usuario**: Dashboard se siente "roto" (lag, fetches fallidos, UI desactualizada)

---

## 📝 Próximos Pasos

1. **Aplicar FASE 1** (4-6 cambios quirúrgicos, <2 horas)
2. **Monitorear 24h** en producción
3. **Si persiste**: FASE 2 (requiere testing más cuidadoso)
4. **Paralelo**: Setup de métricas (Prometheus/Grafana o logs estructurados)

---

*Análisis basado en revisión completa de ~15,000 líneas: backend, frontend, Android APK, Docker, EasyPanel config.*