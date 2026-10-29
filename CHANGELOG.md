# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Las versiones siguen las reglas de versionado del [README](README.md#versionado):
PATCH = mismas salidas, MINOR = solo exports nuevos, MAJOR = cualquier otra cosa.
Cada entrada lista los exports afectados, para que solo los módulos que los usan
tengan que resincronizar.

## [Unreleased]

### Added

- `tools/sign-text.mjs --sign --author <nombre>`: quien da fe de los textos
  ante Foundry (BaronHVC) firma por el autor que los escribió sin terminal
  (IAR18). Es el mismo `--sign`, pero pregunta «¿<nombre> escribió este texto
  desde cero? [s/N/q]» y cada `s` guarda `<nombre>` como autor de esa firma.
  El nombre se recorta y debe quedar de 1 a 60 caracteres sin caracteres de
  control; si no, sale con 2 sin preguntar.
- `sign-text --sign --sheet <archivo.csv>`: lee la hoja con el mismo lector de
  `text-sheet import` y solo pregunta por las celdas de idioma con texto (más
  `module.json:title` y `module.json:description` en la columna del primer
  idioma), con la clave y el idioma con que `import` las escribe, cuyo valor
  en el módulo es el de la celda byte por byte y que necesitan firma; la
  pregunta nombra al `author` de la fila y la firma lo guarda. Lista sin
  preguntar, con renglón, idioma y clave y nunca el valor: las filas sin
  autor o con un nombre que no vale, las celdas sin importar o cambiadas
  después, los textos ya firmados, las celdas que `import` no escribe y un
  texto que dos filas dan con autores distintos. Con `--author`, sin `--sign`
  o sin archivo sale con 2.
- `human-text-authors.json`, junto a `human-text.json`: `{ "version": 1,
  "authors": { "<archivo>": { "<clave>": "<nombre>" } } }`, con el formato de
  `human-text.json` (claves ordenadas, dos espacios, LF y salto final). Lo
  escribe solo `sign-text`, en el mismo paso que `human-text.json` y solo
  cuando este cambia (los dos por temporal y renombrado; si un renombrado
  falla, el ya reemplazado vuelve a como estaba y lo nuevo queda en los
  temporales); nunca lo crea vacío. Las firmas de claves que ya no existen se
  llevan a su autor, y una entrada sin firma se quita. Un `--sign` sin
  `--author` ni `--sheet` pregunta como siempre, no guarda autor y quita el
  que tenía una firma anterior de ese texto. Va al repo y nunca al ZIP.
- Sin `--sign`, `sign-text` lista cada texto firmado que tiene autor (`signed
  … by "IAR18"`), cuántos lleva cada autor y las entradas sin firma; sin
  autores guardados, lista exactamente lo mismo que antes.
- `tools/shared.mjs`: `HUMAN_TEXT_AUTHORS_FILE`,
  `HUMAN_TEXT_AUTHORS_VERSION`, `AUTHOR_NAME_MAX`, `authorNameProblem`,
  `authorsProblem`, `readAuthors` y `authorsText`; y el lector de la hoja,
  que sale de `text-sheet.mjs` sin cambios: `decodeSheet`, `csvParse`,
  `readSheet`, `TextSheetError` y los nombres de columna (`FIXED_COLUMNS`,
  `CURRENT_PREFIX`, `AUTHOR_COLUMN`, `AUTHOR_HEADERS`, `SECTION_COLUMN`,
  `NOTE_COLUMNS`, `LISTING_PREFIX`). `text-sheet.mjs` los sigue exportando.
- `sign-text.mjs` exporta además `authorQuestion` y `AUTHOR_LEGEND`, y
  `signTexts` acepta `author`, `sheet` y `cwd`.

### Changed

- `text-sheet import` termina, si escribió algo, con el comando exacto
  `node ../pf2e-baron-core/tools/sign-text.mjs . --sign --sheet <la hoja>` (con
  las rutas tal como se corrió) y dice que lo corre quien da fe de los textos,
  BaronHVC, contestando por el autor de cada fila. La lista por autor y el
  rechazo de `export` a una hoja con textos importados sin firma nombran el
  mismo comando.
