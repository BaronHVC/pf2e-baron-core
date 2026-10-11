# Casos negativos de check-module

Cada `*.json` describe un módulo roto: se copia `../valid-module` a una carpeta
temporal y se le aplica UN cambio. Así el JavaScript roto a propósito (errores de
sintaxis, top-level await, imports a otro módulo) nunca vive bajo `test/`, donde
un `node --test` sin argumentos lo intentaría ejecutar.

Campos:

| campo     | significado                                                                  |
|-----------|------------------------------------------------------------------------------|
| `fails`   | id de la ÚNICA revisión que debe salir FAIL (exit 1)                          |
| `warns`   | en lugar de `fails`: id de la revisión que debe salir WARN (exit 0)           |
| `message` | texto que debe aparecer en esa línea                                         |
| `merge`   | `{ "archivo.json": { ... } }`: mezcla superficial sobre el JSON existente     |
| `write`   | `{ "ruta": "contenido" }`: crea o reemplaza archivos                          |
| `delete`  | `[ "ruta" ]`: borra archivos                                                  |
| `lock`    | escribe `baron-core.lock.json`; `"sha256": "auto"` = sha256 (LF) de la copia  |

Los materializa `test/tools/helpers.mjs` (`materialize`).
