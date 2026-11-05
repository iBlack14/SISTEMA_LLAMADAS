BASE DE DATOS DEMO PARA GESTIÓN DE LLAMADAS VC

Esta prueba utiliza la persistencia que YA tiene el sistema: MySQL si está configurado, o server/sessions.json en caso contrario. No crea tablas paralelas.

INSTALACIÓN
1. Haz una copia de seguridad del proyecto y de la base de datos.
2. Copia la carpeta demo-db a la raíz del proyecto, al lado de server y web.
3. Inicia el dashboard y obtén el código REAL de la sesión activa.
4. Detén el servidor Node.js (Ctrl+C).
5. Desde la raíz del proyecto ejecuta:
   node demo-db/seed-reportes.mjs CODIGO
   Ejemplo: node demo-db/seed-reportes.mjs ABC123
   Si tu .env utiliza MySQL, realiza antes un backup de MySQL y añade:
   node demo-db/seed-reportes.mjs ABC123 --confirmar-mysql
6. Reinicia el servidor y actualiza el dashboard. Abre CALENDARIO y prueba 22/01/2026 y 05/11/2026.

RESULTADOS
6 reportes: Automóviles 20, Ingeniería 20, Arquitectura 15, Construcción 20, Tecnología 15, Comercio 10. Total 100 contactos ficticios.
Los teléfonos empiezan con TEST- y no son marcables. Así no se llamará accidentalmente a personas reales. La opción CONTINUAR LLAMADAS no debe ejecutarse en esta prueba.

IMPORTANTE
- No modifica ni elimina campañas reales; añade o reemplaza solo registros cuyo ID empieza con DEMO-.
- Ejecuta el script con el servidor detenido para evitar que se sobrescriban cambios concurrentes.
- No genera registros de ENVIÓ INF. porque el módulo actual todavía no los recupera.
- Si el endpoint /reports/daily responde 401, hay que corregir primero la autenticación: este script no la omite.
- El módulo actual puede contar como pendientes contactos no contestados; la clasificación definitiva debe validarse antes de usar marcación real.
