# pf2e-baron-core

*English summary: pf2e-baron-core is the shared helper library of BaronHVC's
Pathfinder 2e modules for Foundry VTT. It is **not** a Foundry package: each
module vendors a byte-exact copy of `baron-core.js` into its own `scripts/`,
pinned by `baron-core.lock.json` (version, commit, sha256), and imports it with
a relative path. The repository also holds the two tools that keep those copies
honest (`tools/sync-core.mjs` copies and pins, `tools/check-module.mjs` runs the
static checks) and the reusable GitHub workflows every module calls for CI and
releases. The library has no side effects at import and registers nothing:
hooks, settings, helpers and sockets stay in each module's own entry files.*

## Qué es

- **`baron-core.js`**: un solo módulo ES con exports con nombre y **sin efectos
  al importarse**. No toca `game`, `CONFIG`, `Hooks`, `ui` ni `document` hasta que
  se llama una de sus funciones, y no registra nada (ni hooks, ni settings, ni
  helpers de Handlebars, ni sockets, ni elementos personalizados). Todo lo que
  identifica a un módulo (id, prefijo i18n, clases CSS) entra como parámetro.
- **`tools/`**: `sync-core.mjs`, `check-module.mjs`, `release-manifest.mjs`
  (la reescritura de `module.json` que corre `module-release`) y
  `sign-text.mjs` (la firma del autor sobre los textos humanos),
  `text-sheet.mjs` (la hoja donde las personas escriben esos textos), más
  `shared.mjs`, lo que comparten. Solo usan módulos de Node y `git`; corren
  igual en Windows y en Linux, sin `npm install`.
- **`.github/workflows/`**: la CI de este repo (`ci.yml`) y los dos workflows
  reutilizables que llaman los módulos (`module-check.yml`, `module-release.yml`).
  En **`.github/scripts/`**, lo que esos workflows corren aparte de `tools/`:
  `run-module-tests.mjs` (las pruebas del módulo) y `tap-annotate.mjs` (cada
  prueba roja como anotación pública).
- **No es un paquete de Foundry**: no tiene `module.json`, no se instala y no se
  publica en foundryvtt.com. Los usuarios nunca lo ven.

Lista de exports y su origen: [CHANGELOG.md](CHANGELOG.md). Espacios de nombres
de cada módulo: [REGISTRY.md](REGISTRY.md).

## Cómo lo usa un módulo

```
mi-modulo/
  module.json             sin "requires" al core; baron-core.js NO va en esmodules
  baron.json              configuración de la familia (ver abajo)
  baron-core.lock.json    { version, commit, sha256 }: qué copia del core lleva
  human-text.json         con "humanText": "signed", la firma del autor en cada texto; no va en el ZIP
  human-text-authors.json quién escribió cada texto firmado con --author o --sheet; no va en el ZIP
  scripts/
    main.js               import { createI18n, isSoleExecutor } from "./baron-core.js";
    baron-core.js         copia exacta del core; nunca se edita a mano
  .github/workflows/
    ci.yml                llama a module-check.yml@<commit del lock>
    release.yml           llama a module-release.yml@<commit del lock>
```

- La copia se carga solo por `import` desde los archivos del propio módulo, con
  ruta relativa (`./baron-core.js`). No se declara en `esmodules`.
- Cada módulo evalúa **su propia** copia en su propia URL
  (`modules/<id>/scripts/baron-core.js`). El estado interno del core (por ejemplo
  la caché de índices de compendio) es por módulo, y dos módulos con versiones
  distintas del core conviven en el mismo mundo sin pisarse.
- El ZIP del release incluye la copia dentro de `scripts/`; el usuario instala un
  solo paquete y no hay dependencia que resolver.

### baron.json

