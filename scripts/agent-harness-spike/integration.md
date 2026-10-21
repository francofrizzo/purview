# Integración experimental: siguiente handoff a Mac

Los adapters viven ahora en `packages/server/src/agent/{claude-shared,codex}`.
No importan el spike. Nada es visible en la UI ni en el changelog; el Claude
actual conserva sus permisos, prompts y posición de default. No cambia el
formato persistido ni migra las sesiones existentes.

## Cierre de evals: siguiente prueba acotada en la Mac

No repetir la tanda documental sólo para corregir su score: `regrade.mjs` ya
aplicó v2 a las seis respuestas guardadas, sin cuota (ver eval-results.md).
El grader histórico sigue disponible y no se reescribió ningún reporte.

Lo útil ahora es verificar **los binarios que la Mac usa hoy** con los tests
nativos y proveedor local, porque Claude ahora exige un init válido antes de
aceptar respuestas/resultados. En un checkout separado actualizado a esta branch,
con core y server construidos, resolver las rutas absolutas de ambos ejecutables
(Codex debe ser el binario nativo, no su launcher npm) y ejecutar desde la raíz:

```sh
PURVIEW_TEST_CLAUDE_BIN=/ruta/absoluta/al/claude-instalado \
PURVIEW_TEST_CODEX_BIN=/ruta/absoluta/al/codex-nativo-instalado \
pnpm --filter @reviewer/server exec vitest run \
  test/claude-shared.test.ts test/codex-harness.test.ts test/review-tools.test.ts
```

No instalar otra versión para lograr verde: registrar las versiones encontradas.
Los tests usan HOME/store descartables y proveedor HTTP local determinista:
sin modelos pagos, login nuevo ni copia de credenciales. No tocan `~/.purview`
ni 4779. Comprobar que los tests nativos no figuren como skipped y guardar sólo
versiones, plataforma, conteos y fallos sanitizados, nunca auth/transcripts.
Una falla no autoriza cambiar permisos, hacer OAuth o tocar la sesión personal.

Después, si se quiere evaluar calidad, usar el protocolo [realpr](realpr/README.md)
con autorización de cuota y worktrees dedicados, sin `PURVIEW_HARNESS` heredado
en los servidores de comparación. Una PR representativa, tres brazos, mismo
modelo/effort solicitado para los Claude, sin otra matriz sintética completa.
Adjudicar privadamente findings útiles/falsos, omisiones, notas triviales,
agrupación y latencia. En particular, comprobar si "persistir cada conclusión"
agrega ruido; un aumento del número de findings no prueba una mejora.
Ese piloto no está ejecutado por este handoff ni es necesario para validar v2.

## Cómo usarlo hoy (privado, sin exponer nada)

- `PURVIEW_HARNESS=claude-shared` (o `codex`) al arrancar el server: todo
  análisis y todo turno de chat corre en ese harness, por encima de cualquier
  capa de configuración. El modelo y el effort configurados para el harness
  original se conservan si el nuevo los conoce (Claude ↔ Claude); si no, usa los
  defaults del manifest (Codex: `gpt-6.1-sol`). Sin la variable, todo sigue
  exactamente como hoy. Un valor que no nombra un harness falla el run con un
  mensaje claro, no cae en silencio al default.
- `PURVIEW_EXPERIMENTAL_HARNESSES=1` es otra cosa: hace que los adapters
  aparezcan en los selectores de la UI. No hace falta para la variable anterior,
  y `GET /api/agents` no lista un harness que solo corre por override.
- Claude compartido usa el `claude` del PATH (o `PURVIEW_CLAUDE_BIN`) con su
  login existente. Codex necesita `PURVIEW_CODEX_HOME` apuntando a un store
  privado autenticado (ver abajo).

## Versiones: mínima más verificación de comportamiento

No hay pin exacto. Cada adapter exige una versión mínima (la verificada en las
evals: Claude Code 2.1.305, Codex 0.163.0), acepta cualquier versión posterior
y después verifica conducta, no cadena de versión:

- **Claude:** el evento `system/init` del CLI debe listar como herramientas
  exactamente las `mcp__purview__*` del run (ninguna nativa) y el MCP `purview`
  como `connected`. Un flag que una versión futura ignore en silencio
  aparecería ahí como herramienta nativa y el run falla cerrado con
  `Unexpected native tool offered by Claude Code: …`. Ya pasó una vez con
  `--safe-mode`, que apaga el MCP explícito.
  Se rechazan también init ausente/tardío, listas incompletas y MCP desconectado;
  no se entrega una respuesta anterior a la inicialización verificada.
- **Codex:** sigue leyendo la configuración efectiva por app-server antes del
  primer turno y rechaza si shell, red, plugins o multi-agente quedaron activos.

Estos checks verifican lo que el CLI declara en su protocolo, no constituyen un
sandbox independiente ni certifican que un binario incompatible no haya actuado
antes de reportarse. Tampoco prometen compatibilidad general de versiones futuras:
un cambio de protocolo puede provocar un rechazo seguro y requerir otro adapter.

