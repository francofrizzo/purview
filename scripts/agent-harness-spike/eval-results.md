# Resultados de la evaluación funcional en la Mac (2026-10-21)

Tanda Claude baseline vs. Claude compartido, según `eval.md`. Reportes JSONL
revisados en `eval-reports/`. Nada de esto habilita el adapter en producción.

## Plataforma

| | |
| --- | --- |
| Sistema | macOS 27.0, arm64 (Darwin 27.0.0) |
| Node / pnpm | v26.3.0 / 10.34.5 |
| Claude Code | 2.1.305 (binario del Agent SDK 0.3.305, el mismo número que la CLI instalada) |
| Login | el normal de la CLI (`claude.ai`, sin `ANTHROPIC_API_KEY` ni `ANTHROPIC_AUTH_TOKEN` en el entorno) |
| Modelo pedido / resuelto | `claude-sonnet-5-5` / `claude-sonnet-5-5`, effort `medium` |
| Commit evaluado | `d21452c` más el arreglo de entorno descrito abajo (manifest `dirty: true`) |
| Tests locales | spike 44/44, eval 22/22, sin inferencia remota |

## Qué pasó, en orden

1. **Pareja corta, primer intento: las dos corridas fallan en menos de un segundo**
   sin tocar la API (`2026-10-21-mac-claude-smoke-1-auth-fail.jsonl`). El evento
   `result` del hijo decía `Not logged in · Please run /login` con
   `apiKeySource: none`, aunque el mismo binario desde una shell interactiva
   reporta `loggedIn: true`.

   Causa: en macOS Claude Code lee sus credenciales del Keychain con
   `security find-generic-password -a "$USER" …`. `childEnv` solo pasaba `PATH`,
   `HOME` y las variables de red/autenticación explícitas, así que el hijo buscaba
   la entrada con una cuenta vacía. En Linux las credenciales viven en un archivo
   bajo `HOME`, por eso esto no apareció allá. Verificado por bisección: con
   `env -i PATH HOME` el login no se ve; agregando solo `USER` sí; `LOGNAME`,
   `SHELL`, `TERM`, `SECURITYSESSIONID` no cambian nada; `detached: true` no es
   la causa.

   Arreglo, solo en el spike: `childEnv` pasa además `USER` y `LOGNAME`. Es una
   variable de identidad, no un permiso ni una credencial. También se agregó
   `PURVIEW_EVAL_DEBUG_LOG` (opt-in, archivo elegido por el operador, fuera del
   reporte) que vuelca stderr del hijo y los eventos `system`/`result`; hizo falta
   para ver este error, porque el reporte no guarda errores crudos por diseño.
   El archivo de depuración de esta tanda no se publica: contiene IDs de sesión.

2. **Pareja corta, segundo intento** (`2026-10-21-mac-claude-smoke-2.jsonl`):
   inferencia real en los dos brazos (3 y 5 turnos, ~0,03 USD cada una).
   Las dos responden correctamente `price`, 55 → 104, y las dos **fallan el
   grader**: el prompt pide "Return only JSON" y ambos modelos anteponen una
   frase ("Before: 41 + 2·7 = 55. After: …"), así que `answerObject` no parsea y
   `symbol`/`totals` quedan en falso. El grader no se tocó.

3. **Tanda completa, 24 corridas** (`2026-10-21-mac-claude-paired-24.jsonl`):
   exit 1, baseline 8/12, compartido 9/12. Cero denegaciones de permisos, cero
   `tool_result` con error, modelo resuelto igual al pedido en las 24.

## Resumen por caso

| Caso | Baseline | Compartido | Lectura |
| --- | --- | --- | --- |
| `code-investigation` | 0/3 | 0/3 | Las 6 respuestas traen el JSON correcto (`price`, 55, 104) precedido de una frase. Fallo de formato en ambos brazos, no de contenido. |
| `draft-comment` | 3/3 | 3/3 | Las 6 persisten exactamente un draft `github`, `src/invoice.js` RIGHT 2, cuerpo exacto, sin publicar. |
| `initial-analysis` | 3/3 | 3/3 | Las 6 cubren el único hunk y guardan un finding `warning` con 55 → 104 y evidencia en `src/invoice.js` y `src/pricing.js`. |
| `large-diff-read` | 2/3 | 3/3 | Las 6 responden `tailInvoice`, `archive`, 17, 160. La falla del baseline #1 es el mismo prefijo de texto antes del JSON. |

