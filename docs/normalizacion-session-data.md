# Persistencia normalizada de campañas

La aplicación mantiene el mismo formato de campaña en memoria para que las rutas, sockets y pantallas sigan funcionando. Con esta migración, MySQL guarda por separado los contactos activos, intentos de contacto, historial de campaña, reportes archivados y sus filas, además de los datos del turno. La fila `sessions.data` queda para el estado operativo pequeño. Los cambios se escriben por entidad; no se reescribe el conjunto completo de contactos en cada evento.

Las filas de turnos finalizados son inmutables mientras no cambie la lista de turnos. Los guardados comunes reutilizan esas filas y no las vuelven a clonar, recorrer ni comparar. Al cerrar un turno nuevo se reconcilia el historial actualizado. Este ajuste de rendimiento no requiere otra migración SQL.

## Migración

1. Crear y verificar una copia externa restaurable de la base.
2. Detener la aplicación que escribe en esa base.
3. Definir `SESSION_DATA_MIGRATION_BACKUP_VERIFIED=1` solo para el proceso manual.
4. Ejecutar `npm run migrate:session-data`.
5. Confirmar `ok: true` y que la migración indique el número de sesiones y entidades.
6. Arrancar la versión que incluye esta normalización. Al cargar, reconstruye las colecciones en memoria para conservar los contratos actuales.

El comando rechaza la ejecución si detecta el lock del runtime. La migración es transaccional e idempotente. El esquema se crea de forma aditiva; no elimina tablas existentes. No está activada automáticamente al arrancar el servidor.

## Reversión

Detener de nuevo la aplicación, verificar que la copia externa sigue disponible y ejecutar `npm run rollback:session-data` con `SESSION_DATA_MIGRATION_BACKUP_VERIFIED=1`. La reversión reconstruye `sessions.data` antes de borrar las filas normalizadas y el marcador de migración.

No ejecutar la migración en producción hasta ensayarla en una restauración aislada y comparar conteos y reportes antes/después. Este cambio de código, por sí solo, no altera la base ni despliega una versión.
