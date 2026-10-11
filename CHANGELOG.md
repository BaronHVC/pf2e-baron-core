# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Las versiones siguen las reglas de versionado del [README](README.md#versionado):
PATCH = mismas salidas, MINOR = solo exports nuevos, MAJOR = cualquier otra cosa.
Cada entrada lista los exports afectados, para que solo los módulos que los usan
tengan que resincronizar.

## [Unreleased]

### Added

- `tools/check-module.mjs`: revisión `[l] paizo license`. `baron.json` gana el
  campo `paizo` (`"cup"` | `"orc"`), independiente de `mode`: un proyecto con
  cualquier parte de pago (un módulo `protected` o la base gratuita de un
  freemium) usa la ORC, porque la Community Use Policy prohíbe cobrar. Falla si
  el valor no es `cup`/`orc`, si es `protected` con `cup`, si falta `NOTICE.md`,
  si `NOTICE.md` no trae el aviso de esa licencia o si también trae el de la
  otra (un módulo de pago que conservara el aviso de la Community Use Policy
  diría que no se cobra). El aviso se busca como lo muestra GitHub: partido en
  renglones, citado, con énfasis o como enlace cuenta; dentro de un comentario
  HTML no. Con `orc` avisa (sin fallar) por cada renglón donde empieza un campo
  entre corchetes del template sin llenar, aunque esté partido en renglones, y
  si el id o el título nombran a Paizo o sus juegos (PF2e, Pathfinder,
  Starfinder, Golarion), porque la ORC nunca licencia marcas de Paizo. Un
  módulo sin `paizo` solo recibe un NOTICE (a uno `protected` le dice que
  necesita `orc`), así que nada que hoy pase empieza a fallar por esta
  revisión. `baron-core.js` no cambia: los módulos reciben la revisión cuando
  sus workflows apunten a un commit del core que la traiga. Nuevos casos en
  `test/fixtures/negative/paizo-*.json`; el módulo de ejemplo válido ahora
  declara `paizo: "cup"` y trae su `NOTICE.md`. La sección *Licencia* del
  README ya no dice que la licencia de Paizo sigue al precio de cada módulo.

### Changed

- `tools/check-module.mjs`: `[k] placeholders` también revisa `NOTICE.md`. Un
  `NOTICE.md` copiado a mano de la plantilla publicaría
  "__TITLE__ uses trademarks…"; `init-module` siempre los llena, así que un
  módulo inicializado no cambia.

### Fixed

- `tools/sync-core.mjs --watch` hacía la copia inicial antes de empezar a
  vigilar la carpeta: un cambio guardado justo al aparecer esa copia nunca se
  reflejaba (40 de 40 veces editando en cuanto aparecía el lock). Ahora el
  vigilante se arma primero. Solo afecta al modo de desarrollo; `baron-core.js`
  y `check-module` no cambian, así que ningún módulo necesita resincronizar.
  Era la causa del rojo intermitente del job `tools` en la CI de `v1.0.0-rc.1`.

## [1.0.0-rc.1]

Primera versión. Todo el código se extrajo **tal cual** de
pf2e-simple-weapon-editor v0.12.0 (commit `d15a90a`), salvo las generalizaciones
indicadas; las referencias son `archivo:líneas` en esa versión.

### Added

**Versión**
- `CORE_VERSION` = `"1.0.0-rc.1"`. Nuevo: es lo que compara el lock
  (`baron-core.lock.json`) y lo que la CI exige que coincida con la etiqueta.

**i18n**
- `createI18n(prefix)`: de `i18n` en `main.js:392-394`. El prefijo `SWE` pasa a
  ser parámetro; nada más cambia.

**Etiquetas**
- `slugOf(name)`: `main.js:278-284`.
- `resolveLabel(options, text)`: `main.js:349-355`, con su comentario.
- `locRecord(record)`: `main.js:396-406`.
- `labelFor(record, slug)`: `main.js:417-423`.

**Valores**
- `clampInt(v, min, max, fallback)`: `main.js:449-456`, con su comentario.
- `escHTML(s)`: `main.js:2221-2223`.

**PF2e**
- `isValuedCondition(slug)`: `main.js:274-276`.
- `DIE_SIZES`: `DIES` de `main.js:2`. Mismo orden, sin congelar.
- `PF2E_MODIFIER_TYPES`: `BONUS_TYPES` de `main.js:26`, con su comentario. Mismo
  orden, sin congelar.

**Permisos y ejecutor**
- `isSoleExecutor()`: `main.js:1677-1679`, con la justificación de
  `main.js:1668-1675` condensada.
- `canEditItem(item, gmOnly)`: el cuerpo puro de `canEdit`, `main.js:2357-2361`.
- `makeCanEdit(moduleId, settingKey = "gmOnly")`: nuevo envoltorio que lee el
  setting `gmOnly` del módulo solo al llamarse.

**Compatibilidad con Foundry** (se resuelven al llamarse, nunca al importar)
- `formDataClass()`: `main.js:1081` y `armor.js:891`.
- `textEditor()`: `main.js:607` y `armor.js:454`.
- `sheetElement(sheet)`: `main.js:2369` y `armor.js:1194`.
- `enrichHTML(html, options)`: atajo a `textEditor().enrichHTML`.

**Compendios**
- `packIndex(packId, fields)`: generaliza `runeIndex` (`main.js:559-568`) y
  `equipmentIndex` (`armor.js:411-421`). Una promesa memorizada por compendio y
  campos (en cualquier orden); `[]` si el compendio no existe; una promesa
  rechazada se queda en caché, como en el original. La clave de la caché es
  JSON, así que ningún id ni campo con `,` o `|` comparte entrada con otro.

**UI**
- `guardClicks(app)`, `releaseClickGuard(app)`, `renderSoon(app)`:
  `main.js:468-514`, con su comentario. Única diferencia: el estado ya no vive en
  `app._sweGuard` sino bajo un `Symbol` privado del archivo.
- `injectSheetButton(sheet, options)`: generaliza `injectButton`
  (`main.js:2363-2387`) e `injectArmorButton` (`armor.js:1188-1212`) con el mismo
  orden de pasos. Deduplica por `key` (`data-baron-btn`), no por clase, y la
  compara por valor (ninguna key necesita escaparse para CSS); arma el botón con
  `createElement` (sin `innerHTML`); no registra ningún hook. Una llamada sin
  `key` de texto o sin `match`/`onClick` se registra en la consola y no agrega
  nada; `cssClass`, `icon` y `title` omitidos no se escriben como `"undefined"`.

### Herramientas y CI

- `tools/sync-core.mjs`: vendoriza `baron-core.js` en un módulo desde una
  etiqueta o commit, escribe el lock y reescribe los pins de los workflows;
  `--watch` para desarrollo en vivo.
- `tools/check-module.mjs`: revisiones estáticas (a)–(k) de un módulo, con
  `--online` para comprobar el lock contra este repositorio.
- Workflows reutilizables `module-check.yml` y `module-release.yml` (modo
  público; el protegido falla a propósito porque aún no existe).

[Unreleased]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/BaronHVC/pf2e-baron-core/releases/tag/v1.0.0-rc.1