## Prompt de análisis compartido: paso de verificación

El prompt compartido no carga `SKILL.md` (tiene recetas de CLI), así que no
recibía el "VERIFICATION PASS: RUN IT" del harness actual. Ahora lo tiene en su
propia forma: para cada unidad must-read o ambigua, elegir las afirmaciones que
cambiarían un veredicto, chequearlas con `search_code`/`read_code` y persistir
cada conclusión como finding. Resultado en la PR real grande: de 0 findings a 5
verificados, estables en dos corridas (ver eval-results.md, "PRs reales").

## Contrato común y diferencias identificadas

- La autoridad de cada run fija PR, store, revisión, checkout y tarea. El modelo
  no elige esos valores. Un endpoint MCP HTTP efímero en loopback, con una URL
  aleatoria, sirve exactamente las operaciones de esa tarea; no es una nueva
  API del servidor público. Cerrar/cancelar revoca el endpoint; una escritura
  ya admitida termina antes del evento terminal, no se deshace.
- Ambos tienen descripción/diff/unidades/cambios/comentarios, búsqueda literal
  con globs y contexto, archivos actuales/base, historia local y diff entre
  revisiones. Los resultados se paginan. No hay shell, herramientas nativas de
  edición ni publicación. La búsqueda lista archivos tracked, no un shell genérico.
- Análisis inicial: `set_analysis`. Incremental: `patch_units` y
  `set_revision_summary`, sin reemplazar todo. Chat: sólo drafts mediante las
  rutas reales de Purview, con sus anclajes, historia, trash, audiencia y eventos.
  Ninguno puede editar drafts humanos con esta integración experimental; propone
  el cambio. Una revisión vieja se rechaza también al llegar al servidor HTTP.
- **Claude:** CLI 2.1.305 o posterior (ver "Versiones"), login propio existente, fuentes de settings vacías,
  restricted, hooks/memoria/slash commands desactivados y allowlist del único MCP.
  No usa safe-mode porque impediría cargar ese MCP explícito. No hay nuevo OAuth.
- **Codex:** binario nativo 0.163.0 o posterior, app-server, HOME/store privados, cwd neutro,
  perfil de filesystem mínimo y sin red para ejecución, herramientas/plugins/hooks
  desactivados. Se comprueba la configuración efectiva antes del primer turno.
  Un config.toml privado no vacío se rechaza, no se mezcla.
- **Prompts:** mismo workflow y RUBRIC.md/overlays del producto. Codex agrega
  `[Purview Codex adaptation]`: recordatorio de tamaños de evidencia y lecturas
  selectivas por los reintentos observados en las evals. No amplía permisos.
  Claude tiene el paso de verificación descrito arriba. Los resultados nuevos NO son directamente
  comparables al prompt corto del prototipo como si sólo hubiera cambiado el modelo.
- Chat puede continuar sesiones compatibles; cada turno crea una autoridad fresca.
  Reanchor sigue siendo tool-free. Los adapters experimentales no ofrecen handoff
  a terminal. Las versiones no verificadas se rechazan, no degradan silenciosamente.

## Preparación Mac (sin tocar el Purview en uso)

Usar esta branch en un checkout separado. No ejecutar `scripts/start.mjs`, no usar
4779, no escribir `~/.purview`, no cambiar logins ni copiar credenciales.

```sh
pnpm install --frozen-lockfile
pnpm --filter @reviewer/core build
pnpm --filter @reviewer/server build
npm ci --prefix scripts/agent-harness-spike --no-audit --no-fund
```

Usar `PURVIEW_CLAUDE_BIN` para el nativo 2.1.305 (incluido en el SDK fijado del
spike) y `PURVIEW_CODEX_BIN` para el nativo 0.163.0, **no** el launcher npm.
Los tests nativos locales aceptan `PURVIEW_TEST_CLAUDE_BIN` y
`PURVIEW_TEST_CODEX_BIN`; usan transporte de modelo determinista local, sin cuota
ni credenciales reales. Ejecutar desde `packages/server`:

```sh
npx vitest run test/claude-shared.test.ts test/review-tools.test.ts test/codex-harness.test.ts
```

Para modelos reales, `PURVIEW_CODEX_HOME` debe apuntar explícitamente al store
privado ya autenticado y validado en el spike (por ejemplo
`$HOME/.purview-harness-spike-auth/codex`), con config.toml ausente/vacío. Sin ese
override, el producto usa `<store-purview>/agents/codex/store`, con HOME en
`<store-purview>/agents/codex/home`; si falta login muestra ambos paths y se detiene.
No hay login automático. Claude conserva su HOME normal para su login existente.

## Próxima comparación con modelos reales

`--runtime production` evalúa los nuevos adapters **y prompts del producto**,
con los mismos casos y graders históricos sin retocarlos. El default sigue siendo
`--runtime spike`, para poder reproducir los informes anteriores. Dry-run:

```sh
node scripts/agent-harness-spike/eval.mjs --runtime production \
  --arms claude-baseline,claude-shared,codex-shared --repeats 1
```