- La CI del core trae las etiquetas en el trabajo `tools`: una prueba corre el
  `check-module` de v1.5.0 y de v1.6.0 sobre un módulo con
  `human-text-authors.json` y comprueba que pasa igual que sin él.

`human-text.json` conserva su formato y `check-module` no cambia en nada: no
lee `human-text-authors.json`, así que los módulos cuya CI fija v1.5.0 o
v1.6.0 pasan igual con el archivo. Sigue sin haber forma de firmar sin una
persona en una terminal. Las funciones de `baron-core.js` no cambian.

## [1.6.0] - 2026-10-28

### Added

- `tools/text-sheet.mjs`, para escribir los textos humanos en una hoja de
  cálculo (ver *Escribir los textos en la hoja* en el README). `export
  [<carpeta>] [--out <archivo.csv>] [--all]` escribe `textos-hoja.csv` en la
  raíz del módulo: UTF-8 con BOM, comas, comillas de RFC 4180 y CRLF, que Excel
  en español de México y Google Sheets abren tal cual. Por omisión, solo los
  textos que necesitan a una persona, los mismos que listan `sign-text` y la
  revisión `[n]` (sin el candado, los que `[n]` reporta: `TODO-HUMANO:`,
  también dentro de una lista o en una copia de una clave definida dos veces);
  con `--all`, todos más el `title` y la `description` de `module.json`. Las
  filas siguen el orden de `docs/textos-borrador.md`. Columnas: `key`, `where`
  (en un renglón: lo de `docs/textos-borrador.md` y los `archivo:línea` del
  rastreo de la revisión `[h]`), `intent` (con «mismo término que» de la tabla
  de conceptos), `placeholders` (solo `{nombre}`: la etiqueta de un enricher
  es texto), `max_length`, `status`, una vacía por idioma, una
  `current_<idioma>` por idioma que solo lleva un valor con firma válida,
  `author` (vacía) y `section` (el encabezado del borrador). La hoja nunca
  muestra un texto de IA, y no hay opción que lo haga: tampoco una celda del
  borrador que cite un texto sin firma (una oración de siete palabras o más,
  o un texto entre comillas), que sale vacía con un aviso. Nunca escribe
  dentro de lo que empaca el release, ni encima de una hoja con un texto sin
  importar, con uno importado y sin firma (con el candado) o con texto en una
  columna que `import` no lee. Avisa si la hoja no está en el `.gitignore`
  (`textos-hoja*` y `~$*`), de los textos sin fila en el borrador, de las
  filas sin clave en los idiomas, de los marcadores que no coinciden, de las
  celdas que Excel abriría como fórmula, de un `lang/*.json` sin declarar y de
  un archivo con BOM, que `sign-text` rechaza. Un JSON roto lo reporta con
  renglón y columna, sin citarlo.
- `text-sheet import <archivo.csv> [<carpeta>] [--dry-run] [--partial]`: lee
  la hoja como la guardan Excel o Google Sheets (con o sin BOM, UTF-16, coma,
  punto y coma o tabulador, CRLF o LF, columnas en cualquier orden, el
  encabezado donde lo deje un orden) y escribe cada celda de idioma en su
  archivo, o en `module.json` el título y la descripción (desde la columna del
  primer idioma). Rechaza una clave que no existe en ese idioma (nunca crea
  claves), una lista o una clave definida dos veces, unos `{marcadores}`
  distintos de los que el texto debe conservar, un valor que empieza con
  `TODO-HUMANO:`, que solo tiene espacios o que es un error de hoja de cálculo
  (`#¿NOMBRE?`, `#N/A`…), dos textos distintos para un mismo valor (también
  desde dos columnas de idioma que comparten archivo) y una columna con texto
  que no lee; pasarse de `max_length`, un apóstrofo al principio y un texto que
  es solo un número o una fecha solo avisan. Una celda igual al valor sin firma
  no escribe nada y se avisa aparte. Una hoja sin texto en las columnas de
  idioma lo detiene. Con una celda rechazada no escribe nada y lista cada
  motivo con su renglón; `--partial` escribe las válidas; `--dry-run` no
  escribe y muestra qué cambiaría. Cambia solo los valores editados, byte por
  byte (orden, anidamiento, sangría, fines de línea, BOM, salto final y estilo
  de los escapes), con archivos temporales y renombrados, todos o ninguno.
  Nunca toca `human-text.json` ni firma; lista las filas de cada nombre de la
  columna `author` y termina con el paso de `sign-text --sign`, con las rutas
  tal como se corrió. Solo imprime el uso tras un error en los argumentos.
  Exporta `exportSheet`, `importSheet`, `csvWrite`, `csvParse`,
  `decodeSheet`, `parseDraft`, `parseConcepts` y `jsonStringLeaves` para las
  pruebas.
