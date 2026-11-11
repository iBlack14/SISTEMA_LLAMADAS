# Migración React cancelada

Por indicación del usuario se restauró la interfaz HTML/CSS anterior en el panel,
Núcleo de Red y login. El arranque ya no depende de frontend/dist ni de Vite.
Se conservan MySQL, las reglas de llamadas y las mejoras recientes de la APK,
incluida la descarga del modelo de español. Los archivos frontend/ quedan como
referencia inactiva. El plan siguiente es histórico y no describe la web activa.

## Plan histórico de las dos vistas

## Objetivo y límites
Migrar la interfaz a React + TypeScript + Vite, manteniendo Express, Socket.IO,
MySQL, la APK y las reglas de negocio. Las dos vistas son independientes:
- /: Panel de llamadas del operador (también accesible al administrador).
- /admin/nucleo-red: Núcleo de Red, exclusivo del administrador.
La interfaz no abre accesos que no autorice el servidor.

## Orden y criterios de salida
1. Base compartida y acceso: login, roles, CSRF, cierre de sesión, rutas y errores.
2. Núcleo: diez posiciones, estados reales, indicadores, resumen de turno,
   filtros, búsquedas, detalle e historial de equipos, alerta de desconexión,
   actualización manual, Socket.IO y descarga de registro JSON.
3. Llamadas: sesión persistente, QR múltiples y eliminación, vincular/desvincular,
   selección de listas por equipo, inicio general e independiente, pausa,
   continuación, saltar, colgar, detener, altavoz, finalizar turno y reiniciar sesión.
4. Contactos: crear/editar/eliminar listas y contactos; importación múltiple
   CSV/TXT/Excel/Word y URL con vista previa, duplicados, notas y WhatsApp.
5. Reportes: historial de MySQL, calendario anual con selección de rango,
   fechas Lima, filtros por turno/lista/equipo/resultado, duraciones, métricas,
   PDF, continuaciones de pendientes y acceso a rellamadas sujeto a bloqueos.
6. Paridad: confirmar todo lo anterior, accesibilidad, móvil, reconexión,
   sesiones ajenas/empleados sin acceso al Núcleo y fallos de MySQL.

## Reglas que se conservan
- Datos operativos en MySQL, con revisión para editar la base.
- Un intento por teléfono cada 12 meses, entre listas y sesiones.
- Número inexistente/incorrecto: NO VOLVER A LLAMAR permanente.
- Ni el frontend ni la navegación eluden las comprobaciones del servidor.
- Guardar la llamada antes de enviarla al teléfono y avanzar tras cierre real.
- Buzón, sin servicio y no disponible no equivalen a una persona atendiendo.
- Un dato no verificable se muestra como desconocido, no como cero inventado.

## Forma de migrar
Componentes por módulo, sin iframe ni inyección del HTML antiguo. Reutilizar
API y funciones puras; reemplazar manipulación manual del DOM por estado React.
Se conserva /legacy como respaldo durante la comprobación. No borrar la
implementación anterior hasta verificar paridad. No ejecutar llamadas reales
ni enviar mensajes externos para validar pantallas.

## Validación
Compilar TypeScript y Vite. Probar navegación, filtros, importación y acciones
con respuestas simuladas; comprobar la protección de rutas contra el servidor
real. La validación celular de llamadas requiere un ensayo explícito del usuario.