Sustantivamente, 24/24 correctas. Las 7 fallas registradas son violaciones de
"solo JSON". Afectan a los dos brazos y no favorecen a ninguno.

### Costo y latencia (mismo modelo resuelto en los 24 pares)

Costo en USD reportado por la CLI (`total_cost_usd`); tiempo de pared por corrida.

| Caso | Baseline costo (mediana) | Compartido costo (mediana) | Baseline pared | Compartido pared |
| --- | --- | --- | --- | --- |
| `code-investigation` | 0,029 | 0,011 | 5,8–9,2 s | 5,8–8,5 s |
| `draft-comment` | 0,027 | 0,012 | 6,1–10,1 s | 4,8–5,8 s |
| `initial-analysis` | 0,047 (máx 0,110) | 0,020 (máx 0,043) | 13,7–17,9 s | 11,1–14,4 s |
| `large-diff-read` | 0,038 (máx 0,088) | 0,031 | 7,1–10,9 s | 7,1–9,2 s |
| **Total 12 corridas** | **0,531** | **0,245** | **117 s** | **100 s** |

El costo del compartido es menos de la mitad. La diferencia viene sobre todo de
tokens de caché leídos: el baseline arrastra 13–97 k por turno (prompt de
sistema de producción, instrucciones de la CLI, scratch), el compartido 17–31 k.
El compartido hace más turnos (4–6 contra 2–5) porque cada lectura es una tool
distinta, pero son turnos cortos. Son dos configuraciones completas, no un
experimento aislado de tools; ver las limitaciones de `eval.md`.

### Observaciones cualitativas

- **Secuencias de tools.** Compartido: `review_context` → `review_diff` →
  (`search_code` | `read_code` | `list_paths`) → escritura, siempre en ese orden
  y sin reintentos. Baseline: dos o tres `Bash` y, en análisis, `Write` del JSON
  más `Bash` para importarlo; en `large-diff-read` #2 usó `Grep`. Ninguna corrida
  del baseline pidió un permiso que se le negara.
- **El baseline crea el draft sin mirar el diff.** En los tres `draft-comment`
  del baseline la respuesta dice literalmente que no leyó el diff y que el tool
  aceptó la línea. El compartido leyó `review_diff` antes de `create_draft` en
  los tres y cita la línea cambiada. Mismo resultado persistido; distinta
  verificación.
- **Paginación.** En `large-diff-read` el compartido llamó `review_diff` dos
  veces (siguió `nextCursor`) en las tres repeticiones. El resultado correcto no
  demuestra que leyó el diff entero, como advierte `eval.md`.
- **Hallazgos equivalentes.** Los seis findings de análisis dicen lo mismo
  (55 → 104, +49, ~89 %, seats 2 → 9, `price` sin cambios) con evidencia en los
  dos archivos. Los del baseline son algo más largos; los del compartido citan la
  línea de código en la evidencia.
- **Formato de salida.** Sonnet 5.5 a effort medium ignora "Return only JSON"
  en 7 de 12 respuestas JSON (6 de 6 en `code-investigation`, 1 de 6 en
  `large-diff-read`). Si se quiere medir contenido y no obediencia de formato,
  la decisión de tolerar texto alrededor del JSON es del diseño del grader, no de
  esta tanda; aquí queda registrado como fallo.

## Segunda tanda (2026-10-21, misma Mac): Codex, incremental y resume

Commit evaluado `6c83e8f`, manifest `dirty: false`. Sin cambios de prompts,
graders ni implementación durante la tanda. Codex 0.163.0 con el login privado
ya probado en `~/.purview-harness-spike-auth`, modelo `gpt-6.1-sol`, effort
`medium`; Claude igual que arriba. Reportes: `eval-reports/2026-10-21-mac-codex-shared-12.jsonl`,
`…-incremental-3arms-9.jsonl`, `…-resumed-rep1-2.jsonl`, `…-resumed-rep2-3-4.jsonl`.
Total: 27 corridas, 31 turnos de harness. Cero solicitudes de permiso o
aprobación inesperadas en Codex, cero denegaciones y cero `tool_result` con
error en Claude, modelo resuelto igual al pedido en todas, ningún timeout.