- `tools/shared.mjs`: `i18nRefs` (el rastreo de claves de la revisión `[h]`,
  que ahora devuelve también dónde empieza cada clave armada en tiempo de
  ejecución) y `ownScripts`. `check-module` lo usa sin cambiar sus resultados.

## [1.5.0] - 2026-10-24

### Added

- Candado de textos humanos para toda la familia (política de IA de Foundry,
  manual del publicador 4.1). `baron.json` acepta `"humanText"`: sin el campo
  o con `"markers"`, todo sigue igual; con `"signed"`, cada texto necesita la
  firma de su autor. `check-module`, revisión `[c]`: cualquier otro valor
  (`"Signed"`, `true`, `null`…) falla siempre, y la revisión `[n]` sigue
  aplicando el candado, así que un error de dedo nunca lo apaga.
- `tools/check-module.mjs`, revisión `[n]` con `"humanText": "signed"`: cada
  valor de texto de los idiomas que declara `module.json` (si no declara
  ninguno, cada `lang/*.json`, como en `[d]` y `[h]`; claves aplanadas con
  puntos) y el `title` y la `description` de `module.json` necesitan su firma
  en `human-text.json`, el sha256 del valor exacto (sin recortar ni
  normalizar). Uno sin firma, cambiado después de firmarse, vacío, con
  `TODO-HUMANO:` o con un surrogate UTF-16 suelto (que en UTF-8 se confundiría
  con otro valor) da un WARN en cada push y un FAIL con `--release`: un renglón
  de encabezado y uno por texto con archivo y clave (los primeros 10 y luego
  `and N more`, con el comando que los lista todos). Lo mismo cada
  `lang/*.json` que `module.json` no declara: viaja en el ZIP y sus textos no
  se pueden firmar. Sin `human-text.json` todos cuentan como sin firma. Un `human-text.json` mal formado (JSON inválido, otra forma,
  otra `version`) falla siempre. El PASS dice cuántos textos están firmados.
  Las revisiones de `TODO-HUMANO:` no cambian. `human-text.json` no va en el
  ZIP del release.
- `tools/sign-text.mjs [<carpeta del módulo>]`: sin bandera, lista cada texto
  sin firma o cambiado (archivo, clave y valor), la cuenta, los que faltan
  escribir y las firmas de claves que ya no existen (las primeras 10, una por
  renglón), cierra con el comando que los firma y sale con 0. Con `--sign`
  explica primero cada respuesta (en una traducción, `s` dice que quien firma
  domina el idioma y la revisó línea por línea contra su original humano),
  pregunta por cada texto pendiente «¿Escribiste tú este texto desde cero?
  [s/N/q]» y escribe `human-text.json` una sola vez, al final o con `q`
  (archivo temporal y renombrado, reintentado unos 2 segundos si otro programa
  lo tiene abierto; si no se puede, las firmas quedan en el temporal y el
  mensaje dice dónde), sin las firmas de claves que ya no existen. Un Ctrl+C
  o un Ctrl+D antes lo deja intacto, sale (130 o 1) y dice cuántas firmas de
  la corrida se perdieron. Se niega a firmar sin una terminal (stdin y stdout
  TTY; el mensaje dice cuál de los dos es una tubería o una redirección, y
  `winpty node …` solo hace falta en Git Bash con un Git for Windows anterior
  a 2.54), nunca firma un valor vacío, con `TODO-HUMANO:` o con un surrogate
  suelto y no tiene `--yes`. Exporta `signTexts({ dir, sign, isTTY, ask })`
  para las pruebas (`isTTY` acepta también `{ stdin, stdout }`),
  `noTtyMessage`, `DEFAULT_COMMAND` y `LEGEND`.
