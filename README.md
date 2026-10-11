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
- **`tools/`**: `sync-core.mjs` y `check-module.mjs`. Solo usan módulos de Node y
  `git`; corren igual en Windows y en Linux, sin `npm install`.
- **`.github/workflows/`**: la CI de este repo (`ci.yml`) y los dos workflows
  reutilizables que llaman los módulos (`module-check.yml`, `module-release.yml`).
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

Sin `baron.json`, `check-module` usa `{"mode":"public","devChannel":true,"i18nPrefix":<id>,"langParity":"error","persisted":[]}` y lo avisa. Sin `paizo`, la revisión `l` no revisa nada y solo lo avisa.

## Comandos

Desde la carpeta del módulo, con este repo clonado al lado
(`GitHub/personal/pf2e-baron-core`). Para clonarlo:
`git clone git@github-baron:BaronHVC/pf2e-baron-core.git` (alias SSH de la
cuenta BaronHVC) o `git clone https://github.com/BaronHVC/pf2e-baron-core.git`;
un clon normal trae las etiquetas que necesita `--online`.

```sh
# Vendorizar una versión publicada (etiqueta) o un commit concreto
node ../pf2e-baron-core/tools/sync-core.mjs --ref v1.0.0

# Desarrollo en vivo: copia el core de tu copia de trabajo en cada guardado
# (deja el lock en "dev"; check-module lo rechaza hasta que corras --ref)
node ../pf2e-baron-core/tools/sync-core.mjs --watch

# Revisiones antes de etiquetar
node ../pf2e-baron-core/tools/check-module.mjs
node ../pf2e-baron-core/tools/check-module.mjs --online     # además compara el lock con este repo
node ../pf2e-baron-core/tools/check-module.mjs --parity warn

# Lo que module-release escribiría en module.json. Reescribe el archivo que le
# pasas: úsalo sobre una copia (en CI lo corre el workflow)
node ../pf2e-baron-core/tools/release-manifest.mjs copia/module.json --tag v1.2.0 --repo BaronHVC/<id> --channel stable
node ../pf2e-baron-core/tools/release-manifest.mjs copia/module.json --tag v1.2.0 --repo BaronHVC/<id> --channel stable --mode protected --landing-url https://www.patreon.com/<tú>
```

`sync-core` y `check-module` aceptan la carpeta del módulo como primer argumento
(por defecto, la carpeta actual).

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
| l   | `paizo` de `baron.json` es `cup` u `orc` y no es `cup` con `mode: protected`; `NOTICE.md` existe, trae el aviso de esa licencia (`used under Paizo's Community Use Policy` / `licensed under the ORC License`) y no trae el de la otra. El aviso se busca como lo muestra GitHub: partido en renglones, citado con `>`, con énfasis o como enlace cuenta; dentro de un comentario HTML no. Con `orc`, aviso por cada renglón donde empieza un campo del template sin llenar (`[Title of Work]`, `[Copyright Notice]`, `[Author Credit Information]`, `[nombres, logos, …]`, `[ninguno]`, aunque esté partido en renglones; un enlace con ese texto no cuenta) y aviso si el id o el título nombran a Paizo o sus juegos (PF2e, Pathfinder, Starfinder, Golarion): la ORC nunca licencia marcas de Paizo y el id no se puede cambiar. Sin `paizo`, solo un NOTICE (que a un módulo `protected` le dice que necesita `orc`) |
| m   | solo con `mode: protected`: `landingUrl` de `baron.json` es una URL `https` sin espacios que no apunta a github.com (FAIL); `relationships.requires` de `module.json` lista al menos un módulo que no sea pf2e-baron-core, la base gratuita (WARN); y ningún otro texto de `module.json` fuera de `url`, `manifest` y `download` (que el release reescribe) menciona github.com, porque el release protegido lo rechaza (WARN). En un módulo `public` no imprime nada |

