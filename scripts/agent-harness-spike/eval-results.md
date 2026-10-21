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

## Pendientes

- Casos optativos (`incremental-analysis`, `resumed-incremental`) sin correr
  con modelos reales en la Mac.
- Brazo `codex-shared` sin correr en esta tanda.
- Ejemplos de reviews reales con protocolo acordado; estos casos son sintéticos
  y dirigidos.