- `tools/shared.mjs`: `walk`, `languageEntries` y `flattenLang` (salen de
  `check-module`, sin cambiar sus resultados) y lo del candado:
  `HUMAN_MARKER`, `LISTING_FIELDS`, `HUMAN_TEXT_MODES`, `HUMAN_TEXT_FILE`,
  `HUMAN_TEXT_VERSION`, `isHumanPlaceholder`, `hashText`, `humanTexts`,
  `signaturesProblem`, `readSignatures`, `signatureStatus`, `staleSignatures`
  y `signaturesText`.

Un módulo recibe el candado en su CI al resincronizar con la próxima etiqueta
del core; mientras tanto lo revisa el `check-module` de un clon local. Un
módulo que no declara `humanText` se revisa exactamente igual que con v1.4.0.
Las funciones de `baron-core.js` no cambian.

## [1.4.0] - 2026-10-12

### Added

- `module-check.yml` (cada push) y `module-release.yml` (cada etiqueta, público
  y protegido) corren las pruebas de node del propio módulo después de
  `check-module`, con el nuevo `.github/scripts/run-module-tests.mjs`, en el
  checkout del módulo (los `import` de `../scripts/*.js` resuelven como en
  local). Corre lo primero que encuentre: el script `test` de `package.json`
  con `npm test` (antes `npm ci` con lockfile o `npm install --no-audit
  --no-fund` sin él, solo si declara `dependencies` o `devDependencies`; el
  `echo "Error: no test specified" && exit 1` que deja `npm init` cuenta como
  si no hubiera script, con un aviso); si no, `node --test` con la lista
  explícita de `*.test.mjs` y `*.test.js` bajo `test/` y `tests/` (nunca a
  secas: de `fixtures/` y `helpers/` solo corre lo que termina en `.test.mjs`
  o `.test.js`); sin ninguno, un aviso «no tests found» y pasa. Node 22+ lee
  esa lista como globs, así que un archivo de prueba con `* ? [ ] { } ( ) ! +
  @` o `\` en la ruta falla el paso y pide renombrarlo, en vez de pasar con 0
  pruebas. Una prueba roja tumba el job y, con `node --test`, sale como
  anotación pública vía `tap-annotate.mjs`. El paso tiene un tope de 15
  minutos: una prueba que deja un timer abierto ya no cuelga el job 6 h. En
  `module-release` el paso va antes de reescribir `module.json` y de armar el
  ZIP, así que una etiqueta con una prueba roja no publica. Un `package.json`
  que no se puede leer falla el paso en vez de saltarse las pruebas. Ni las
  pruebas ni sus dependencias ven el token: el checkout del módulo va con
  `persist-credentials: false`, `npm ci`/`npm install` llevan
  `--ignore-scripts`, y en `module-release` un paso nuevo detiene el release
  si las pruebas cambiaron o crearon algo de lo que va en el ZIP. Un módulo
  lo recibe al resincronizar con la próxima etiqueta del core; las funciones
  de `baron-core.js` no cambian.

### Changed

- `tap-annotate.mjs`: la anotación de una prueba roja se corta en el fin de su
  bloque YAML (ya no arrastra el plan ni el resumen del TAP) y, cuando un
  archivo de prueba no carga o truena fuera de una prueba (solo dice `'test
  failed'`), agrega lo que el archivo imprimió, sin los marcos internos de
  node: la causa, como `ERR_MODULE_NOT_FOUND`, ya no se queda en el log que
  solo bajan los admins.

## [1.3.0] - 2026-10-11

### Added

- `tools/check-module.mjs`, revisión `[l]`: el marcador `PENDIENTE:` de la
  familia para un dato legal de `NOTICE.md` que espera la firma del autor (una
  atribución sin cotejar, una decisión que solo él toma). Cuenta escrito como
  `PENDIENTE:` o `PENDIENTE (<quién>):`, con énfasis (`*`, `_`) alrededor de la
  palabra o del paréntesis o sin él, con o sin espacios antes de los dos puntos,
  en mayúsculas exactas y en cualquier parte del archivo, también dentro de un
  comentario HTML; «pendiente:» en la prosa no cuenta. Cada renglón con el
  marcador da un WARN en cada push y un FAIL con `--release`, con cualquier
  licencia de Paizo y también sin `paizo` en `baron.json` (el release empaca
  `NOTICE.md` de todos modos). Generaliza la compuerta que
  pf2e-simple-weapon-editor puso en su propio `release.yml`.