| campo        | valores                  | uso                                                                                  |
|--------------|--------------------------|--------------------------------------------------------------------------------------|
| `mode`       | `"public"`, `"protected"` | `protected`: módulo de pago, un complemento freemium alojado por Foundry (ver [Modo de pago](#modo-de-pago)) |
| `paizo`      | `"cup"`, `"orc"`        | licencia de Paizo que cubre el material del juego, independiente de `mode`: `cup` (Community Use Policy) solo para un proyecto sin ninguna parte de pago; `orc` para los de pago y para la base gratuita de un freemium. `protected` exige `orc` |
| `landingUrl` | URL `https`              | solo en `protected`, obligatoria: página pública del módulo (su Patreon, su página en foundryvtt.com); el release la pone como `url` de `module.json`. En `public` se ignora (el template la deja vacía) |
| `devChannel` | `true` / `false`         | publicar o no el canal de pruebas `dev` en cada release; en `protected` se ignora: nunca hay canal `dev` |
| `i18nPrefix` | texto                    | prefijo de las claves de idioma; en módulos nuevos es el id del módulo               |
| `langParity` | `"error"`, `"warn"`      | qué pasa si `en.json` y `es.json` no tienen las mismas claves                        |
| `persisted`  | lista de textos          | identificadores guardados en mundos (scope de flags, slugs, roll options) que nunca pueden desaparecer de `scripts/` |
| `humanText`  | `"markers"`, `"signed"`  | candado de textos humanos de la revisión `n`. Sin el campo o con `"markers"`, solo se busca el marcador `TODO-HUMANO:`, como siempre. Con `"signed"`, además cada texto necesita la firma de su autor en `human-text.json` (ver [Firmar los textos humanos](#firmar-los-textos-humanos)). Cualquier otro valor (un error de dedo, otras mayúsculas, otro tipo) falla la revisión `c`, y el candado sigue puesto: nunca se apaga en silencio. Los módulos nuevos nacen con `"signed"` |

Sin `baron.json`, `check-module` usa `{"mode":"public","devChannel":true,"i18nPrefix":<id>,"langParity":"error","persisted":[]}` y lo avisa. Sin `paizo`, la revisión `l` no revisa nada y solo lo avisa.

## Comandos

Desde la carpeta del módulo, con este repo clonado al lado
(`GitHub/personal/pf2e-baron-core`). Para clonarlo:
`git clone git@github-baron:BaronHVC/pf2e-baron-core.git` (alias SSH de la
cuenta BaronHVC) o `git clone https://github.com/BaronHVC/pf2e-baron-core.git`;
un clon normal trae las etiquetas que necesita `--online`.

```sh
# Vendorizar una versión publicada (etiqueta) o un commit concreto
node ../pf2e-baron-core/tools/sync-core.mjs --ref v1.6.0

# Desarrollo en vivo: copia el core de tu copia de trabajo en cada guardado
# (deja el lock en "dev"; check-module lo rechaza hasta que corras --ref)
node ../pf2e-baron-core/tools/sync-core.mjs --watch

# Revisiones antes de etiquetar
node ../pf2e-baron-core/tools/check-module.mjs
node ../pf2e-baron-core/tools/check-module.mjs --online     # además compara el lock con este repo
node ../pf2e-baron-core/tools/check-module.mjs --parity warn
node ../pf2e-baron-core/tools/check-module.mjs --online --release   # lo mismo que la CI de la etiqueta

# Textos humanos (con "humanText": "signed"): qué falta firmar, y firmarlo en tu terminal
node ../pf2e-baron-core/tools/sign-text.mjs .
node ../pf2e-baron-core/tools/sign-text.mjs . --sign
# Quien da fe ante Foundry firma por el autor real: el de cada fila de la hoja, o uno nombrado
node ../pf2e-baron-core/tools/sign-text.mjs . --sign --sheet textos-hoja.csv
node ../pf2e-baron-core/tools/sign-text.mjs . --sign --author IAR18

# Los mismos textos en una hoja: exportar lo que falta escribir, llenarlo en
# Excel o Google Sheets e importarlo (ver "Escribir los textos en la hoja")
node ../pf2e-baron-core/tools/text-sheet.mjs export
node ../pf2e-baron-core/tools/text-sheet.mjs import textos-hoja.csv

# Lo que module-release escribiría en module.json. Reescribe el archivo que le
# pasas: úsalo sobre una copia (en CI lo corre el workflow)
node ../pf2e-baron-core/tools/release-manifest.mjs copia/module.json --tag v1.2.0 --repo BaronHVC/<id> --channel stable
node ../pf2e-baron-core/tools/release-manifest.mjs copia/module.json --tag v1.2.0 --repo BaronHVC/<id> --channel stable --mode protected --landing-url https://www.patreon.com/<tú>
```

`sync-core`, `check-module` y `sign-text` aceptan la carpeta del módulo como
primer argumento (por defecto, la carpeta actual); `text-sheet export`
también, y `text-sheet import` la recibe después de la hoja.

**`sync-core --ref`** lee `baron-core.js` con `git show <commit>:baron-core.js`
(nunca hace checkout), lo normaliza a LF, verifica la línea
`export const CORE_VERSION = "..."` y, si `--ref` es una etiqueta, que la
etiqueta sea exactamente `v` + `CORE_VERSION`. Escribe `scripts/baron-core.js`,
`baron-core.lock.json` y reescribe a ese commit toda línea
`uses: BaronHVC/pf2e-baron-core/.github/workflows/<x>.yml@...` de
`.github/workflows/`. Los tres cambian juntos o no cambia ninguno.

**`check-module`** imprime PASS / FAIL / WARN / NOTICE por revisión y termina
con `check-module: N passed, N warnings, N failed`; sale con código 1 si algo
falló. En GitHub Actions los hallazgos salen además como anotaciones.

| id  | revisión                                                                                                         |
|-----|------------------------------------------------------------------------------------------------------------------|
| a   | existen los archivos de `module.json` (`esmodules`, `scripts`, `styles`, `languages`) y toda plantilla propia citada en `scripts/` (`modules/<id>/templates/….hbs` o con raíz interpolada, `` `${ROOT}/templates/….hbs` ``), con mayúsculas exactas: los servidores Linux no perdonan. Una ruta que empieza con `templates/` es de Foundry (`templates/generic/form-footer.hbs`) y no se revisa |
| b   | cada `scripts/**/*.js` pasa `node --check` como módulo ES                                                        |
| c   | `module.json`, `lang/*.json`, `baron.json` y el lock son JSON válido; `baron.json` tiene valores válidos         |
| d   | todos los idiomas tienen las mismas claves (FAIL o WARN según `--parity` / `langParity`)                          |
| e   | la copia del core coincide con el lock (sha256 en LF, `CORE_VERSION`) y el lock no es `dev`                     |
| f   | `--online`: la etiqueta `v<version>` apunta a `lock.commit`, ese commit tiene el mismo sha256 y todos los pins de los workflows son `lock.commit` |
| g   | ningún import absoluto (`/…`), hacia `modules/…` de otro módulo, relativo que salga del módulo ni sin ruta (`import "lodash"`: Foundry no define un import map y el navegador no lo resuelve); sin top-level await (heurística de columna 0, también `export const X = await …`) |
| h   | toda clave estática (`i18n("X")`, `"<prefijo>.X"`, `{{localize "<prefijo>.X"}}`) existe en `lang/en.json`; las claves armadas en tiempo de ejecución se saltan y las no usadas se cuentan en un aviso. Los nombres de hooks (`Hooks.callAll("<id>.x")`), de queries (`CONFIG.queries["<id>.x"]`, `user.query("<id>.x")`) y de settings (`game.settings.settings.get("<id>.x")`) no son claves |
| i   | cada texto de `persisted` sigue apareciendo en `scripts/` como literal completo, o como el texto antes del primer `${}` de una plantilla (`` `swe-p-${i}` `` cuenta para `swe-p-`); sin contar comentarios. Una subcadena no basta: el id también vive dentro de `"<id>.SettingGmOnly"` |
| j   | `module.json` sin clave `protected`, sin `requires` a pf2e-baron-core; aviso si `esmodules` lista la copia del core |
| k   | sin placeholders `__ALGO__` sobrantes del template (también en `NOTICE.md`)                                     |
| l   | `paizo` de `baron.json` es `cup` u `orc` y no es `cup` con `mode: protected`; `NOTICE.md` existe, trae el aviso de esa licencia (`used under Paizo's Community Use Policy` / `licensed under the ORC License`) y no trae el de la otra. El aviso se busca como lo muestra GitHub: partido en renglones, citado con `>`, con énfasis o como enlace cuenta; dentro de un comentario HTML no. Con `orc`, un hallazgo por cada renglón donde empieza un campo del template sin llenar (`[Title of Work]`, `[Copyright Notice]`, `[Author Credit Information]`, `[nombres, logos, …]`, `[ninguno]`, aunque esté partido en renglones; un enlace con ese texto no cuenta): WARN en cada push, FAIL con `--release`. Con cualquier licencia, lo mismo por cada renglón con el marcador `PENDIENTE:` (ver *Pendientes legales*). Con `orc`, aviso si el id o el título nombran a Paizo o sus juegos (PF2e, Pathfinder, Starfinder, Golarion): la ORC nunca licencia marcas de Paizo y el id no se puede cambiar; sigue siendo WARN con `--release`, porque es una pregunta legal abierta y no un campo por llenar. Sin `paizo`, solo un NOTICE (que a un módulo `protected` le dice que necesita `orc`), más los renglones con `PENDIENTE:` si hay `NOTICE.md`: el release lo empaca sea cual sea la licencia |
| m   | solo con `mode: protected`: `landingUrl` de `baron.json` es una URL `https` sin espacios que no apunta a GitHub (FAIL); `relationships.requires` de `module.json` lista al menos un módulo que no sea pf2e-baron-core, la base gratuita (WARN); y ningún otro texto ni clave de `module.json` fuera de `url`, `manifest` y `download` (que el release reescribe) menciona GitHub (FAIL: el release protegido lo rechazaría de todos modos, así que falla ya en cada push y no hasta la etiqueta). GitHub es `github.com` y sus subdominios, `githubusercontent.com` (archivos crudos y adjuntos de releases) y `github.io` (Pages), también con escapes `%2E`: todos pueden nombrar el repo privado. En un módulo `public` no imprime nada |
| n   | ningún valor de texto de los archivos de idioma (planos o anidados, a cualquier profundidad) ni el `title` o la `description` de `module.json` empieza con `TODO-HUMANO:`, el marcador de un texto que falta escribir a mano. Con `"humanText": "signed"` en `baron.json`, además cada valor de texto de los idiomas que declara `module.json` (si no declara ninguno, cada `lang/*.json`, como en `d` y `h`) y el `title` y la `description` tienen la firma de su autor en `human-text.json`: uno sin firma, cambiado después de firmarse, vacío, todavía con `TODO-HUMANO:` o con un surrogate UTF-16 suelto es un hallazgo, con un renglón por texto que nombra archivo y clave (los primeros 10 y luego `and N more`, con el comando de `sign-text` que los lista todos). También lo es cada `lang/*.json` que `module.json` no declara: viaja en el ZIP y sus textos no se pueden firmar. WARN en cada push; FAIL con `--release`, que pasa el workflow de la etiqueta. Un `human-text.json` mal formado falla siempre |

`--online` usa el repo indicado con `--core-repo <ruta>`; sin esa opción usa el
repo donde viven las propias herramientas.

`--release` es para el build de la etiqueta: lo que un push todavía puede
llevar pasa de WARN a FAIL. Hoy son la revisión `n` (los `TODO-HUMANO:` y, con
`"humanText": "signed"`, los textos sin firma) y, en la `l`, los campos
de la ORC sin llenar y los renglones con `PENDIENTE:` de `NOTICE.md`; el aviso
de marcas de la `l` sigue siendo WARN. `module-release` lo pasa (público y
protegido); `module-check`, en cada push, no.

**Textos humanos (`n`).** La política de IA de Foundry (manual del publicador,
4.1) pide que las etiquetas de la interfaz y el texto preparado (valores de
`lang/*.json`, texto de chat, el `title` y la `description` de `module.json`,
el texto del listado) los escriba una persona. La IA solo puede corregir o dar
formato a un texto humano, o traducirlo con la revisión de alguien que domine
el idioma; un texto de IA que una persona retoca probablemente no cumple: se
reescribe desde cero. Un texto que nadie ha escrito todavía lleva el valor
`TODO-HUMANO: <qué debe decir>`. Cuenta solo un valor que *empieza* con
`TODO-HUMANO:` (tras quitar los espacios iniciales; con mayúsculas exactas): un
texto que lo cita a media frase es texto real. Cada archivo con pendientes da
una línea con cuántos son y hasta cinco claves (`baron-fixture.Open`, `title`,
`description`), con la ruta anidada aplanada con puntos como lo hace Foundry.

El marcador solo protege lo que nadie escribió. Un módulo con
`"humanText": "signed"` puede llevar además, durante el desarrollo, textos de
trabajo escritos por IA en `lang/*.json`, porque el candado no los deja llegar
a un release: antes de etiquetar, el autor reescribe cada uno desde cero y lo
firma (ver [Firmar los textos humanos](#firmar-los-textos-humanos)). Sin el
candado, un texto de IA olvidado se publicaría.

**Pendientes legales (`l`).** `PENDIENTE:` es el marcador de la familia para un
dato legal de `NOTICE.md` que espera la firma del autor: una atribución sin
cotejar con el libro, una decisión que solo él toma. Quien redacta el aviso y no
puede cerrarlo escribe en ese renglón `PENDIENTE: <qué falta>`, o
`PENDIENTE (<quién>): <qué falta>` para nombrar quién decide. El énfasis no lo
esconde, ni alrededor de la palabra ni del paréntesis (`**PENDIENTE:**`,
`__PENDIENTE:__`, `**PENDIENTE**:`, `**PENDIENTE (<quién>)**:`), y puede haber
espacios antes de los dos puntos; solo una letra o un número pegados delante lo
anulan (`XPENDIENTE:`). Cuenta en cualquier parte del archivo, también dentro de
un comentario HTML (la firma sigue abierta aunque GitHub no la muestre), y solo
en mayúsculas y seguido de dos puntos: «pendiente:» en la prosa es texto. Cada
renglón con el marcador da un WARN en cada push y un FAIL con `--release`, así
que la etiqueta no publica un aviso sin firmar; al resolverlo, se borra el
marcador.

## Firmar los textos humanos

Con `"humanText": "signed"` en `baron.json` (los módulos nuevos ya lo traen),
la revisión `n` pide la firma del autor para cada texto: cada valor de texto de
los archivos de idioma que declara `module.json` (si no declara ninguno, cada
`lang/*.json`; con las claves anidadas aplanadas con puntos, igual que en las
revisiones `d` y `h`) y el `title` y la `description` de `module.json`. La
firma es el sha256 del valor exacto, tal como sale del JSON: sin recortar
espacios ni normalizar saltos de línea o acentos, así que cualquier cambio,
aunque sea un espacio, pide firmar otra vez. Un valor con un surrogate UTF-16
suelto (un escape de JSON a medias) nunca se firma: en UTF-8 se vuelve U+FFFD
y su hash no lo distinguiría de otro valor. Un `lang/*.json` que `module.json`
no declara viaja en el ZIP (que empaca `lang/` entero) con textos que nadie
puede firmar, así que también es un hallazgo: se declara o se saca de `lang/`.

El candado no ve las etiquetas de compendios (`packs[].label`,
`packFolders[].name`), el texto fijo de `templates/*.hbs` ni el texto de chat
armado en `scripts/`: esos los escribe una persona desde el principio, sin
borrador de IA.

Las firmas viven en `human-text.json`, en la raíz del módulo, y van al repo
con el resto del código. El ZIP del release nunca lo lleva (solo empaca
`module.json`, `scripts`, `styles`, `templates`, `lang`, `packs`, `LICENSE` y
`NOTICE.md`). Lo escribe solo `sign-text`, con las claves ordenadas, sangría de
dos espacios y LF:

```json
{
  "signed": {
    "lang/en.json": { "<clave>": "<sha256 del valor>" },
    "module.json": { "description": "<sha256>", "title": "<sha256>" }
  },
  "version": 1
}
```

Desde la carpeta del módulo:

```sh
# Lista lo que falta firmar: archivo, clave y valor de cada texto sin firma o cambiado
node ../pf2e-baron-core/tools/sign-text.mjs .

# Firma, una pregunta por cada texto pendiente
node ../pf2e-baron-core/tools/sign-text.mjs . --sign
```

- **Sin `--sign`** solo lista y sale con 0: cada texto sin firma o cambiado
  desde que se firmó, con su archivo, su clave y su valor, y la cuenta. Como
  información, los textos que faltan escribir (vacíos o con `TODO-HUMANO:`) y
  las firmas de claves que ya no existen (una por renglón, las primeras 10).
  Si algo falta firmar, el último renglón (`next:`) dice que, una vez que una
  persona escribió cada texto desde cero, quien da fe (BaronHVC) los firma
  nombrando al autor, con los comandos de `--sheet textos-hoja.csv` y de
  `--author <nombre>`. También avisa de los temporales que dejó un `--sign`
  que no terminó (ver abajo).
- **Con `--sign`** explica antes de la primera pregunta qué hace cada
  respuesta. Luego muestra archivo, clave y valor completo de cada texto
  pendiente y pregunta «¿Escribiste tú este texto desde cero? [s/N/q]»: `s` lo
  firma, `N` o Enter lo salta, `q` termina y guarda lo firmado hasta ahí; otra
  respuesta vuelve a preguntar. Nunca firma un valor vacío ni uno que empieza
  con `TODO-HUMANO:`: los muestra como textos por escribir. Escribe
  `human-text.json` una sola vez, al final o con `q` (en un archivo temporal que
  luego renombra), y de paso quita las firmas de claves que ya no existen. Un
  Ctrl+C o el fin de la entrada (Ctrl+D) antes de eso lo deja intacto y dice
  cuántas firmas de esa corrida se perdieron: para conservarlas, se contesta
  `q`. Cada 50 preguntas recuerda cuántas firmas lleva sin guardar, y con `q`
  el último renglón (`to continue:`) da el comando para seguir: lo firmado no
  se vuelve a preguntar, lo saltado sí. Si otro programa (un editor, un cliente de sincronización, el
  antivirus) tiene abierto `human-text.json`, reintenta el renombrado unos 2
  segundos; si no puede, deja las firmas en el archivo temporal y dice dónde
  está.
- **La firma la da una persona, a mano.** Contestar `s` dice «este texto lo
  escribí yo desde cero» (con `--author` o `--sheet`, «este autor lo escribió
  desde cero», y quien firma da fe de ello; ver abajo): revisar o retocar un
  texto de IA no basta. Por eso `--sign` exige que stdin y stdout sean una
  terminal (TTY) y no hay `--yes` ni otra forma de firmar sin preguntar. Una
  sesión de Claude nunca corre `--sign` ni edita `human-text.json` ni
  `human-text-authors.json`. Una traducción hecha con IA cuenta solo cuando la
  revisa, línea por línea contra su original humano, una persona que domina el
  idioma, y es esa persona quien la firma: en una traducción, su `s` dice
  «domino este idioma y revisé esta traducción», y así lo explica `--sign`
  antes de la primera pregunta.
- **Es un compromiso, no una prueba.** El sha256 no lleva llave: un programa
  puede escribir `human-text.json`, y quitar `humanText` de `baron.json` apaga
  el candado. Lo que lo sostiene es revisar quién hace commit de esos dos
  archivos.
- **En Windows**, córrelo en una ventana de terminal: PowerShell, Windows
  Terminal o Git Bash, sin tubería ni redirección (nada de `|`, `>`,
  `Tee-Object` ni `more`): con una, stdin o stdout deja de ser una TTY y
  `--sign` se niega, y el mensaje dice cuál. Solo con un Git for Windows
  anterior a 2.54, Git Bash (mintty) no le da una TTY a node; ahí se corre con
  `winpty node ../pf2e-baron-core/tools/sign-text.mjs . --sign`.

En `check-module`, un texto sin firma, cambiado, vacío o con `TODO-HUMANO:`, y
un `lang/*.json` sin declarar, dan un WARN en cada push y un FAIL con `--release`, así que la etiqueta no publica
un texto que una persona no firmó. Sin `human-text.json`, todos cuentan como
sin firma. Un `human-text.json` mal formado (JSON inválido, otra forma, otra
`version`) falla siempre, también en un push: se restaura desde git, o se borra
y se firma todo otra vez. Las firmas de claves que ya no existen no cuentan, y
el siguiente `--sign` las quita. Sin `humanText` (o con `"markers"`) nada de
esto corre y `human-text.json` se ignora: los módulos que no lo piden se
revisan como antes.

### Firmar por el autor: `--author` y `--sheet`

Los textos los escriben BaronHVC o IAR18. IAR18 escribe en la hoja, en el
navegador, y no tiene terminal ni el repo; por eso firma quien da fe de los
textos ante Foundry al subir el paquete, BaronHVC, y contesta por cada texto
si su autor lo escribió desde cero. Cada firma guarda quién lo escribió:

```sh
# Lo que import ya escribió de la hoja: una pregunta por texto, por el autor de su fila
node ../pf2e-baron-core/tools/sign-text.mjs . --sign --sheet textos-hoja.csv

# Todos los textos pendientes, de un solo autor
node ../pf2e-baron-core/tools/sign-text.mjs . --sign --author IAR18
```

- **`--author <nombre>`** es el mismo `--sign`, pero pregunta «¿<nombre>
  escribió este texto desde cero? [s/N/q]» y cada `s` guarda `<nombre>` como
  autor de esa firma. El nombre se recorta y se guarda en Unicode NFC (un
  acento escrito de dos maneras es un solo nombre), y debe quedar de 1 a 60
  caracteres, sin caracteres de control (un tabulador, un salto de línea) ni
  caracteres que no se ven (un espacio de ancho cero, un guion suave, una
  marca de dirección, un separador de línea o de párrafo, uno de uso privado
  o un no carácter), que harían pasar un nombre por otro; si no, sale con 2
  sin preguntar nada, y el mensaje muestra el carácter escondido como
  `\u200b`. Si el nombre solo difiere en mayúsculas de uno ya guardado
  (`iar18` e `IAR18`), lo avisa antes de la primera pregunta: serían dos
  autores.
- **`--sheet <archivo.csv>`** lee la hoja con el mismo lector de `text-sheet
  import` (la ruta, desde la carpeta donde se corre; si no está ahí, el
  mensaje dice dónde buscó y, si la carpeta del módulo tiene una con ese
  nombre, cómo pasarla) y solo pregunta por las celdas de idioma con texto,
  más `module.json:title` y `module.json:description` en la columna del
  primer idioma, con la clave y el idioma con que `import` las escribe, que
  `import` acepta (las revisa igual que él), cuyo valor en el módulo es el de
  la celda byte por byte (con los saltos de línea como los escribe `import`)
  y que necesitan firma. La pregunta nombra al `author` de su fila, y la
  firma lo guarda. Antes de preguntar dice cuántos textos lleva cada autor y
  avisa de dos nombres que solo difieren en mayúsculas. Lista sin preguntar,
  con renglón, idioma y clave (nunca el valor, que podría ser un texto de
  IA): las celdas que `import` no escribe en ningún lado, las que rechaza
  (con su motivo: un `{marcador}` que falta, dos filas con textos distintos
  para una clave…) y las columnas que rechaza, las celdas cuyo valor en el
  módulo es otro (sin importar todavía, o cambiadas después), los textos ya
  firmados (solo los cuenta, salvo los que tienen guardado otro autor que el
  de su fila, o ninguno: esos los lista con los dos nombres, y el registro
  no cambia, porque `sign-text` nunca cambia el autor de una firma válida),
  las filas sin `author` o con un nombre que no vale y un texto que dos filas
  dan con autores distintos. Un texto que varias filas dan con el mismo autor
  se pregunta una vez. También cuenta los textos pendientes que la hoja no
  trae, que se firman aparte, y los del módulo que faltan escribir, sin
  mostrarlos.
- `--author` y `--sheet` juntos, o sin `--sign`, salen con 2. Como `--sign`,
  exigen una terminal y no hay forma de contestar sin una persona.
- Sin `--author` ni `--sheet`, `--sign` pregunta como siempre («¿Escribiste tú
  este texto desde cero?»), no guarda autor y, si el texto tenía uno de una
  firma anterior, lo quita. Para que cada firma diga quién escribió el texto,
  BaronHVC firma también los suyos con su hoja y `--sheet`, o con
  `--author BaronHVC`.

Los autores viven en `human-text-authors.json`, junto a `human-text.json`, y
van al repo como él (la plantilla no lo ignora); el ZIP del release nunca lo
lleva. Lo escribe solo `sign-text`, con el mismo formato: claves ordenadas,
sangría de dos espacios, LF y salto de línea final.

```json
{
  "authors": {
    "lang/es.json": { "<clave>": "IAR18" },
    "module.json": { "description": "BaronHVC" }
  },
  "version": 1
}
```

Se escribe solo cuando cambia `human-text.json` y en el mismo paso: los dos
por archivo temporal y renombrado, en este orden: el de autores sin las
entradas que la corrida quita o reemplaza, luego `human-text.json`, y al
final el de autores con las entradas nuevas. Así, si la corrida se corta
entre dos renombrados (se cierra la ventana), una firma puede quedar sin
autor, pero nunca con el de otra firma. Si un renombrado falla, todo lo ya
reemplazado vuelve a como estaba y lo nuevo de los dos queda en sus
temporales, y el mensaje dice dónde; el listado avisa de los temporales que
queden (`.human-text.json.<pid>.tmp`, `.human-text-authors.json.<pid>.tmp`).
Nunca se crea vacío. Las
firmas de claves que ya no existen se llevan a su autor, y una entrada que no
tiene firma se quita. `check-module` no lo lee: con este núcleo o con uno
anterior (v1.5.0, v1.6.0), su resultado es el mismo con el archivo o sin él,
y `human-text.json` conserva su formato. Uno mal formado detiene a
`sign-text`, también al listar: se restaura desde git (borrarlo olvida
quién escribió cada texto). Sin `--sign`, `sign-text` lista cada texto
firmado que tiene autor (`signed    lang/es.json  <clave>  by "IAR18"`) y
cuántos lleva cada autor; sin autores guardados, lista lo mismo que v1.6.0
salvo el renglón `next:`, que ahora nombra `--sheet` y `--author`.

## Escribir los textos en la hoja

Un módulo puede tener cientos de textos por escribir (los de trabajo de la IA
y los `TODO-HUMANO:`), y escribirlos en una terminal es lento. `text-sheet`
los pone en una hoja de cálculo: una fila por texto, con dónde aparece, qué
debe comunicar y qué marcadores debe llevar, y una columna vacía por idioma.
Las personas que escriben los textos (BaronHVC e IAR18) la llenan en Excel o
en Google Sheets, `text-sheet import` los pasa a los archivos de idioma y en
seguida quien da fe de ellos, BaronHVC, los firma con `sign-text --sign
--sheet`, contestando por el autor de cada fila. El flujo:

```sh
# 1. Desde la carpeta del módulo: escribe textos-hoja.csv con lo que falta escribir
node ../pf2e-baron-core/tools/text-sheet.mjs export

# 2. Quienes escriben leen las reglas de docs/textos-borrador.md, llenan las
#    columnas de idioma y su nombre en "author", y guardan la hoja como CSV UTF-8

# 3. Revisa qué cambiaría, y escríbelo en lang/*.json (y en module.json)
node ../pf2e-baron-core/tools/text-sheet.mjs import textos-hoja.csv --dry-run
node ../pf2e-baron-core/tools/text-sheet.mjs import textos-hoja.csv

# 4. En seguida, antes del siguiente export: BaronHVC, que da fe de los textos,
#    los firma en su terminal; cada pregunta nombra al "author" de su fila
node ../pf2e-baron-core/tools/sign-text.mjs . --sign --sheet textos-hoja.csv
```

Firma antes de exportar otra vez. Una hoja nueva lista como «por escribir»
todo texto sin firma, también el que una persona acaba de importar, y el otro
autor lo escribiría de nuevo; por eso, con el candado, `export` no reemplaza
una hoja que trae un texto importado y todavía sin firma, y lo dice con su
renglón, su clave y su idioma. Con dos autores, cada uno pone su nombre en la
columna `author` de lo que escribió (una sola hoja para los dos) o usa su
propia hoja (`export --out textos-hoja-IAR18.csv`); al final, `import` lista
las filas de cada nombre. `sign-text --sheet` pregunta por cada texto
«¿<author> escribió este texto desde cero?», con el nombre de su fila, y lo
guarda con la firma en `human-text-authors.json` (ver [Firmar por el autor](#firmar-por-el-autor---author-y---sheet)):
quien firma contesta por ese autor, y salta lo que no sabe. Una fila sin
`author` no se pregunta: se le pone el nombre y se corre otra vez.

**La hoja nunca muestra un texto de IA.** Retocar el texto de la IA no cumple
la política de IA de Foundry (§4.1): el texto se escribe desde la intención,
no desde la frase de la IA. Por eso las columnas de idioma salen vacías, y
`current_<idioma>` solo trae un valor cuya firma es válida (uno que una
persona ya escribió y firmó, que sirve de original para traducir). Un texto
sin firma, cambiado desde que se firmó o con `TODO-HUMANO:` nunca aparece, ni
en la hoja ni en lo que imprime `import`, y no hay opción que lo muestre.
Tampoco pasa a la hoja una celda de `docs/textos-borrador.md` que cite un texto
sin firma: una oración de siete palabras o más en cualquier parte de la celda,
o cualquier texto completo entre comillas (`"…"`, `“…”`, `«…»`, `'…'`); esa
celda sale vacía y `export` avisa con la clave, la columna y la línea, nunca
con el texto. Un texto corto sin comillas («Runas de propiedad») suele ser el
nombre llano de la cosa y no se toca. Una sesión de Claude puede correr
`export` e `import`, pero nunca llena las columnas de idioma.

### `export`

```sh
node ../pf2e-baron-core/tools/text-sheet.mjs export [<carpeta del módulo>] [--out <archivo.csv>] [--all]
```

Escribe `textos-hoja.csv` en la raíz del módulo (o donde diga `--out`): UTF-8
con BOM, separado por comas, con comillas de RFC 4180 (una celda puede llevar
saltos de línea y comillas dobladas) y CRLF, para que Excel en español de
México y Google Sheets lo abran tal cual. Nunca escribe dentro de lo que
empaca el release (`module.json`, `scripts`, `styles`, `templates`, `lang`,
`packs`, `LICENSE`, `NOTICE.md`). Tampoco reemplaza una hoja que todavía
sirve: una con un texto que no se ha importado (si `import` lo rechazó, se
corrige o se vacía la celda), una con un texto importado que aún no tiene
firma (con el candado) o una con texto en una columna que `import` no lee
(las notas incluidas); el mensaje dice el renglón, la clave y el idioma. La
hoja guarda borradores de personas: va en el `.gitignore` del módulo con dos
líneas, `textos-hoja*` (todas las hojas: la de cada autor y el `.xlsx` donde
se trabaja) y `~$*` (el archivo de bloqueo que Excel deja junto a lo que
tiene abierto); la plantilla ya las trae y, si faltan, `export` avisa.

Por omisión trae solo los textos que todavía necesitan a una persona: con
`"humanText": "signed"`, los mismos que listan `sign-text` y la revisión `n`
(sin firma, cambiados desde que se firmaron, por escribir y los demás que no
tienen firma válida, como una lista o una clave definida dos veces); sin el
candado, los mismos que reporta la revisión `n`: los que empiezan con
`TODO-HUMANO:`, también dentro de una lista o en una de las dos copias de una
clave definida anidada y con puntos (un texto vacío no). Con `--all`, todos
los textos de los idiomas que declara `module.json`, más su `title` y su
`description`. Las filas siguen el orden de `docs/textos-borrador.md` (sus
secciones, pantalla por pantalla); al final van las que no tienen fila ahí.

| columna            | qué trae |
|--------------------|----------|
| `key`              | la clave con puntos (`baron-traps.CardTriggered`), o `module.json:title` / `module.json:description` |
| `where`            | en un solo renglón: dónde aparece, según `docs/textos-borrador.md`, una raya (—) y los `archivo:línea` de `scripts/` y `templates/` que usan la clave (el mismo rastreo de la revisión `h`; una clave armada en tiempo de ejecución apunta a donde se arma) |
| `intent`           | la intención, de `docs/textos-borrador.md`, y por cada concepto de su tabla de conceptos, «mismo término que» las otras claves que lo nombran |
| `placeholders`     | los `{marcadores}` que el texto debe conservar: los del valor actual en los idiomas (o los de `docs/textos-borrador.md` si todos siguen con `TODO-HUMANO:`). Un marcador es una llave con un nombre (`{victim}`, `{actor.name}`); la etiqueta de un enricher (`@Check[...]{Etiqueta}`, `@UUID[...]{Nombre}`) y una llave con espacios son texto, que la persona reescribe |
| `max_length`       | el largo máximo de `docs/textos-borrador.md`, en caracteres sin contar los marcadores |
| `status`           | `unsigned`, `changed`, `to write`, `signed`, `conflict`, `list`, `broken`; sin el candado, `to write` (con `TODO-HUMANO:`), `no marker` (sin marcador: la herramienta no sabe quién lo escribió), `empty`, `conflict`, `list` o `broken`; por idioma cuando difieren (`en: signed; es: changed`), y `missing` si un idioma no tiene la clave |
| `en`, `es`, …      | vacías: aquí se escribe, una columna por idioma de `module.json` |
| `current_en`, …    | el valor firmado de cada idioma, y nada si no tiene firma válida |
| `author`           | vacía: quien escribe pone aquí su nombre; `import` solo lo repite al final, no lo escribe en ningún lado; `sign-text --sheet` lo nombra en cada pregunta y lo guarda con la firma |
| `section`          | el encabezado de `docs/textos-borrador.md` arriba de la fila (la pantalla), para ordenar y filtrar |

El título y la descripción de `module.json` son un solo texto para todos los
idiomas: se escriben en la columna del primer idioma que declara
`module.json` (normalmente `en`).

`export` avisa, sin fallar, de cada texto sin firma que no tiene fila en
`docs/textos-borrador.md` (sale con la intención vacía; con `--all`, también
los que no tienen marcador), de cada fila cuya clave no existe, de una clave
con dos filas, de los marcadores que no coinciden con los del texto, de una
celda del borrador que cita un texto sin firma (sale vacía), de una celda que
empieza con `=`, `+`, `-` o `@` (Excel la abre como fórmula y muestra
`#¿NOMBRE?`), de un `lang/*.json` que `module.json` no declara (la hoja no lo
trae y la revisión `n` lo reporta) y de un archivo de idioma o un
`module.json` que empieza con BOM (`sign-text` y `check-module` lo rechazan:
se guarda como UTF-8 sin BOM antes de firmar); y cuenta las filas de textos ya
firmados en todos los idiomas, que se pueden borrar. Un JSON roto lo reporta
con su renglón y su columna, sin citarlo.

### Formato de `docs/textos-borrador.md`

`export` lee las intenciones de las tablas de este archivo:

- Lista textos cada tabla de markdown cuyo encabezado tiene una columna
  `clave`. Las demás tablas (por ejemplo, una de conceptos con «Claves donde
  aparece»), la prosa y lo que está dentro de un bloque de código o de un
  comentario HTML se ignoran, así que el archivo puede tener secciones,
  notas y varias tablas.
- Las columnas se encuentran por el nombre de su encabezado, en cualquier
  orden y sin importar acentos ni mayúsculas: `clave` (la única obligatoria),
  `dónde aparece` (o `dónde`), `intención` (o `qué comunica`), `variables` (o
  `marcadores`) y `máx.` (o `largo máximo`). Las demás, como `archivo`, se
  ignoran.
- En `clave`, la clave va entre backticks. Puede omitir el prefijo de idioma
  del módulo (`` `CardTriggered` `` vale por `baron-traps.CardTriggered`).
  Varias claves en la misma celda comparten la fila. El título y la
  descripción se escriben `` `module.json:title` `` y
  `` `module.json:description` ``.
- En `variables`, cuenta cada `{nombre}` de la celda; vacía o con `—`,
  ninguno.
- En `máx.`, cuenta el primer número de la celda.
- Un `|` dentro de una celda se escribe `\|`, y `<br>` es un salto de línea.
- La columna `section` de cada fila es el encabezado (`#`, `##`, `###`) que
  está arriba de su tabla: agrupa las filas por pantalla y la hoja sigue ese
  orden.
- Una tabla de conceptos (con una columna `claves`, como «Claves donde
  aparece», y sin columna `clave`) no da filas: a cada clave de un renglón le
  agrega a su intención «mismo término que» las otras claves de ese renglón,
  con el concepto entre paréntesis (la primera otra celda).
- Ninguna celda trae el texto de trabajo, ni completo ni entre comillas: la
  intención dice qué comunica, nunca cómo. Una celda que cite un texto sin
  firma sale vacía en la hoja (ver arriba).

La hoja solo trae lo de las tablas. Las reglas de la prosa del archivo
(términos de PF2e, tono, sin HTML, el ancho del panel) también son para
quienes escriben: `export` les pide leerlas antes de llenar la hoja.

```markdown
| clave | dónde aparece | intención | variables | máx. |
|---|---|---|---|---|
| `CardTriggered` | título de la tarjeta de chat que reciben los GM | quién activó qué peligro, de un vistazo | `{victim}`, `{hazard}` | 60 |
| `module.json:description` | lista de módulos de Foundry | qué agrega el módulo, en una o dos oraciones | — | 200 |
```

### Llenarla en Excel (español de México) o en Google Sheets

- **Abrir en Excel:** con doble clic. El BOM le dice a Excel que es UTF-8 y
  la coma es el separador de listas de Windows en español de México. Si todo
  cae en la columna A (un Windows configurado con punto y coma, como el de
  España), ábrela desde **Datos > Desde el texto/CSV** con origen
  «65001: Unicode (UTF-8)» y delimitador «Coma».
- **Antes de escribir:** selecciona las columnas de idioma y dales formato
  **Texto** (Inicio > Número), para que Excel no convierta lo que escribes:
  `= nivel` en una fórmula (`#¿NOMBRE?`), `1/2` en una fecha, `+2` en `2`,
  `1,000` en `1000`. Un salto de línea dentro de la celda es **Alt+Enter**.
- **Trabaja en un .xlsx:** en seguida, **Guardar como > Libro de Excel
  (.xlsx)** (`textos-hoja.xlsx`, junto a la hoja) y sigue en ese archivo
  hasta terminar. Un CSV no guarda formatos: al volver a abrirlo con doble
  clic, Excel lee de nuevo cada celda y convierte lo ya escrito, y el
  siguiente «Guardar como CSV» guarda lo convertido. Nunca vuelvas a abrir el
  CSV para seguir escribiendo.
- **Guardar para importar:** desde el .xlsx, Archivo > Guardar como >
  **«CSV UTF-8 (delimitado por comas)»** con el nombre `textos-hoja.csv`. No
  «CSV (delimitado por comas)»: ese guarda en la página de códigos de
  Windows, que ya cambió por `?` lo que no cabe, e `import` lo rechaza.
  «Texto Unicode» también sirve. Si Excel guarda con punto y coma, `import`
  lo detecta. Cierra el archivo en Excel antes de importar o de volver a
  exportar: Excel lo deja bloqueado.
- No escribas un apóstrofo para evitar una conversión: en una celda con
  formato Texto puede quedarse en el texto (`import` avisa de un texto que
  empieza con `'`, y de uno que es solo un número o una fecha). `import`
  rechaza una celda con un error de hoja de cálculo (`#¿NOMBRE?`, `#NAME?`,
  `#N/A`, `#¡VALOR!`, `#¡REF!`, …).
- **Google Sheets:** Archivo > Importar > Subir, con «Detectar
  automáticamente» como separador y sin «Convertir texto en números, fechas y
  fórmulas». Antes de escribir, selecciona las columnas de idioma y elige
  Formato > Número > **Texto sin formato**. Al terminar: Archivo > Descargar >
  «Valores separados por comas (.csv)». La descarga queda en Descargas con el
  nombre de la hoja de cálculo y de la pestaña, `textos-hoja - textos-hoja.csv`;
  impórtala con esa ruta entre comillas (en la ruta, Descargas se llama
  `Downloads`; sirve en PowerShell y en Git Bash):
  `node ../pf2e-baron-core/tools/text-sheet.mjs import "$HOME/Downloads/textos-hoja - textos-hoja.csv"`.
  Si `import` recibe una hoja sin ningún texto en las columnas de idioma, se
  detiene y lo recuerda: casi siempre es la hoja sin llenar que dejó `export`.
- Se pueden ordenar o filtrar las filas (por `section`, por ejemplo) y mover
  columnas: `import` busca cada columna por su nombre, empata cada fila por su
  `key` y encuentra el encabezado aunque un orden lo haya dejado entre las
  filas (ordena con «Mis datos tienen encabezados» marcado). Para notas
  propias, agrega una columna `notas`: `import` la ignora. Una columna con
  texto que `import` no lee la rechaza, para que un texto escrito bajo un
  idioma mal nombrado (`es-MX`, `Español`) nunca se pierda en silencio. Lo que
  se escriba en `current_<idioma>` no se lee (si cambió una celda, lo avisa).

### Una hoja hecha en otra parte

Una hoja que arma otra herramienta (una página web donde escribe IAR18, por
ejemplo) se importa igual si sus columnas llevan los nombres de `export`.
`import` lee solo `key`, `author` (o `autor`) y una columna por idioma de
`module.json` (`en`, `es`, …). Ignora `where`, `intent`, `placeholders`,
`max_length`, `status`, `section`, `current_<idioma>` y las de notas
(`notas`, `nota`, `notes`, `note`, `comentarios`, `comments`). Cualquier
otra columna con texto la rechaza, y entonces, sin `--partial`, no escribe
nada de la hoja (y `sign-text --sheet` lo dice). Para darle contexto a quien
escribe, sin nombres propios:

- la descripción de lo que debe decir cada texto va en `intent`, y dónde
  aparece en `where`, como los deja `export` a partir de
  `docs/textos-borrador.md`;
- el texto que había antes va en `current_<idioma>`, y solo si tiene firma
  válida, como lo deja `export`: nunca el texto de trabajo de la IA (política
  de IA de Foundry, 4.1), que no debe ser el punto de partida de nadie;
- el espacio para escribir es la columna del idioma; una nota libre va en
  `notas`;
- las filas `module.json:title` y `module.json:description` se escriben
  solo en la columna del primer idioma de `module.json`.

### `import`

```sh
node ../pf2e-baron-core/tools/text-sheet.mjs import <archivo.csv> [<carpeta del módulo>] [--dry-run] [--partial]
```

Lee la hoja como la guardan Excel o Google Sheets: con o sin BOM (también
UTF-16, el «Texto Unicode» de Excel), separada por comas, punto y coma o
tabuladores (lo decide el renglón de encabezado), con CRLF o LF, con celdas
entre comillas que tienen saltos de línea, con renglones o columnas vacíos de
más, con las columnas en otro orden y con el encabezado donde lo haya dejado un
orden. Cada celda de idioma con algo escrito se revisa, y se rechaza si:

- la clave no existe en el archivo de ese idioma: `import` nunca crea claves;
- es una lista o una clave definida dos veces (anidada y con puntos) con
  valores distintos: esas se arreglan a mano;
- sus `{marcadores}` no son exactamente los que debe conservar (puede
  repetirlos o cambiarlos de orden, no quitar ni agregar uno);
- empieza con `TODO-HUMANO:`, solo tiene espacios o es un error de hoja de
  cálculo (`#¿NOMBRE?`, `#NAME?`, `#N/A`, `#¡VALOR!`, …);
- es el título o la descripción de `module.json` en otra columna que no sea la
  del primer idioma;
- otra fila, u otra columna de idioma que escribe en el mismo archivo, le da a
  la misma clave un texto distinto.

También rechaza una columna que no lee (ni `key`, ni `author`, ni un idioma,
ni una de las que escribe `export`, ni una de notas) si tiene texto. Pasarse de
`max_length`, tener espacios al principio o al final, empezar con un
apóstrofo y ser solo un número o una fecha solo avisan. Una celda igual al
valor que ya tiene el archivo y que no tiene firma no escribe nada ni cuenta
como «sin cambios»: `import` lo avisa, sin citarlo, una línea por celda hasta
10 y luego cuántas más (si lo escribió una persona, por ejemplo al importar
otra vez una hoja que todavía no se firmó, BaronHVC lo firma por su autor con
`sign-text --sheet`, y el último renglón da el comando; si se copió de
`lang/*.json`, es el texto de trabajo y se escribe de nuevo). Una hoja sin
ningún texto en las columnas de idioma lo detiene: probablemente no es el
archivo que se guardó.

Con una sola celda rechazada no escribe nada y lista cada motivo con su número
de renglón (el que muestra la hoja). `--partial` escribe las celdas válidas y
lista las rechazadas; `--dry-run` no escribe nada y muestra qué cambiaría. Sale
con 1 si rechazó alguna celda. Al final lista las filas de cada nombre de la
columna `author`.

En cada archivo cambia solo los valores editados, byte por byte: el orden de
las claves, el anidamiento, la sangría, los fines de línea, el BOM, el salto de
línea final y el estilo de los escapes (un archivo que escapa los acentos los
sigue escapando) quedan igual. Una clave escrita anidada y con puntos cambia
en los dos lugares. Escribe con archivos temporales y renombrados: o se
escriben todos los archivos, o ninguno. Nunca toca `human-text.json` ni
firma: un texto nuevo queda sin firma (o cambiado, si reemplaza uno firmado), y
el último renglón dice el paso siguiente: que quien da fe de los textos
(BaronHVC) los firme en su terminal, contestando por el autor de cada fila,
con el comando exacto, `node ../pf2e-baron-core/tools/sign-text.mjs . --sign
--sheet <la hoja>` (con la ruta de `sign-text`, la carpeta del módulo y la de
la hoja tal como se corrió `text-sheet`; igual las demás sugerencias de las
dos órdenes). Un archivo de idioma o un `module.json` con BOM
conserva su BOM, pero `import` avisa que `sign-text` lo rechaza.

## Workflows reutilizables

En el módulo (el template ya los trae; `sync-core` reescribe el `<sha>`):

```yaml
# .github/workflows/ci.yml
on: [push, pull_request]
jobs:
  check:
    uses: BaronHVC/pf2e-baron-core/.github/workflows/module-check.yml@<sha>

# .github/workflows/release.yml
on:
  push:
    tags: ["v*"]
permissions:
  contents: write   # obligatorio: un workflow reutilizable no puede ampliar permisos
jobs:
  release:
    uses: BaronHVC/pf2e-baron-core/.github/workflows/module-release.yml@<sha>
```

- El pin es un commit completo, el mismo de `baron-core.lock.json`: nada se mueve
  bajo un módulo. Recibir un arreglo del pipeline = resincronizar el core.
- Ambos workflows hacen checkout de este repo **en el commit del lock** (con
  etiquetas) y corren `check-module --online` antes de cualquier otra cosa;
  `module-release` le agrega `--release`, así que un `TODO-HUMANO:` o, con
  `"humanText": "signed"`, un texto sin firma (revisión `n`), un campo de la
  ORC sin llenar o un `PENDIENTE:` en `NOTICE.md` (revisión `l`), que en cada
  push solo avisan, detienen la etiqueta.
- Después de `check-module`, los dos corren **las pruebas de node del propio
  módulo** con `.github/scripts/run-module-tests.mjs`, en el checkout del módulo
  (no en `.baron-core`): un `import` de `../scripts/*.js`, la copia vendorizada
  del core incluida, resuelve igual que en local. Corre lo primero que
  encuentre:
  1. un script `test` en `package.json`: `npm test`. Antes, solo si
     `package.json` declara `dependencies` o `devDependencies`, `npm ci` (con
     `package-lock.json` o `npm-shrinkwrap.json`) o `npm install --no-audit
     --no-fund` (sin lockfile). El `echo "Error: no test specified" && exit 1`
     que deja `npm init` no cuenta: un aviso y sigue con el punto 2;
  2. si no, `node --test` con la lista explícita de los `*.test.mjs` y
     `*.test.js` bajo `test/` y `tests/`, a cualquier profundidad (sin
     `node_modules` ni carpetas con punto). Nunca un `node --test` a secas, que
     también cargaría `fixtures/` y `helpers/`: lo que no termina en `.test.mjs`
     o `.test.js` no corre. Node 22+ lee cada ruta como glob, así que una con
     `* ? [ ] { } ( ) ! + @` o `\` podría no encontrar nada y pasar con 0
     pruebas: el paso falla y pide renombrar ese archivo;
  3. si no hay ninguno de los dos, un aviso «no tests found» y el paso pasa.

  Una prueba roja tumba el job. Con `node --test`, cada una sale además como
  anotación pública vía `tap-annotate.mjs` (el log del job solo lo bajan los
  admins del repo); con `npm test`, una anotación con el código de salida. En
  `module-release` el paso va antes de reescribir `module.json` y de armar el
  ZIP, en modo público y protegido: una etiqueta con una prueba roja no
  publica. El paso tiene un tope de 15 minutos: una prueba que deja un timer o
  un servidor abierto lo tumba ahí, no a las 6 h. El reporte TAP va a
  `RUNNER_TEMP`, fuera de lo que se empaca. Un
  módulo lo recibe al resincronizar con una etiqueta del core que lo traiga
  (v1.4.0 o posterior).
- Por eso **solo sirven a un módulo que ya vendoriza el core**: sin
  `baron-core.lock.json` fallan de inmediato, aunque `check-module` local pase
  (sin copia ni lock, [e] y [f] se saltan). Un módulo existente que todavía no
  usa el core, como pf2e-simple-weapon-editor v0.12.0, adopta estos workflows en
  el mismo commit de su primer `sync-core --ref`; hasta entonces conserva su
  propio `release.yml`.
- Un repo recién creado con *Use this template* corre la CI en su primer push,
  antes de `init-module`: `module-check` lo detecta (`module.json` con id
  `__MODULE_ID__`), lo avisa y se salta el check. `module-release` no se salta
  nada: una plantilla sin inicializar nunca publica.
- **`module-release`** reproduce el `release.yml` de pf2e-simple-weapon-editor
  v0.12.0: versión desde la etiqueta; `vX.Y.Z` es estable (manifest en
  `releases/latest`), cualquier otra (`v1.2.0-rc.1`) es prerelease con manifest
  propio; ZIP `<id>-<tag>.zip` con la carpeta `<id>/` y solo `module.json`,
  `scripts`, `styles`, `templates`, `lang` y `packs` (los que existan); y el canal
  de pruebas `dev` con versión numérica `X.Y.Z.<run>` en cada release, salvo que
  `baron.json` diga `"devChannel": false`. El `module.json` lo reescribe
  `tools/release-manifest.mjs`, con las mismas salidas byte a byte que los
  `node -e` que traía antes el workflow. Con `"mode": "protected"` el camino
  cambia: ver [Modo de pago](#modo-de-pago).
- Este repo tiene que seguir siendo **público**: un repo privado puede llamar
  workflows de uno público, no al revés.

## Versionado

- `CORE_VERSION` = etiqueta sin la `v`. Las versiones se publican como
  etiquetas anotadas `vX.Y.Z` que **nunca se mueven ni se borran**; la CI rechaza
  una etiqueta que no coincida con `CORE_VERSION`.
- **PATCH**: mismas salidas para las mismas entradas (comentarios, rendimiento,
  refactor interno).
- **MINOR**: solo exports nuevos; los existentes no cambian.
- **MAJOR**: cualquier otra cosa, incluido un arreglo que cambie lo que devuelve
  un export.
- Publicar: cambiar `CORE_VERSION`, agregar la entrada en `CHANGELOG.md`,
  `npm test`, commit, `git tag -a vX.Y.Z -m vX.Y.Z`, `git push --follow-tags`.
  Después, en cada módulo que use los exports afectados: `sync-core --ref`,
  `check-module`, su propia prueba de regresión y su release.

## Regla de admisión

Un código entra al core solo si **se extrae de un módulo que ya se publicó** (ya
está probado en mesa) **y** lo comparten dos archivos de ese módulo o lo necesita
un segundo módulo. Nada se escribe en el core "por si acaso".

## Estado compartido entre módulos (fuera de v1)

En v1 el core no tiene estado compartido entre módulos: lo poco que guarda es
privado de cada copia. Si un día dos módulos necesitan compartir estado en
tiempo de ejecución (el caso típico: una cola de curaciones por actor al inicio
del turno), la salida es, en este orden:

1. Un global versionado dentro del core:
   `globalThis[Symbol.for("baron-core.<servicio>.v1")] ??= ...`. El contrato de
   cada clave queda congelado por su versión (`.v1`, `.v2`).
2. Si hace falta un servicio con ciclo de vida propio (por ejemplo un broker de
   sockets), un módulo de Foundry aparte con `"library": true` que expone su API
   y un hook de "listo", requerido solo por módulos nuevos; los existentes lo
   detectan sin depender de él.

Ninguna de las dos existe en v1.

## Por qué no es un módulo librería de Foundry

- **The Forge** sirve los scripts de los módulos desde rutas con versión
  (`/modules/<id>/<versión>/...`): un import de un módulo a otro resuelve a una
  ruta equivocada o a una segunda copia del módulo, con doble `init`.
- **Orden de carga:** `relationships.requires` no ordena los scripts; solo
  `"library": true` lo hace. Y un import absoluto (`/modules/...`) se rompe cuando
  Foundry corre con `routePrefix`.
- **Dependencia dura para los usuarios:** cada módulo gratuito obligaría a
  instalar el core, y un core incompatible tras una actualización de Foundry
  tumbaría a todos los módulos a la vez.

El costo aceptado: un arreglo del core llega a los usuarios solo cuando cada
módulo resincroniza y publica.

## Modo de pago

Un módulo de pago (`"mode": "protected"`) es un **complemento freemium**:
extiende un módulo base gratuito y solo lo descargan los mecenas de Patreon.

- Repo **privado** en GitHub, creado con *Use this template* de
  pf2e-module-template e inicializado con
  `init-module --mode protected --requires <id-de-la-base>`. `LICENSE` con todos
  los derechos reservados (la copia de `baron-core.js` sigue siendo MIT) y
  `NOTICE.md` con la ORC; `baron.json` lleva `"mode": "protected"`,
  `"paizo": "orc"` y `"landingUrl"`.
- `module.json` lleva la base en `relationships.requires` y el módulo registra
  sus funciones con la API de la base en `setup`/`ready`. El `module.json` del
  código nunca lleva `"protected"` (revisión `j`): lo agrega el release.
- Foundry aloja el paquete y decide quién lo descarga: el autor asigna niveles
  de Patreon en la página del paquete y cada mecenas vincula su Patreon en su
  perfil de foundryvtt.com.

**Requisito previo, una sola vez:** el Premium Content Agreement de Foundry
firmado en la cuenta de creador. Sin él no se publica ningún paquete protegido.

**Requisito previo, por cada base:** la base gratuita publicada en
foundryvtt.com como paquete gratuito normal, con el mismo id que lista el
`requires` del complemento, antes del primer release del complemento. El
manifiesto protegido no puede llevar el `manifest` de la base (es un enlace a
GitHub, y el release protegido los rechaza todos), así que Foundry encuentra la
base solo por su id en el listado de foundryvtt.com: si no está ahí, un mecenas
que instala el complemento no tiene de dónde bajar la base.

### Qué hace la CI al empujar la etiqueta

1. `Leer baron.json` falla si el repo no es privado
   (`github.event.repository.private`): los archivos de un release de un repo
   público los descarga cualquiera.
2. `check-module --online --release`, con la revisión `m` (`landingUrl`, la
   base en `requires`, ningún enlace a GitHub). La misma revisión corre en cada
   push, así que lo que haría fallar el release ya sale en rojo antes de
   etiquetar. Un `TODO-HUMANO:` pendiente o un texto sin firma (revisión `n`),
   un campo de la ORC sin llenar o un `PENDIENTE:` en `NOTICE.md` (revisión `l`)
   solo avisan en el push y aquí fallan.
3. Las pruebas del módulo, las mismas que en cada push (ver
   [Workflows reutilizables](#workflows-reutilizables)): una prueba roja
   detiene la etiqueta antes de tocar `module.json`.
4. `release-manifest.mjs --mode protected` reescribe `module.json`:
   `"protected": true`, sin `download`, `manifest` =
   `https://r2.foundryvtt.com/packages-public/<id>/module.json` (el que sirve
   Foundry), `url` = `landingUrl` y la versión de la etiqueta. Falla si
   cualquier texto o clave del resultado todavía menciona GitHub
   (`github.com`, `githubusercontent.com`, `github.io`), y dice dónde
   (`bugs`, `readme`, `changelog`, `authors[0].url`, …): un enlace al repo
   privado está muerto para los jugadores y revela el repo. El `manifest` de
   una dependencia en `relationships` también falla, aunque su repo sea
   público: Foundry encuentra por su id una dependencia publicada en
   foundryvtt.com, así que se quita (ver el requisito de la base, arriba).
5. ZIP `<id>-<tag>.zip` con la carpeta `<id>/`, igual que en modo público.
6. Release **en el propio repo privado** con el ZIP y ese `module.json`
   (prerelease si la etiqueta no es `vX.Y.Z`): solo lo ven sus colaboradores.
   Una prerelease solo comprueba que el paquete se arma: nunca se sube a
   Foundry (ver abajo).
7. Nunca toca el canal `dev`.
8. Deja en el resumen del run la lista de abajo, con el id, la versión y la
   compatibilidad ya escritos; en una prerelease, en su lugar, por qué no se
   sube y cómo probar.

### Subida manual a Foundry

Foundry no documenta ninguna API para subir paquetes protegidos, así que en cada
versión **estable** (`vX.Y.Z`; una prerelease nunca se sube):

1. Descarga `<id>-<tag>.zip` del release de esa etiqueta, en el repo privado.
2. Súbelo en https://foundryvtt.com/creators/upload al paquete `<id>`, con la
   versión y la compatibilidad (`minimum`, `verified`, `maximum` de
   `module.json`).
3. La primera versión de un paquete espera la aprobación de Foundry antes de
   aparecer.
4. En la página del paquete en foundryvtt.com, asigna los niveles de Patreon que
   dan acceso.
5. Prueba la instalación desde una cuenta de mecenas, con Patreon vinculado en
   su perfil de foundryvtt.com: Foundry tiene que instalar también la base
   gratuita.

### Por qué nunca el canal `dev`

El canal `dev` es un release de GitHub con URL fija. En un repo privado nadie de
fuera podría instalar desde ahí, y en uno público regalaría el paquete: el ZIP
se descargaría sin pasar por Patreon. El acceso a un módulo de pago lo controla
Foundry, así que todo lo que llega a los jugadores sale de foundryvtt.com, y lo
que se sube ahí les llega como actualización. `devChannel` se ignora en
`mode: protected`.

Una versión de prueba tampoco sale de un ZIP: el de un release protegido lleva
`"protected": true`, y Foundry esconde un paquete protegido de tu propia
instalación (v14 lo rechaza sin firma). El código se prueba desde la copia de
trabajo, enlazada con `tools/link-foundry.ps1`. Una etiqueta de prueba
(`v1.1.0-rc.1`) solo comprueba que el paquete protegido se arma, y **nunca se
sube a Foundry**: Foundry compara versiones por segmentos y como texto, así que
la estable `1.1.0` no contaría como más nueva que `1.1.0-rc.1` y los mecenas se
quedarían en la prueba.

## Pruebas

```sh
npm test
# equivale a:
node --test test/*.test.mjs test/tools/*.test.mjs
```

- `test/*.test.mjs`: los exports del core, incluida la paridad contra la copia
  de SWE v0.12.0 en `test/legacy/`.
- `test/tools/*.test.mjs`: `sync-core`, `check-module`, `release-manifest`,
  `sign-text` (este con una terminal falsa: la bandera TTY y las respuestas se
  inyectan) y `text-sheet` (la hoja como la guardan Excel y Google Sheets, y
  que nunca muestre un texto sin firma). Arman repos de git temporales (un core falso etiquetado y un
  módulo con pins), así que necesitan `git` en el PATH. También
  `.github/scripts/run-module-tests.mjs`, contra
  módulos temporales (sin pruebas, en verde, en rojo, con `npm test`, el
  `tests/` de SWE, solo `fixtures/`) y contra el orden de los pasos de los dos
  workflows reutilizables; los casos de `npm test` necesitan `npm` en el PATH.
  `init-module.test.mjs` corre el `tools/init-module.mjs` de
  pf2e-module-template sobre una copia de ese repo si está clonado al lado (o
  donde diga `BARON_TEMPLATE_DIR`); si no, como en la CI de este repo, se salta.
- `test/fixtures/valid-module/` es el módulo mínimo que pasa todo;
  `test/fixtures/negative/*.json` describe cada caso roto como ese módulo más un
  cambio (ver su README).

## Notas de Windows

- `core.autocrlf=true` no afecta: las herramientas normalizan CRLF a LF antes de
  copiar o calcular el sha256, y `.gitattributes` fija LF en el repo.
- Las herramientas llaman a `git` sin shell, así que no hace falta
  `MSYS_NO_PATHCONV=1` (que sí hace falta para `git show <ref>:<archivo>` escrito
  a mano en Git Bash).
- `sync-core --watch` funciona aunque la ruta llegue en formato corto 8.3
  (`C:\Users\NOMBRE~1\...`).
- `sign-text --sign` necesita una terminal de verdad: PowerShell, Windows
  Terminal o Git Bash, sin tubería ni redirección (`|`, `>`, `Tee-Object`). Solo
  con un Git for Windows anterior a 2.54, Git Bash (mintty) no le da una TTY a
  node; ahí, `winpty node ../pf2e-baron-core/tools/sign-text.mjs . --sign`.

## Licencia

[MIT](LICENSE). Cubre el código de este repositorio, incluida la copia de
`baron-core.js` que viaja dentro de cada módulo, también dentro de los ZIP de
los módulos de pago: ahí sigue siendo MIT aunque el resto del módulo no lo sea.

La licencia es solo del código. Los nombres y reglas de Pathfinder que usan los
módulos son de Paizo y van con los avisos de cada módulo (`NOTICE.md`), según
`paizo` en `baron.json`: la Community Use Policy solo en un proyecto sin ninguna
parte de pago; la ORC License en los de pago y en la base gratuita de un
freemium.