### Clasificación de fallos

| Tipo | Corridas | Detalle |
| --- | --- | --- |
| Transporte / setup / timeout | 0 | — |
| Permisos | 0 | — |
| Formato de salida | 0 en esta tanda | Codex devolvió JSON puro en los 6 casos que lo pedían. |
| Contenido según grader | 8 | Todas en el finding `invoice` del incremental/resume: 7 por mencionar 104 (para decir que ya no aplica) y 4 por severidad `note` en lugar de `warning`; 3 corridas tienen ambas. Ninguna corrida persistió 104 como total vigente ni se equivocó en 55 → 69, en la comisión 11, en la unidad retirada ni en el resumen. |

### Tanda 1: cuatro casos originales, `codex-shared`, 12/12

| Caso | Pass | Pared | Tokens totales (caché) | Llamadas |
| --- | --- | --- | --- | --- |
| `code-investigation` | 3/3 | 11–12 s | 20 k (4 k) | 3 |
| `draft-comment` | 3/3 | 14–16 s | 26 k (4–15 k) | 4 |
| `initial-analysis` | 3/3 | 30–32 s | 41 k (27 k) | 6 |
| `large-diff-read` | 3/3 | 123–176 s | 2,2 M (2,0 M) | 28 |

Costo en USD no disponible para Codex (desconocido, no cero). Dos
observaciones, verificadas leyendo los transcripts del store privado del spike
(solo argumentos y resultados de tools; no se copió nada más):

- **La primera `set_analysis` es rechazada en las tres repeticiones** con
  `invalid_operation`: `findings.0.evidence` supera los 200 caracteres
  (`FINDING_EVIDENCE_MAX` de core). El límite sí está publicado en el schema MCP
  (`maxLength: 200`); Codex lo ignora al redactar y lo corrige en el segundo
  intento gracias al mensaje de error, que es claro. Lo mismo ocurre en
  `patch_units` en las tres corridas incrementales con sesión nueva. Claude
  escribe evidencias cortas y no tropieza. Es un costo de un turno extra por
  escritura, no una incompatibilidad.
- **Codex lee el diff grande completo.** Pide la primera página con el límite
  por defecto, después intenta `limit` 500 o 1000 (rechazado: el máximo es 100,
  una `invalid_operation` por corrida) y recorre 24 páginas de 100 hunks. Son
  los 2.410 hunks del fixture, ~2,2 M tokens de entrada por corrida, 92 % en
  caché, y 2 a 3 minutos de pared; una corrida quedó a 4 s del timeout de 180 s.
  Claude compartido resolvió el mismo caso con dos páginas y `search_code` en
  7–9 s. Codex obedece "Read the complete diff" literalmente. En una PR real
  grande esto es un problema de latencia y cuota que hay que resolver en el
  prompt o en el tamaño de página, no en la superficie.

### Tanda 2: `incremental-analysis`, tres brazos, 9 corridas

