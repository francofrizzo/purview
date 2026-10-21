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

## Pendientes

- Casos optativos y `codex-shared`: corridos en la segunda tanda (arriba).
- `large-diff-read` con Codex a 2–3 minutos: medir con `--timeout-ms` mayor o
  con una instrucción que permita buscar en vez de paginar todo.
- Ejemplos de reviews reales con protocolo acordado; estos casos son sintéticos
  y dirigidos.
