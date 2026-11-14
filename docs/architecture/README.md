# Arquitectura y guía de mantenimiento

El sistema usa una arquitectura modular por dominio: backend, frontend y código compartido están separados. El despliegue sigue siendo un único proceso Node.js porque las sesiones y la asignación de llamadas viven en memoria. Dividir ahora esos datos entre procesos permitiría asignar una llamada dos veces. Esta reorganización no introduce nuevos servicios de red ni migra datos.

## Entradas

- `backend/index.js`: arranque y señales de cierre.
- `backend/create-runtime.js`: composición de dependencias; crear el runtime no conecta la base ni abre puertos.
- `backend/lifecycle/runtime-lifecycle.js`: conexión MySQL, recuperación de sesiones, bloqueo del único escritor y cierre.
- `frontend/index.html`: panel de llamadas.
- `frontend/app/bootstrap.js`: inicia una sola instancia del dashboard.
- `frontend/app/dashboard.js`: ensambla módulos, estado y acciones.
- `frontend/login.html`: acceso.
- `frontend/features/admin/network/network.html`: plantilla administrativa, servida con autorización.

## Backend

| Carpeta | Responsabilidad |
| --- | --- |
| config | Perfiles local, aislado y EasyPanel; Express y Socket.io |
| middleware | Autenticación HTTP, autorización de sesión, límites y protección del historial |
| routes | Validación HTTP, respuestas y coordinación de servicios |
| sockets | Eventos de workspace, llamadas/audio y utilidades |
| session | Forma de sesión, workers, emisión de estado y ciclo de vida |
| services/auth | Usuarios, contraseñas, permisos y herramientas de administración |
| services/campaigns | Campañas, turnos y agenda de contactos |
| services/calls | Dispatch, restricciones, historial y vinculación |
| services/reports | Datos, métricas derivadas, selección y agrupación |
| services/workspace | Espacio por usuario e identidad de instancia |
| services/network | Monitor y resolución de URLs para Android |
| services/messaging | Contactos de mensajería |
| services/apk | Descubrimiento y versiones APK |
| services/contacts | Validación de URLs importadas |
| shared | Persistencia MySQL e historial |
| scripts | Migraciones y datos de prueba |
| __tests__ | Pruebas agrupadas por dominio y contratos |

Las rutas y los sockets reciben `runtime` y `services` explícitamente. Las factorías de sesión comparten el runtime; no creen otro Map de sesiones por módulo. El arranque reemplaza el Map al cargar MySQL: accedan al runtime vigente en operaciones que puedan ocurrir después de esa carga.

El orden de `routes/index.js` es deliberado: middleware HTTP, administración, páginas, acceso operativo, rutas de negocio y recursos estáticos. Mantengan la autorización delante de las rutas correspondientes. El pairing Android mantiene su validación por token.

## Frontend

| Carpeta | Qué editar |
| --- | --- |
| app | Composición, estado común, eventos, inicio y navegación |
| layouts/dashboard | Sidebar y cuenta |
| features/auth | Sesión y login |
| features/admin | Usuarios y Núcleo de Red |
| features/calls | Controles, audio e historial |
| features/campaigns | Ejecución y presentación de campañas |
| features/contacts | Repositorio, edición, importación y exportación |
| features/devices | Vinculación, equipos, APK y listas asignadas |
| features/shifts | Turnos y finalización |
| features/reports | Calendario, detalle, consultas y PDF |
| features/blocked-numbers | Bloqueos |
| features/messaging | WhatsApp y contactos |
| features/workspace | Espacio autenticado |
| shared/ui | Referencias DOM y diálogos |
| shared/formatting | Formateo reutilizado |
| shared/realtime | Una conexión Socket.io por navegador |
| shared/styles | Entrada CSS y fragmentos de la cascada existente |

Las factorías reciben `dashboardState` y `dashboardActions`; comparten la instancia creada por `createDashboardApp()`. No guarden una copia local de un valor mutable del estado. Los imports internos no llevan parámetros de versión, para evitar instancias distintas del mismo repositorio o socket.