`--online` usa el repo indicado con `--core-repo <ruta>`; sin esa opción usa el
repo donde viven las propias herramientas.

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
  etiquetas) y corren `check-module --online` antes de cualquier otra cosa.
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

### Qué hace la CI al empujar la etiqueta

1. `Leer baron.json` falla si el repo no es privado
   (`github.event.repository.private`): los archivos de un release de un repo
   público los descarga cualquiera.
2. `check-module --online`, con la revisión `m` (`landingUrl`, la base en
   `requires`).
3. `release-manifest.mjs --mode protected` reescribe `module.json`:
   `"protected": true`, sin `download`, `manifest` =
   `https://r2.foundryvtt.com/packages-public/<id>/module.json` (el que sirve
   Foundry), `url` = `landingUrl` y la versión de la etiqueta. Falla si
   cualquier texto del resultado todavía menciona github.com, y dice dónde
   (`bugs`, `readme`, `changelog`, `authors[0].url`, …): un enlace al repo
   privado está muerto para los jugadores y revela el repo. Foundry encuentra
   por su id una dependencia publicada en foundryvtt.com, sin `manifest`.
4. ZIP `<id>-<tag>.zip` con la carpeta `<id>/`, igual que en modo público.
5. Release **en el propio repo privado** con el ZIP y ese `module.json`
   (prerelease si la etiqueta no es `vX.Y.Z`): solo lo ven sus colaboradores.
6. Nunca toca el canal `dev`.
7. Deja en el resumen del run la lista de abajo, con el id, la versión y la
   compatibilidad ya escritos.

### Subida manual a Foundry

Foundry no documenta ninguna API para subir paquetes protegidos, así que en cada
versión:

1. Descarga `<id>-<tag>.zip` del release de esa etiqueta, en el repo privado.
2. Súbelo en https://foundryvtt.com/creators/upload al paquete `<id>`, con la
   versión y la compatibilidad (`minimum`, `verified`, `maximum` de
   `module.json`).
3. La primera versión de un paquete espera la aprobación de Foundry antes de
   aparecer.
4. En la página del paquete en foundryvtt.com, asigna los niveles de Patreon que
   dan acceso.
5. Prueba la instalación desde una cuenta de mecenas, con Patreon vinculado en
   su perfil de foundryvtt.com.

### Por qué nunca el canal `dev`

El canal `dev` es un release de GitHub con URL fija. En un repo privado nadie de
fuera podría instalar desde ahí, y en uno público regalaría el paquete: el ZIP
se descargaría sin pasar por Patreon. El acceso a un módulo de pago lo controla
Foundry, así que todo lo que llega a los jugadores sale de foundryvtt.com, y lo
que se sube ahí les llega como actualización. Una versión de prueba se instala a
mano desde el ZIP de su release. `devChannel` se ignora en `mode: protected`.

## Pruebas

```sh
npm test
# equivale a:
node --test test/*.test.mjs test/tools/*.test.mjs
```

- `test/*.test.mjs`: los exports del core, incluida la paridad contra la copia
  de SWE v0.12.0 en `test/legacy/`.
- `test/tools/*.test.mjs`: `sync-core`, `check-module` y `release-manifest`. Arman repos de git
  temporales (un core falso etiquetado y un módulo con pins), así que necesitan
  `git` en el PATH.
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

## Licencia

[MIT](LICENSE). Cubre el código de este repositorio, incluida la copia de
`baron-core.js` que viaja dentro de cada módulo, también dentro de los ZIP de
los módulos de pago: ahí sigue siendo MIT aunque el resto del módulo no lo sea.

La licencia es solo del código. Los nombres y reglas de Pathfinder que usan los
módulos son de Paizo y van con los avisos de cada módulo (`NOTICE.md`), según
`paizo` en `baron.json`: la Community Use Policy solo en un proyecto sin ninguna
parte de pago; la ORC License en los de pago y en la base gratuita de un
freemium.