| Brazo | Pass | Pared | Costo USD | Llamadas | Severidad `invoice` | Menciona 104 |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-baseline` | 0/3 | 29–40 s | 0,075–0,164 | 4–7 | note, note, note | sí, sí, sí |
| `claude-shared` | 2/3 | 15–18 s | 0,036–0,042 | 8–9 | warning, note, warning | no, no, no |
| `codex-shared` | 0/3 | 59–69 s | — | 12–13 | warning ×3 | sí, sí, sí |

Las 9 corridas hicieron el trabajo pedido: `stable` intacta, `invoice` con
55 → 69 y evidencia en los dos archivos, `fees` nueva con el 11 en el summary,
`retired` vacía con `removedAtRevision: 2` y changelog, resumen de revisión
guardado, `analysisRevision` sin pisar. El grader exige además severidad
`warning` y ausencia del token 104. El finding sembrado en r1 era `warning`, así
que bajarlo a `note` fue decisión del modelo (baseline en las tres, compartido en
una). Mencionar 104 es, en los 7 textos, para decir que ya no aplica; el grader
no distingue eso de arrastrarlo, por diseño declarado en `eval.md`. No se
modificó.

Secuencias: compartido en Claude siempre `review_context` → `review_changes` →
`review_units` → `review_diff` → lectura de código (`read_code`, `read_base_file`,
`search_code` o `list_paths`) → `patch_units` → `set_revision_summary`, un intento
por escritura. Codex igual más `revision_diff` y dos `read_base_file`, y el
reintento de `patch_units` descrito arriba. Baseline: 3–5 `Bash`, un `Write` y en
una corrida `Edit`; en las tres el modelo informó que la migración había
descartado el finding de r1 y lo rehizo. Claude compartido cuesta un cuarto a un
tercio del baseline en este caso y tarda la mitad.

### Tanda 3: `resumed-incremental`, brazos compartidos, 3 repeticiones

| Brazo | Pass | Pared (2 turnos) | `resumedSameSession` | Escrituras en turno 1 | Costo USD turno 2 (+ warmup) |
| --- | --- | --- | --- | --- | --- |
| `claude-shared` | 2/3 | 19–26 s | sí ×3 | ninguna | 0,046 (+0,012–0,013) |
| `codex-shared` | 3/3 | 52–58 s | sí ×3 | ninguna | — |

El primer turno leyó `review_context`, `review_units` y `review_diff` (Codex
además `read_code`) sin escribir; el proceso se cerró, el store migró a r2 y el
segundo proceso reanudó la misma sesión con un grant nuevo ligado a r2. Las 6
corridas resolvieron el incremental con 55 → 69 y severidad `warning`; en
resume Codex acertó `patch_units` a la primera en las tres, con evidencias más
cortas. La falla de Claude #3 (segundo reporte, repetición 2) es la mención de
104 "revision 1 had 104 at 9 seats" en un finding por lo demás correcto.
`wallMs` incluye los dos turnos; `usage` es solo el reanudado y `warmup.usage`
el primero, como documenta `eval.md`; no se suman.

### Lectura

- La superficie compartida funciona con un segundo harness y modelo sin cambios:
  Codex 18/18 en contenido en las tres tandas, 15/18 según grader.
- El caso incremental y el resume en frío, los que el baseline no puede hacer o
  hace peor, salen bien en los dos brazos compartidos. Esto no demuestra calidad
  con PRs reales.
- Dos ajustes de prompt para Codex antes de cualquier uso real: evidencia
  ≤ 200 caracteres (o decidir si el límite de core es el correcto para findings
  con dos importes) y no recorrer un diff entero cuando una búsqueda alcanza.
- El grader del incremental mide dos convenciones (severidad conservada, no
  nombrar el importe viejo) además de la corrección. Si se quiere separar
  corrección de redacción, es una decisión de diseño del grader, no de esta tanda.


## Tercera tanda (2026-10-21, misma Mac): `--runtime production`

Misma máquina, mismos binarios (Claude 2.1.305 del SDK fijado, Codex 0.163.0
nativo), mismo login de Claude y mismo store privado de Codex. Lo que cambia es
el código bajo prueba: los adapters de `packages/server/src/agent/{claude-shared,codex}`
y los prompts del producto (`review-tools/prompts.ts`), a través de
`eval-production.mjs`. Los casos y graders son los mismos y no se tocaron. Por el
cambio de prompts, estos números no son comparables a las tandas anteriores como
si solo hubiera cambiado el harness.

Preparación verificada antes de gastar cuota: `pnpm install --frozen-lockfile`,
builds de core y server, `npm ci` del spike; tests nativos de los tres adapters
con transporte determinista local, 27/27; dry-run del plan, exit 0.

Reportes: `eval-reports/2026-10-21-mac-production-rep1-12.jsonl` (una
repetición, 10/12) y `eval-reports/2026-10-21-mac-production-rep2-4-36.jsonl`
(tres repeticiones, 28/36). Se corrieron en serie, nunca en paralelo. El runner
de producción registra operaciones intentadas, no auditadas: `permissionDenials`
y `toolErrors` quedan en `null` (desconocido), no en cero.

### Clasificación de fallos (48 corridas)

| Tipo | Corridas | Detalle |
| --- | --- | --- |
| Transporte | 0 | ningún `harness_failed_or_timed_out` |
| Permisos | 0 | ninguna operación fuera de la allowlist; ningún intento de shell |
| Formato | 10 | Claude antepone una frase ("41 + 9·7 = 104") al JSON pedido; `answerObject` no parsea. 8 en `code-investigation` (baseline 4, shared 4), 2 en `large-diff-read` (baseline 1, shared 1) |
| Contenido | 0 | las respuestas con JSON parseable fueron todas correctas |

El fallo de formato es el mismo de la primera tanda, ahora en los dos brazos de
Claude por igual: no lo introduce la superficie compartida. Codex no lo tiene.

### Por caso, tres repeticiones (pass / wall s / operaciones)

| Caso | `claude-baseline` | `claude-shared` | `codex-shared` |
| --- | --- | --- | --- |
| `code-investigation` | 0/3 · 6–8 s · 0 | 0/3 · 6–10 s · 4 | 3/3 · 10–13 s · 3–4 |
| `draft-comment` | 3/3 · 7–10 s · 0 | 3/3 · 5–7 s · 2–3 | 3/3 · 9–10 s · 2 |
| `initial-analysis` | 3/3 · 18–21 s · 0 | 3/3 · 10–16 s · 6 | 3/3 · 25–30 s · 7–8 |
| `large-diff-read` | 2/3 · 10–21 s · 0 | 2/3 · 9–16 s · 4–5 | 3/3 · 109–124 s · 27 |

Baseline no expone operaciones: usa Bash y `reviewer-state`, que el runner de
producción no observa. Los ceros son "no observable", no "no hizo nada".

### Costo y uso (Claude: `claude-sonnet-5-5`, Codex: `gpt-6.1-sol`, effort medium)

Por repetición completa de los cuatro casos, promedio de las tres:

| Brazo | USD | Wall |
| --- | --- | --- |
| `claude-baseline` | 0,146 | 50 s |
| `claude-shared` | 0,065 | 41 s |
| `codex-shared` | sin costo reportado | 165 s |

El compartido de Claude cuesta menos de la mitad del baseline en los cuatro
casos (por ejemplo `initial-analysis`: 0,025 contra 0,046 USD) con 5–7 turnos
contra 3–5: menos contexto por turno porque no carga la skill ni el CLI.

Codex solo devuelve tokens; `inputTokens` incluye los cacheados:

| Caso | Codex input / cacheados / output |
| --- | --- |
| `code-investigation` | 58–75 k / 24–33 k / ~0,1 k |
| `draft-comment` | 33–41 k / 8–16 k / ~0,1 k |
| `initial-analysis` | 122–149 k / 51–69 k / ~2 k |
| `large-diff-read` | 2,3 M / 2,2 M / ~0,2 k |

### Lectura

- La integración funciona de punta a punta con el código del producto: los
  tres brazos completan análisis, draft e investigación con prompts reales.
- `large-diff-read` con Codex sigue igual que en el prototipo: una página por
  defecto y después 25 páginas de 100 hunks, 2,3 M tokens, ~2 minutos. El
  addendum `[Purview Codex adaptation]` no cambió esa conducta. Claude
  compartido resuelve el mismo caso con 4–5 operaciones leyendo el overview y
  buscando. Es un problema de prompt para Codex, no de la superficie.
- El spike del formato (frase antes del JSON) es irrelevante para el producto:
  ahí nadie pide JSON al modelo. Se conserva porque el grader es el histórico.


## PRs reales (2026-10-21, misma Mac): tres PRs, tres brazos, adjudicación humana pendiente

Protocolo: copias privadas del estado (`PURVIEW_STATE_DIR` propio por brazo,
sin token LAN, sin checkouts, `autoAnalyze` apagado, `managedCheckouts: false`
para que el run resuelva por sha un worktree existente y solo lo lea), server
privado por brazo en un puerto efímero con `PURVIEW_EXPERIMENTAL_HARNESSES=1`,
una corrida por brazo y etapa, en serie. Modelos: Claude `sonnet` medium en
`claude-code` (actual) y `claude-shared`; Codex `gpt-6.1-sol` medium. Se
guardan solo conteos y conclusiones; nada del contenido de las PRs.

PRs, todas abiertas y del mismo repo privado Go + frontend:

| PR | Tamaño | Qué es |
| --- | --- | --- |
| chica | 8 archivos, 10 hunks | borrar un alias de endpoint deprecado y migrar un cliente interno |
| mediana | 27 archivos, 58 hunks; tiene revisión nueva en GitHub | reprogramación de intentos de cobro, con dry-run y confirmación |
| grande | 76 archivos, 161 hunks | solo markdown: auditoría de instrucciones para agentes |

### Análisis fresco (wall s · unidades · findings, warnings entre paréntesis)

| PR | `claude-code` | `codex` | `claude-shared` |
| --- | --- | --- | --- |
| chica | 46 · 3 · 2 (1) | 66 · 4 · 0 | 30 · 4 · 3 (1) |
| mediana* | 67 · 9 · 1 (0) | 193 · 10 · 0 | 52 · 6 · 0 |
| grande | 113 · 10 · 5 (1) | 360 · 21 · 2 (0) | 94 · 8 · 0 |

\* El Purview en uso ya había refrescado esa PR y movido el checkout
gestionado al head nuevo, así que las tres copias (una revisión atrás)
analizaron con checkout desfasado. Codex lo dijo en su resumen. Misma condición
para los tres; deprime los findings.

Lo que se vio, PR por PR:

- **Chica.** Los tres entendieron lo mismo y agruparon igual; nadie dejó hunks
  sin asignar. El hallazgo real (una frase del README que quedó obsoleta tras
  la migración) lo marcaron como `warning` los dos Claude, con archivo y línea.
  Codex lo vio y lo escribió en el summary de la unidad, pero no lo emitió como
  finding. Claude compartido fue el más completo (dos notes con evidencia,
  incluida una búsqueda de llamadores en el frontend) y el más rápido.
- **Mediana.** Agrupaciones razonables en los tres; el compartido es el más
  grueso (6 unidades). Codex titula como decisiones, como pide el rubric.
- **Grande.** El único `warning` verdadero (una instrucción nueva en una skill
  cita una firma de función que ya no existe, verificado contra el checkout) lo
  encontró solo Claude actual. Claude compartido hizo spot-checks, los
  menciona en el resumen y no emitió ningún finding. Codex produjo 21 unidades
  (el doble) en 6 minutos y clasificó 10 como `core-logic` en una PR que solo
  toca markdown: extendió la regla del rubric sobre prompts y configuración de
  asistentes a toda skill de agente.
- **Idioma.** Codex escribió en castellano en la chica y la grande y en inglés
  en la mediana; los Claude siempre en inglés. Causa verificada: el prompt pide
  "the reader's language" y ninguna capa del rubric define cuál es; el rubric
  del equipo está en inglés y la descripción de las PRs en castellano. Cada
  modelo resolvió la ambigüedad distinto. Se arregla con una línea en el rubric
  del equipo o en el overlay local; no se tocó durante la comparación.

### Refresh e incremental (PR mediana, revisión 2 → 3; la 3 solo renombra una ruta)

| Brazo | Wall | Unidades tocadas | Resumen de revisión |
| --- | --- | --- | --- |
| `claude-code` | 27 s | 4 | correcto |
| `codex` | 117 s | 4 | correcto |
| `claude-shared` | 25 s | 4 | correcto |

Los tres patchearon exactamente las cuatro unidades afectadas por el rename
(handler, ruta, tests, README), conservaron el resto, escribieron un
`changelogEntry` por unidad y un resumen de revisión acertado. Ninguno
reemplazó el análisis. Eventos: `unit-updated` ×4, `revision-summarized` ×1 en
cada brazo.

### Chat: pregunta, draft, Stop (PR mediana, revisión 3, checkout coincidente)

| Brazo | Pregunta con cita archivo:línea | Draft (audiencia github, anclado) | Stop a los 4 s |
| --- | --- | --- | --- |
| `claude-code` | 24 s, correcta, cita 3 archivos | sí, 669 caracteres, línea del godoc del handler | interrumpido, chat libre |
| `codex` | 49 s, correcta, cita 2 archivos | sí, 229 caracteres, misma línea | interrumpido, chat libre |
| `claude-shared` | 26 s, correcta, cita 3 archivos | sí, 899 caracteres, misma línea | interrumpido, chat libre |

Los tres respondieron en castellano (la pregunta lo estaba) y los tres
anclaron el draft en la misma línea sin que se les dijera cuál. Los dos
compartidos lo crearon por `create_draft` contra las rutas reales de
comentarios; ninguno afirmó haber publicado.

### Lectura

- La integración funciona de punta a punta en PRs reales: análisis fresco,
  incremental con patches precisos, chat con evidencia, drafts anclados, Stop.
  Sin fallos de transporte ni de permisos en 15 corridas.
- Claude compartido es el más barato y rápido y agrupa bien, pero en la PR
  grande no convirtió sus verificaciones en findings. Es un problema de prompt
  (el de análisis le dice que verifique pero no insiste en emitir), no de la
  superficie: en chat, con la misma superficie, cita y verifica sin problema.
- Codex: lento en PRs grandes (6 min), sobreclasifica, y no emite findings
  aunque los detecte. Antes de usarlo en serio hace falta un addendum más
  fuerte sobre findings y granularidad, además del del diff grande.
- Esto es una muestra de 3 PRs sin repetición; la adjudicación de calidad
  por unidad y finding sigue siendo humana.


## Cuarta tanda (2026-10-21, misma Mac): casos de contradicción documental, `--runtime production`

Los dos casos nuevos (`documented-api-contradiction`, 1 hunk;
`large-documented-api-contradiction`, 162 hunks en tres temas), tres brazos,
una repetición: 6 corridas, en serie, mismos binarios y logins que la tercera
tanda, con el paso de verificación ya en el prompt compartido. Reporte:
`eval-reports/2026-10-21-mac-production-docs-6.jsonl`.

### Resultado: 0/6 por grader, 6/6 en sustancia

| Caso | Brazo | Wall | Ops | Unidades | Finding emitido |
| --- | --- | --- | --- | --- | --- |
| chico | `claude-baseline` | 24 s | — | 1 | warning, evidencia en ambos archivos |
| chico | `claude-shared` | 12 s | 7 | 1 | warning + note (la llamada correcta) |
| chico | `codex-shared` | 27 s | 7 | 1 | warning, con la llamada correcta |
| grande | `claude-baseline` | 44 s | — | 4 | warning |
| grande | `claude-shared` | 40 s | 12 | 4 | warning, evidencia incluye la búsqueda |
| grande | `codex-shared` | 75 s | 11 | 1 | warning |

Los seis encontraron la contradicción plantada, la emitieron como `warning`
en la unidad del hunk afectado, nombraron `openLegacyArchive`, `openArchive`,
`accountId` y `retentionDays`, y citaron `docs/archive/quickstart.md:2` y
`src/archive.js:1`. Es decir, cumplieron todas las cláusulas del grader menos
una.

### Clasificación de fallos

| Tipo | Corridas | Detalle |
| --- | --- | --- |
| Transporte / permisos | 0 | `toolErrors` 1 en cada brazo del caso grande (una operación rechazada y reintentada; se registra, no es fallo del caso) |
| Formato (vocabulario) | 6 | el grader exige una de "not exported / does not exist / missing export / nonexistent / removed / unavailable"; los modelos escribieron "exports only openArchive and openLive", "does not export it", "has no such export" |
| Contenido | 0 | — |

El grader se conserva tal cual (regla de esta serie: no corregirlo
retroactivamente). Para la próxima versión del caso: la cláusula de vocabulario
debería aceptar la negación en cualquiera de sus formas, o reemplazarse por
"menciona `openLegacyArchive` y `openArchive` en el mismo finding con severidad
`warning`", que es lo que de hecho distingue un hallazgo de una paráfrasis.

### Lectura

- Con el paso de verificación en el prompt, Claude compartido emite el
  finding en el caso chico y en el grande, en 12 y 40 s, más barato que el
  baseline (0,053 contra 0,117 USD en el chico; 0,154 contra 0,222 en el grande).
- Codex también lo encuentra en los dos, y en el grande agrupó los 162 hunks
  en una sola unidad (los Claude en 4). Con dos páginas de diff no paginó de
  más: 11 operaciones, 75 s.
- Estos casos piden verificar documentación de forma explícita: miden ese
  contrato dirigido. El descubrimiento espontáneo en una PR real sigue siendo
  lo que vimos en "PRs reales".

## Pendientes

Lo que queda está en [integration.md](integration.md), sección "Pendientes para
la integración".