El sidebar usa `app/navigation/panel-navigation.js` para sincronizar hash, panel visible y selección. Usuarios y Núcleo de Red navegan al panel administrativo; no se interpretan como paneles de llamadas.

## Estilos

`frontend/shared/styles/base.css` importa 23 fragmentos de `theme/` en orden. Se conserva exactamente la cascada original, incluidos sus overrides. Los números representan orden, no prioridad libremente intercambiable. La prueba de arquitectura reconstruye el CSS y compara su huella con la versión previa. Los estilos específicos de cada funcionalidad se encuentran junto a esa funcionalidad.

Esta división es mecánica para conservar la apariencia. Una futura limpieza de selectores y overrides debe ser un cambio separado con revisión visual, no un simple reordenamiento de imports.

## Código compartido

`shared/reports/report-metrics.js` contiene las reglas usadas en Node y navegador. No importa DOM, Express ni persistencia. El backend lo importa por ruta relativa y el navegador lo recibe bajo `/shared/reports/report-metrics.js`.

## Compatibilidad

- Se conservan las URLs HTTP, cuerpos de pairing y nombres de eventos Socket.io.
- `docs/architecture/contracts.json` registra los contratos anteriores y la huella CSS.
- `docs/architecture/file-map.json` relaciona archivos antiguos con sus implementaciones nuevas.
- `server/` conserva puentes de imports y comandos históricos; editar la implementación en `backend/`.
- `web/` conserva recursos gráficos y puentes. `backend/routes/legacy-assets.js` redirige las URLs JavaScript/CSS antiguas a los módulos canónicos.
- Los scripts npm y Docker usan `backend/index.js`.
- Se conserva la ubicación histórica de datos, backups, .env y APKs. No se cambia esquema, credenciales ni política CORS por esta reorganización.
- La APK instalada no necesita cambiar endpoints: `POST /api/android/pair` y `/socket.io/` mantienen sus contratos.

## Flujo de llamada

1. Frontend envía la orden HTTP o Socket.io.
2. Middleware valida cuenta, sesión y permisos.
3. La ruta o handler usa campañas, restricciones y dispatcher.
4. Se registra el intento antes de enviar la orden al teléfono.
5. Android informa estado; el handler actualiza campaña e historial.
6. Se emite el estado al dashboard y se asigna el siguiente contacto cuando corresponde.

## Añadir una funcionalidad

1. Elegir el dominio existente; crear un módulo con una responsabilidad concreta.
2. Mantener la lógica de negocio fuera de la plantilla HTML y del registro de rutas.
3. Inyectar dependencias; registrar nuevas factorías en el punto de composición.
4. Reutilizar métricas, permisos y persistencia existentes.
5. Añadir pruebas del comportamiento y actualizar contratos si cambia una API deliberadamente.
6. Ejecutar `npm test` y comprobar manualmente el flujo afectado.

## Comandos

- `npm start`: servidor con el perfil configurado.
- `npm run dev`: mismo servidor con reinicio automático.
- `npm test`: dominios, navegación y arquitectura.
- `npm run test:web`: composición web, imports, CSS y navegación.
- `npm run test:contracts`: HTTP, acceso, pairing Android y registro de sockets.
- `npm run auth:local`: entorno MySQL aislado existente.
- `npm run auth:user:add -- nombre ROL`: creación administrativa existente.

Las pruebas de arquitectura usan un servidor efímero y dobles de persistencia; no ejecutan bootstrap sobre la base operativa. La prueba opcional MySQL permanece desactivada sin su configuración específica. Una llamada real, audio y despliegue EasyPanel requieren validación en sus entornos.

## Evolución a servicios desplegables

Antes de separar procesos, extraer el estado autoritativo a un almacén transaccional, definir idempotencia de órdenes y asignaciones, transportar eventos entre instancias y garantizar un único propietario por teléfono. Después pueden separarse reportes o descargas APK, con contratos versionados y observabilidad. Las carpetas actuales permiten ese trabajo sin mezclarlo con la reorganización.