### Changed

- `tools/check-module.mjs`, revisión `[l]`: con `--release`, cada campo de la
  ORC sin llenar en `NOTICE.md` (`[Title of Work]`, `[Copyright Notice]`,
  `[Author Credit Information]`, `[nombres, logos, …]`, `[ninguno]`) es FAIL en
  vez de WARN, así que `module-release` ya no publica un aviso ORC incompleto.
  Sin `--release` sigue siendo WARN, ahora con el texto «fill them before
  tagging, the release refuses them». El aviso de marcas de Paizo en el id o el
  título sigue siendo WARN también con `--release`: es una pregunta legal
  abierta, no un campo por llenar. Sin `paizo`, el NOTICE dice ahora «the Paizo
  license is not checked and NOTICE.md is not required». Un módulo lo recibe al
  resincronizar; las funciones de `baron-core.js` no cambian.

## [1.2.0] - 2026-10-11

### Added

- `tools/check-module.mjs`: revisión `[n] human text` y opción `--release`
  (decisión 15 de la familia: la política de IA de Foundry pide que las
  etiquetas de la interfaz y el texto preparado los escriba una persona). Una
  sesión de Claude deja `TODO-HUMANO: <qué debe decir>` como valor y el autor lo
  llena. La revisión busca valores de texto que *empiezan* con `TODO-HUMANO:`
  (tras quitar los espacios iniciales; mayúsculas exactas) en los archivos de
  idioma, planos o anidados, y en el `title` y la `description` de
  `module.json`; un texto que lo cita a media frase no cuenta. Sin `--release`
  da un WARN por archivo con cuántos son y hasta cinco claves; con `--release`,
  FAIL con el mismo detalle. Sin pendientes, PASS.
- `module-release.yml` corre `check-module --online --release` (público y
  protegido): una etiqueta con un `TODO-HUMANO:` pendiente no publica.
  `module-check.yml`, en cada push, no lo pasa: ahí solo avisa. Un módulo lo
  recibe al resincronizar con la próxima etiqueta del core (el pin de sus
  workflows es el commit del lock); las funciones de `baron-core.js` no cambian.

### Fixed

- Prueba intermitente de `sync-core --watch` en la CI de Linux: los archivos
  copiados se veían antes de que la línea del log llegara por el pipe del
  proceso, y la prueba exigía las dos cosas a la vez. Ahora espera también el
  log. Era la causa del rojo de las etiquetas `v1.1.0` y `v1.1.1`; la
  herramienta no cambia, así que ningún módulo necesita resincronizar.
- `tools/check-module.mjs`: una clave de idioma (o un id de módulo) con un salto
  de línea ya no parte la línea del reporte. Antes, bajo GitHub Actions, el
  texto tras el salto podía empezar con `::error ...` y el runner lo leía como
  comando (una anotación falsa, incluso en un push). Ahora el salto se imprime
  escapado (`\n`) en las líneas PASS/WARN/FAIL/NOTICE y en el encabezado; las
  anotaciones ya lo escapaban.

## [1.1.1] - 2026-10-11

### Fixed

- `module-release.yml`: el ZIP ahora incluye `LICENSE` y `NOTICE.md` cuando el
  módulo los tiene, en modo público y en protegido. Antes solo llevaba lo que
  carga Foundry, así que el aviso MIT y los avisos de la ORC no viajaban con la
  copia que recibe cada usuario. Las funciones de `baron-core.js` no cambian;
  solo `CORE_VERSION` pasa a `"1.1.1"`. Cada módulo lo recibe al resincronizar
  con `sync-core --ref v1.1.1`.

## [1.1.0] - 2026-10-11

El modo de pago del pipeline. Las funciones de `baron-core.js` no cambian; solo
`CORE_VERSION` pasa a `"1.1.0"`. Un módulo recibe el pipeline nuevo al
resincronizar con `sync-core --ref v1.1.0` (el pin de sus workflows es el commit
del lock).

### Added

