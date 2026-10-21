# Integración experimental: siguiente handoff a Mac

Los adapters viven ahora en `packages/server/src/agent/{claude-shared,codex}`.
No importan el spike. `PURVIEW_EXPERIMENTAL_HARNESSES=1` los registra junto al
Claude actual, que conserva sus permisos, prompts y posición de default.
No cambia el formato persistido ni migra las sesiones existentes.

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
- **Claude:** CLI 2.1.305, login propio existente, fuentes de settings vacías,
  restricted, hooks/memoria/slash commands desactivados y allowlist del único MCP.
  No usa safe-mode porque impediría cargar ese MCP explícito. No hay nuevo OAuth.
- **Codex:** binario nativo 0.163.0, app-server, HOME/store privados, cwd neutro,
  perfil de filesystem mínimo y sin red para ejecución, herramientas/plugins/hooks
  desactivados. Se comprueba la configuración efectiva antes del primer turno.
  Un config.toml privado no vacío se rechaza, no se mezcla.
- **Prompts:** mismo workflow y RUBRIC.md/overlays del producto. Codex agrega
  `[Purview Codex adaptation]`: recordatorio de tamaños de evidencia y lecturas
  selectivas por los reintentos observados en las evals. No amplía permisos.
  Claude no tiene addendum específico. Los resultados nuevos NO son directamente
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
puede pedir con `--cases incremental-analysis`. Este runner aún no audita éxito
de cada operación: registra intentos, no inventa ceros para errores/denegaciones.
Por eso rechaza `resumed-incremental`; el cold-resume del adapter tiene su test
nativo separado. No sobrescribir informes ni corregir graders retroactivamente.

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

1. **PRs reales.** Preparado y verificado sin modelo: copias privadas del estado
   de tres PRs (chica, mediana con findings y commits nuevos arriba, grande),
   una raíz por brazo, sin token LAN ni checkouts, con `managedCheckouts: false`
   para que el run resuelva por sha el worktree gestionado existente y solo lo
   lea. Falta correr: análisis fresco por brazo, refresh + incremental sobre la
   mediana, una pregunta de chat, un draft, Stop y continuación; y la
   adjudicación humana. Límite conocido: tras el refresh el incremental no
   tendrá checkout al head nuevo (igual para los tres brazos).
2. **Selección de harness con UI.** Hoy entra por los selectores existentes solo
   con `PURVIEW_EXPERIMENTAL_HARNESSES=1`. Decidir si es global, por repo o por
   PR y persistirlo.
3. **Costo de Codex.** El adapter devuelve tokens, no USD (`inputTokens`
   incluye los cacheados). Tabla de precios o mostrar tokens.
4. **Diff grande con Codex.** El addendum no evitó paginar todo el diff
   (25 páginas, 2,3 M tokens, ~2 min). Hace falta una instrucción que lo lleve
   al overview y a `search_code`, como hace Claude compartido con 4–5 llamadas.
5. **Versiones: mínima más verificación de comportamiento, no pin exacto.**
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
6. **Huecos declarados**: sin handoff a terminal, sin editar drafts humanos, el
   runner de producción no audita el resume (tiene test nativo aparte). Ninguno
   bloquea el uso experimental.