Después, agregar `--run --out <archivo-nuevo.jsonl>` inicia 12 corridas con cuota
real. Empezar con una repetición; si funcionan, repetir tres veces. Incremental se
puede pedir con `--cases incremental-analysis`. El runner ahora audita resultados
de las operaciones MCP y habilita `resumed-incremental` en los brazos compartidos:
el warmup debe leer contexto, unidades y diff con éxito sin escribir. Los errores
de tools se cuentan; los permisos nativos no observables siguen como `null`.
No sobrescribir informes ni corregir graders retroactivamente. Los nuevos casos
optativos de documentación y sus comandos están en [eval.md](eval.md).

Además falta la comparación de calidad sobre 2–3 PRs reales representativos:
una pequeña, una grande y una con findings relevantes. Preparar copias independientes
del estado, nunca modificar el original; probar análisis fresco e incremental,
una pregunta de exploración, crear/editar/borrar un draft, Stop y continuación de
chat. Comparar contra Claude actual con igual modelo/effort pedido: agrupación,
hunks omitidos, evidencia, hallazgos útiles/falsos positivos, turns, tiempo y uso.
Guardar sólo resultados sanitizados y conclusiones; no subir diffs, transcripts,
comentarios privados, tokens o cuentas. Un grader verde no demuestra paridad de
calidad: hace falta adjudicación humana. No activar esto por defecto todavía.

## Validación Mac (2026-10-21)

Hecha según esta guía, en un checkout separado, sin tocar el Purview en uso.
Tests nativos 27/27; dry-run ok; `--runtime production` 10/12 en una repetición
y 28/36 en tres. Todos los fallos son de formato en Claude (frase antes del
JSON), ninguno de transporte, permisos ni contenido. Números, tablas y lectura
en [eval-results.md](eval-results.md), "Tercera tanda". Reportes en
`eval-reports/2026-10-21-mac-production-*.jsonl`.

## Pendientes para la integración

1. **PRs reales: corridas hechas, adjudicación humana pendiente.** Tres PRs,
   tres brazos, análisis fresco + refresh/incremental + chat/draft/Stop, 15
   corridas sin fallos de transporte ni permisos. Ver "PRs reales" en
   [eval-results.md](eval-results.md). Lo que salió de ahí y hay que arreglar
   antes de usar los adapters en serio:
   - `claude-shared` verifica pero no emitía findings en PRs grandes: hecho
     (paso de verificación en el prompt; 0 → 5 findings en la PR grande).
   - `codex`: sobreclasifica (`core-logic` en markdown), duplica unidades y
     tarda 6 min en una PR de 76 archivos; el addendum necesita granularidad
     ("~30 unidades o menos", "docs de agentes son `docs`") y findings.
   - Idioma: el prompt pide "the reader's language" y nada lo define; una línea
     en el rubric del equipo o el overlay local lo fija para los tres.
   - El protocolo de copias está en el scratch del operador (`prepare.mjs`,
     `server.sh`, `drive.mjs`, `chat.mjs`); vale la pena moverlo a
     `scripts/agent-harness-spike/realpr/` si se repite.
2. **Selección de harness con UI.** Por ahora, `PURVIEW_HARNESS` (arriba).
   Cuando se exponga: decidir si es global, por repo o por PR y persistirlo.
3. **Costo de Codex.** El adapter devuelve tokens, no USD (`inputTokens`
   incluye los cacheados). Tabla de precios o mostrar tokens.
4. **Diff grande con Codex.** El addendum no evitó paginar todo el diff
   (25 páginas, 2,3 M tokens, ~2 min). Hace falta una instrucción que lo lleve
   al overview y a `search_code`, como hace Claude compartido con 4–5 llamadas.
5. **Versiones: hecho** (ver "Versiones" arriba). Queda como referencia la propuesta original:
   No dependemos del modelo ni del formato de salida, pero sí de los flags que
   forman el límite de permisos (`--tools ''`, `--restricted`,
   `--setting-sources ""`, hooks y memoria apagados; en Codex las claves de
   `features`, `permissions` y `mcp_servers`). Un flag ignorado en silencio por
   una versión nueva daría shell al modelo sin aviso (ya pasó con `--safe-mode`,
   que apaga el MCP explícito). Propuesta: exigir versión mínima y, al arrancar,
   verificar conducta en vez de cadena de versión: en Claude, leer las
   herramientas que el hijo anuncia en el evento `system` inicial y rechazar si
   hay alguna que no sea `mcp__purview__*`; en Codex, seguir leyendo la
   configuración efectiva por app-server antes del primer turno y rechazar si
   shell, red o plugins quedaron activos. Una versión nueva que se comporta
   igual pasa; una que no, falla con mensaje claro.
6. **Huecos declarados**: sin handoff a terminal ni edición de drafts humanos.
   El runner ya puede evaluar resume en producción; falta la nueva tanda con
   modelos reales. Ninguno bloquea el uso experimental.