- Modo de pago (`"mode": "protected"` en `baron.json`, un complemento freemium):
  `module-release` ya no falla a propósito. Exige un repo privado
  (`github.event.repository.private`), reescribe `module.json` para un paquete
  protegido de Foundry (`"protected": true`, sin `download`, manifest
  `https://r2.foundryvtt.com/packages-public/<id>/module.json`, `url` =
  `landingUrl`), arma el ZIP igual que en modo público, lo publica con ese
  `module.json` en un release del propio repo privado (prerelease si la etiqueta
  no es `vX.Y.Z`), nunca toca el canal `dev` y deja en el resumen del run la
  lista para subirlo a mano a foundryvtt.com y asignar los niveles de Patreon.
  En una prerelease, el resumen dice en cambio que no se sube a Foundry (la
  estable `X.Y.Z` no contaría como más nueva que `X.Y.Z-rc.N`) y que se prueba
  desde la copia de trabajo, porque el ZIP protegido no se instala a mano.
  Requisito nuevo: la base gratuita publicada en foundryvtt.com con su id antes
  del primer release del complemento. Ver «Modo de pago» en el README.
- `baron.json` gana `landingUrl`: la página `https` pública de un módulo de pago,
  que el release pone como `url`. En un módulo público se ignora.
- `tools/release-manifest.mjs`: la reescritura de `module.json` del release como
  herramienta con pruebas, en lugar de los dos `node -e` del workflow. En modo
  público las salidas son idénticas byte a byte a las de antes (estable,
  prerelease y canal `dev`, comparadas contra el `node -e` anterior). En modo
  protegido falla sin `--landing-url` `https`, con `--channel dev` o si
  cualquier texto o clave del resultado menciona GitHub (`github.com` y sus
  subdominios, `githubusercontent.com`, `github.io`, también con escapes `%2E`),
  y lista sus rutas JSON (`bugs`, `authors[0].url`, …). También rechaza un
  `--channel` que no coincida con la etiqueta. El `manifest` de una dependencia
  (el de la base, aunque su repo sea público) también falla, con su propio
  mensaje: se quita y la base se publica en foundryvtt.com, donde Foundry la
  encuentra por su id.
- `tools/check-module.mjs`: revisión `[m] protected packaging`, solo con
  `mode: protected`. Falla si `landingUrl` falta o no es una URL `https` (o
  apunta a GitHub) y si otro texto o clave de `module.json` menciona GitHub,
  porque el release protegido lo rechazaría (así falla en cada push, no hasta
  la etiqueta); avisa si `relationships.requires` no lista ningún módulo (la
  base del freemium; pf2e-baron-core no cuenta). En un módulo público no
  imprime nada ni cuenta en el resumen.
- `tools/shared.mjs`: `httpsUrlProblem`, `githubPaths`, `mentionsGitHub` y
  `GITHUB_HOST_RE`, que comparten `check-module` y `release-manifest`.

### Changed

- `module-release.yml`: el canal `dev` corre solo con `mode: public`, y `Leer
  baron.json` publica `mode` y `landingUrl` como salidas del paso.
- `test/fixtures/negative/paizo-orc-both-notices.json` y
  `paizo-protected-cup.json` llevan `landingUrl`, para que sigan fallando solo
  en la revisión `l`.

## [1.0.0] - 2026-10-11

Primera versión estable. Las funciones son las mismas de `1.0.0-rc.1`, sin un
solo cambio de comportamiento; la adoptó pf2e-simple-weapon-editor v0.14.0
(con rc.1), probada en Foundry v14 y publicada.

### Changed

- `baron-core.js`: `CORE_VERSION` = `"1.0.0"` y encabezado
  `SPDX-License-Identifier: MIT` con el copyright, para que la copia vendorizada
  diga su licencia por sí sola dentro de cualquier ZIP, también de pago. Cambia
  el sha256 del archivo: los módulos lo toman al resincronizar con
  `sync-core --ref v1.0.0`.
- `REGISTRY.md`: columna «envuelve» con los métodos internos de PF2e o Foundry
  que envuelve cada módulo.

### Added

- `LICENSE`: MIT.
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

[Unreleased]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BaronHVC/pf2e-baron-core/compare/v1.0.0-rc.1...v1.0.0
[1.0.0-rc.1]: https://github.com/BaronHVC/pf2e-baron-core/releases/tag/v1.0.0-rc.1
