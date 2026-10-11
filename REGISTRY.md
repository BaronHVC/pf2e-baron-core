# Registro de espacios de nombres

*English summary: every identifier a BaronHVC module writes into a world or
into the shared page (flag scopes, i18n prefixes, CSS roots, rule-element slugs,
roll options, Handlebars helpers, sockets) is registered here, so two modules of
the family can never collide. Once a module ships, its row is frozen: those
strings live in users' worlds. Paid modules are registered only when they are
published, because this repository is public.*

Todo lo que un módulo escribe en un mundo (flags, slugs de reglas, roll options)
o en la página compartida (clases CSS, helpers de Handlebars, claves i18n,
sockets) vive en un espacio de nombres global: dos módulos activos al mismo
tiempo no pueden usar el mismo. Esta tabla es la fuente de verdad.

## Reglas

- **Antes de escribir código** de un módulo nuevo gratuito, se elige su fila y
  se agrega aquí. `tools/init-module.mjs` del template imprime la fila lista
  para pegar y, si encuentra este repo al lado (`../pf2e-baron-core`), rechaza un
  id o un prefijo que ya estén en la tabla.
- **Una fila publicada no cambia.** Esos textos están guardados en mundos de
  usuarios; renombrarlos deja datos huérfanos. Los que el código escribe tal cual
  van además en `persisted` de su `baron.json`, y `check-module` falla si dejan de
  aparecer en `scripts/`.
- **Módulos de pago:** se registran al publicarse, no antes, porque este
  repositorio es público. Mientras tanto, revisa a mano que su prefijo no choque
  con uno de pago aún sin registrar.
- `id` = carpeta del módulo = `scope` de sus flags (`doc.flags[id]`). Nunca se
  hace `getFlag`/`setFlag` sobre el scope de otro módulo: se lee
  `doc.flags?.[scope]?.[clave]`.
- Prefijo i18n = id del módulo en módulos nuevos (`baron.json` → `i18nPrefix`).
- Todo el CSS va bajo la clase raíz del módulo; los helpers de Handlebars llevan
  el prefijo del módulo.
- Cada módulo que necesite socket usa el suyo (`module.<id>`, con `"socket": true`
  en su module.json). El core no registra ninguno.
- **Envuelve:** cada método interno de PF2e o Foundry que el módulo envuelve, y
  cómo lo hace. Con lib-wrapper activo se registra como `"WRAPPER"`; si no, a
  mano, llamando siempre al original (regla 14 del CLAUDE.md de la plantilla).
  Antes de envolver un método, revisa si otro módulo de la familia ya lo hace.

## Tabla

| id (scope de flags) | prefijo i18n | raíz CSS | prefijos de slug de reglas | roll options | helpers Handlebars | socket | envuelve |
|---|---|---|---|---|---|---|---|
| `pf2e-simple-weapon-editor` | `SWE` | `swe-editor` / `swe-open` | `SWE:`, `swe-cond`, `swe-x-`, `swe-s-`, `swe-p-`, `swe-a-` | `swe-adopted`, `swe-gated`, `swe-pick`, `swe-pick-made`, `swe-atk`, `swe-rider`, `swe-react`, `swe-dmg:` | `sweEq` | ninguno | `CharacterPF2e#prepareStrike`, `CharacterPF2e#prepareAreaAttack`, `ActorPF2e#applyDamage` (a mano) |

### Notas por módulo

**pf2e-simple-weapon-editor** (anterior a la familia, por eso su prefijo i18n no
es su id). `swe-x-` y `swe-s-` se arman en tiempo de ejecución
(`` `swe-${splash ? "s" : "x"}-${i}` `` en `scripts/main.js` v0.12.0), así que no
pueden ir en `persisted`: no hay texto literal que buscar. Los demás prefijos sí
aparecen tal cual en el código.
