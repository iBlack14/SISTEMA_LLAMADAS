# Persistencia normalizada de campañas

La aplicación mantiene el mismo formato de campaña en memoria para que las rutas, sockets y pantallas sigan funcionando. MySQL guarda por separado los contactos activos, intentos de contacto, historial de campaña, reportes archivados y sus filas, además de los datos del turno. Con la normalización inicial, `sessions.data` conserva los campos restantes. La migración a `vc_session_state` traslada esos campos a filas por sesión y clave.

Las filas de turnos finalizados son inmutables mientras no cambie la lista de turnos. Los guardados comunes reutilizan esas filas y no las vuelven a clonar, recorrer ni comparar. Al cerrar un turno nuevo se reconcilia el historial actualizado. Este ajuste de rendimiento no requiere otra migración SQL.

Los contactos pendientes de turnos históricos se guardan en `vc_shift_unfinished_contacts`, indexada por sesión y turno. El arranque carga los conteos del turno, pero obtiene la lista de contactos solo cuando se solicita el reporte detallado de ese turno.

## Migración

1. Crear y verificar una copia externa restaurable de la base.
2. Detener la aplicación que escribe en esa base.
3. Definir `SESSION_DATA_MIGRATION_BACKUP_VERIFIED=1` solo para el proceso manual.
4. Ejecutar `npm run migrate:session-data`.
5. Confirmar `ok: true` y que la migración indique el número de sesiones y entidades.
6. Arrancar la versión que incluye esta normalización. Al cargar, reconstruye las colecciones en memoria para conservar los contratos actuales.

El comando rechaza la ejecución si detecta el lock del runtime. La migración es transaccional e idempotente. El esquema se crea de forma aditiva; no elimina tablas existentes. No está activada automáticamente al arrancar el servidor.

## Normalizar los detalles de turnos históricos

Después de desplegar esta versión, crear y verificar una copia externa reciente, detener la aplicación y ejecutar `npm run migrate:shift-details` con `SHIFT_DETAILS_MIGRATION_BACKUP_VERIFIED=1`. El comando mueve las filas `shift_unfinished`, valida el total y conserva los conteos en el resumen de cada turno. No se debe ejecutar antes de desplegar el código que carga esos detalles de forma diferida.

## Reversión

Para revertir detalles de turnos, detener la aplicación y ejecutar `npm run rollback:shift-details` con `SHIFT_DETAILS_MIGRATION_BACKUP_VERIFIED=1`. Esto los devuelve a `vc_session_entities`. Para volver a sesiones JSON, revertir primero `vc_session_state` si está activo, luego los detalles de turnos y finalmente ejecutar `npm run rollback:session-data` con `SESSION_DATA_MIGRATION_BACKUP_VERIFIED=1`.

No ejecutar la migración en producción hasta ensayarla en una restauración aislada y comparar conteos y reportes antes/después. Este cambio de código, por sí solo, no altera la base ni despliega una versión.

## Activar el estado por filas en preproducción

1. Verificar una copia restaurable de MySQL y detener la aplicación que escribe en esa base.
2. Ejecutar `npm run migrate:session-rows` con `SESSION_ROWS_MIGRATION_BACKUP_VERIFIED=1` y las variables `DB_*` del mismo despliegue. El comando aplica las migraciones de contactos, colecciones y turnos que falten. Comprueba el contenido de cada sesión antes de registrar el cambio de almacenamiento. Cada migración tiene su propia transacción y el comando puede volver a ejecutarse.
3. Arrancar la versión nueva. Verificar listas y contactos, reportes, vinculación de equipos y recuperación tras reiniciar. Probar dos equipos con listas distintas y medir el tiempo entre confirmación del guardado y despacho de la llamada. Revisar los tiempos de preparación y espera de guardado en los logs.
4. Para revertir, detener la aplicación y ejecutar `npm run rollback:session-rows` con la misma variable de respaldo. Este comando reconstruye `sessions.data` con el estado actual, incluidas las sesiones creadas después de migrar. Los pasos anteriores de normalización siguen activos.

Tras activar esta migración, el arranque y los guardados habituales usan `vc_session_state` para los campos de sesión. El guardado escribe solo los campos que cambiaron desde el último commit. La tabla anterior se conserva para la transición. Algunos valores dentro de las filas siguen representándose como JSON en MySQL. La cola de guardado y la reconstrucción de objetos en memoria siguen formando parte del tiempo que debe medirse en el VPS.
