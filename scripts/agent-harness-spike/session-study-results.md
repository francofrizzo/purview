# Estudio de sesiones reales de Purview: resultados

Fecha: 2026-10-21. Lectura local y de solo lectura según `session-study.md`.
Estado original intacto; no se contactó el servidor ni se ejecutó ningún
comando hallado en transcripts. Las etiquetas (`A05`, `C167`, `R1`, `R2`) son
locales a este estudio y no identifican nada fuera de él.

## 1. Resumen: hallazgos que cambian el diseño

1. **La capa de permisos es la principal fuente de error, y castiga la forma
   del comando, no su intención.** Observación: 123 de 2.123 resultados de
   herramienta son denegaciones de Bash (5,8 %); 94 de 268 sesiones (35 %)
   sufren al menos una. 121 de las 123 denegaciones son búsquedas sobre el
   checkout: `grep` recursivo encadenado con `cd`, variables de shell, `;` y
   `| head`. Un `grep` simple sobre el mismo checkout no se deniega (A09:
   cuatro greps planos, cero denegaciones; A207 y A12: las mismas búsquedas
   pasan por la tool Grep). Tras una denegación, el agente reintenta otra
   forma de Bash en unos 51 casos y cambia a Grep/Read en unos 40; en los
   20 casos leídos a fondo siempre terminó recuperándose, pero A12 falló el
   primer diagnóstico (quitó el `cd`, no las variables) y A223 nunca corrigió
   una ruta equivocada y abandonó el checkout por `base-file`.
   Interpretación: el agente necesita una búsqueda multi-patrón acotada sobre
   el checkout, y hoy la compone en shell porque no hay otra cosa.
   Recomendación: una tool tipada `search_checkout` (varios patrones, glob de
   inclusión/exclusión, contexto, tope de resultados) y `read_checkout` por
   rangos, permitidas por construcción. Confianza alta.

2. **Dos tercios del trabajo es Bash, y la mitad de ese Bash es el CLI de
   Purview.** Observación: 1.383 de 2.123 llamadas (65 %) son Bash; 708 de
   ellas invocan `reviewer-state` (`show` 218, `set-analysis` 133, `triage`
   132, `set-units` 121, `changes` 97, `units` 90, `set-revision-summary` 32,
   `base-file` 11, `comment` 7, `history` 4, `report` 3). 89 llamadas
   encadenan dos o más verbos; 61 de las 708 pasan `show` o `units` por
   `| head`. Interpretación: el agente ya opera una máquina de estado tipada a
   través de un shell; los verbos son las tools. Recomendación: una tool por
   verbo con la misma semántica y la misma validación, más una lectura
   paginada para `show`/`changes`. Confianza alta.

3. **El análisis viaja por archivo y se valida al importar, tarde.** Observación:
   248 Write, todos JSON en el estado de Purview (mediana 3 KB, máx. 21 KB);
   68 sesiones importan dos veces; 9 importaciones fallan por validación de
   cobertura ("el análisis no cubre un hunk": 7) y se reparan con Edit.
   En A09 el import parcial funcionó como lista de pendientes (seis unidades
   cambiadas sin parchear) y guió una segunda ronda. Interpretación: el
   validador es útil, pero llega después de redactar todo el payload.
   Recomendación: tools de escritura que reciban el payload estructurado y
   devuelvan lo que falta (hunks sin cubrir, unidades cambiadas sin parche)
   sin pasar por un archivo; conservar la semántica "parcial y reporta
   pendientes". Confianza media-alta.

4. **Los resultados grandes se recortan a mano y se leen a medias.** Observación:
   402 de 538 greps sobre el checkout terminan en `| head` (N: 20 en 105
   casos, 30 en 94, 40 en 45). 19 salidas se derraman a archivo (5 `changes`,
   9 Bash varios, 2 `base-file`, 2 Grep, 1 `triage`) y 91 lecturas superan
   16 KB, casi todas de esos derrames. En la lectura profunda, el agente lee
   el derrame entero en 2 de 5 casos y por rangos en 3; en A354 un tercio del
   derrame de 164 KB nunca se leyó y una lectura fue rechazada por tamaño.
   Interpretación: el modelo decide cuánto ver antes de saber qué hay.
   Recomendación: paginación y tabla de contenidos en las tools de lectura
   (`show`, `changes`, búsqueda), con "siguiente página" explícito, en vez
   de derrame a archivo. Confianza media.

5. **El chat necesita leer código fuera del diff más que cualquier otra cosa;
   los comentarios son el final, no el medio.** Observación: en 40 chats,
   Grep (108) + Read (54) + greps por Bash (~120) dominan; el CLI aparece 44
   veces y `comment` 7. Los cinco chats leídos a fondo buscan call sites,
   convenciones y lógica fuera del diff en cada turno; en dos de ellos el
   revisor pidió comentar y en uno el prompt de esa época no lo permitía.
   Recomendación: no retirar la lectura del checkout ni los diffs por
   revisión del chat; agregar `comment add/edit/delete` como ya existe, con
   verificación previa del anclaje (`show`), que es lo que el agente hace solo
   (2 de 2). Confianza alta.

## 2. Cobertura

| | Inventariadas | Localizables | Examinadas a fondo |
| --- | --- | --- | --- |
| Corridas de análisis (`analysis-finished`) | 355 | 228 | 15 |
| Chats (`chat.json`) | 65 | 40 | 5 |

- Root de estado: el predeterminado (`PURVIEW_STATE_DIR`, `REVIEWER_STATE_DIR`
  y `CLAUDE_CONFIG_DIR` no estaban definidos en el entorno del estudio). No se
  puede excluir que existan otros roots en otros entornos.
- 159 directorios de PR en 2 repos: `R2` concentra 416 de 420 registros;
  `R1`, 4. Sesgo fuerte hacia un repositorio y un equipo.
- Los 127 registros antiguos sin `metrics.run` (previos a los ids de harness)
  no son localizables: no guardan `sessionId` ni `cwd`. Los 25 chats sin
  sesión tampoco. Ningún registro declara otro harness: todos son Claude Code.
- Estados: 314 `done`, 33 `failed`, 8 `cancelled`. Causas registradas de
  fallo: reinicio del servidor 17, el harness salió con código distinto de 0
  8, timeout 7; en los leídos a fondo también red/suspensión y límite de uso.
  Tipos: initial 110, refresh 92, fresh 22, rerun 4, legacy 127.
- Ventana: 2026-08-13 a 2026-10-21. Versiones del harness 2.1.280 a 2.1.305;
  modelo `sonnet` en todas las corridas con metadatos (34 resueltas a una
  generación anterior, 194 a la actual). Los prompts cambiaron en el período
  (checkout en rama por defecto → checkout exacto del head; sin → con
  `base-file`; chat sin → con comentarios).
- Duración mediana: initial 35 s, refresh 35 s, fresh 82 s, legacy 198 s.
- Selección intencional, no representativa: 3 fallidas, 2 canceladas, 5 chats
  (los de más turnos y errores, uno de `R1`), 10 exitosas variadas por tipo,
  versión y tamaño. `R1` aporta 2 de 20.
- 143 de 268 transcripts repiten cada `tool_use`/`tool_result` en una segunda
  clase de línea; todo conteo de este informe es por id único de llamada. Los
  bloques `thinking` están vacíos: el razonamiento no es observable.

## 3. Herramientas y operaciones

Universo: 268 transcripts, 2.123 llamadas únicas. Una llamada Bash puede caer
en varias categorías; los porcentajes son sobre 1.383 Bash salvo indicación.

| Categoría | Llamadas | Notas |
| --- | --- | --- |
| Bash total | 1.383 (65 % de todo) | análisis 1.201, chat 182 |
| Bash → `reviewer-state` | 708 (51 %) | 89 encadenan verbos; 69 con pipe |
| Bash → grep sobre checkout | 538 (39 %) | 447 recursivos, 402 con `\| head`, 109 con contexto `-A/-B/-C` |
| Bash con `cd` previo | 151 (11 %) | casi siempre al checkout |
| Bash con variable de shell | 151 (11 %) | ruta del CLI o del checkout; el prompt lo prohíbe |
| Bash → git | ~20 (1 %) | solo dentro de comandos compuestos; denegado o innecesario |
| Bash → tests/build | 3 | marginal |
| Bash → texto (`sed -n`, `cut`, `awk`) | ~90 | casi siempre `sed -n` de rangos tras un grep |
| Bash → escritura | ~0 | las escrituras van por Write |
| Write | 248 (12 %) | JSON de análisis/unidades en el estado de Purview |
| Read | 250 (12 %) | 166 derrames `.txt` del estado, 78 archivos del checkout |
| Grep (tool) | 204 (10 %) | 190 sobre el checkout; chat 108, análisis 96 |
| Edit | 34 | reparar el JSON tras validación |
| Glob | 4 | |
| Subagentes | 0 | |

Errores: 161 resultados con error (138 Bash, 11 Grep, 8 Read, 2 Write, 2
Edit). De los 138 de Bash: 123 denegaciones de permiso, 9 fallos de import o
verbo del CLI, 6 otros. No medidos por bandera de error: fallos silenciosos de
zsh (globs sin comillas, `=` en `echo`) que vuelven como salida normal; la
lectura profunda encontró 7 en 20 sesiones.

Tamaños: 1 % de resultados ≥ 64 KB, 8 % entre 16 y 64 KB, 25 % < 200 B. El
mayor resultado inline fue 69 KB. Los usuarios aportan 1 turno en análisis
(siempre) y 1 a 12 en chat (mediana 1, p75 3).

## 4. Secuencias anonimizadas

Comandos esquemáticos inventados a partir del patrón; no son citas.

**S1. Primer análisis estándar (A01, A05; patrón de 60 corridas).**
`triage` → `show <todos los hunks de 10 a 19 archivos>` (derrama a archivo con
tabla de contenidos) → Read del derrame (entero o por rangos) → 1 a 3
búsquedas en el checkout → Write `analysis.json` → `set-analysis`. Resultado:
importa a la primera, 8 a 10 unidades, todos los hunks cubiertos. Problema:
solo una parte de los cuerpos de hunk se leyó (A12: 15 de 79; A01: 28 de
48), y el agente lo declaró. Capacidad a conservar: `triage`, `show` paginado,
búsqueda en checkout, escritura validada.

**S2. Primer análisis con la búsqueda denegada (A05, A12, A207).**
Igual que S1 hasta la verificación; el grep compuesto
(`cd checkout; X=...; grep -rn p1 | grep -v tests | head -30; grep ...`) es
denegado; A12 quita el `cd` y vuelve a ser denegado; luego 2 a 3 llamadas a la
tool Grep con alternancia de símbolos y una lectura por rango del archivo de
entrada. Resultado: importa; en A207 falla la cobertura por un id de hunk mal
tipeado (mezcla de dos ids reales) y un Edit lo repara. Capacidad: búsqueda
multi-patrón con exclusiones y tope; validación con ids conocidos.

**S3. Primer análisis sin acceso al checkout (A223).**
Nueve intentos de leer el checkout, todos denegados por apuntar al directorio
padre sin el segmento del PR; nunca corrige la ruta. Pasa a `base-file` (uno
de tres archivos encadenados devuelve 80 KB, derramado), hace grep y `sed -n`
sobre el derrame y escribe el análisis. Resultado: importa, 4 hallazgos de
nivel nota, sin haber leído el head. Problema: la denegación no dijo "ruta
fuera del checkout" de forma que el agente la entendiera. Capacidad: lectura
del lado base; mensajes de denegación accionables.

**S4. Refresh incremental mínimo (A237, A314).**
`show; changes; units` en una sola llamada → Write parche de 1 unidad →
`set-units`. En A314 `changes` reporta que nada cambió y el agente para en 4 s
(y omite la verificación que el prompt pedía). Capacidad: `changes` y
`units` como vistas; permitir "no hay trabajo" como salida válida.

**S5. Refresh grande en dos rondas (A09, A354).**
`changes` (derrama 25 KB) → Read → `units` → greps planos → parche 1 →
`set-units` responde "6 unidades cambiadas sin parchear" → `show` de esos
hunks (derrama 31 KB) → 2 Reads por rango → parche 2 → `set-units` completo →
`set-revision-summary`. En A354: 66 hunks nuevos, `show --needs` derrama 164
KB, 6 lecturas por rango, una rechazada por tamaño, un tercio sin leer; 2
denegaciones y 1 glob silencioso antes de 2 Grep que funcionan. Capacidad:
import parcial que reporta pendientes; paginación real.

**S6. Chat de preguntas sobre código (C32; 10 chats "solo Grep").**
Por turno: Grep de un símbolo → `sed -n` del rango → ampliar a call sites.
Nunca escribe. Problema: un glob sin comillas devuelve "no matches" como
salida normal; el agente pasa a la tool Grep. Capacidad: búsqueda con
contexto y lectura por rango, con ida y vuelta rápida.

**S7. Chat largo con hallazgos acumulados (C167, 12 turnos).**
`changes` (derrama 109 KB) → grep y Read del derrame → ~18 greps compuestos →
`base-file` dos veces → el revisor pide "agregá el comentario" y el prompt de
esa época lo prohíbe: el agente devuelve el texto y el anclaje → tres turnos
de redacción de handoff con dos correcciones humanas (destinatario equivocado;
"menos prescriptivo"). Un comando compuesto con `git log` es denegado; sigue
por Read. Capacidad: diffs por revisión, lado base, comentarios; estado de
hallazgos que hoy vive solo en la conversación.

**S8. Chat que mapea un informe externo y comenta (C225).**
El revisor pega un informe de revisión ajeno con 10 hallazgos → `triage` +
`show` de dos hunks para mapearlo a unidades → 6 Read/Grep fuera del diff →
`cd` a un directorio fuera del checkout, denegado; 4 Read/Grep con ruta sin el
segmento del PR, fallidos; corrige y sigue → "no tan quisquilloso" reduce a 2
comentarios → `show` del hunk → `comment add` con heredoc. Capacidad:
resolver hunk ids y anclajes antes de escribir; `comment add`.

**S9. Chat "¿quedaron atendidos mis 9 comentarios?" (C21).**
Un comando compuesto (read + grep + ls + `git log`) denegado → Read, Glob,
Grep del checkout → grep sobre los diffs de dos revisiones guardadas → tabla
de 9 comentarios (7 hechos, 1 parcial, 1 sin cambio) y 2 riesgos marcados como
no verificados. Capacidad: comparación revisión contra revisión y los
comentarios previos con su anclaje.

**S10. Corridas que no llegan a nada (A202, A263, A371, A339).**
Dos no hacen ninguna llamada (límite de uso; cancelación a los 4 s); una se
detiene tras `triage` sin error registrado; otra pierde la red y se duerme
(39 min de reloj por 22 s de API). El log explica 2 de 5 fallos. Capacidad:
ninguna; lo que falta es telemetría del fallo, no una tool.

## 5. Propuesta de capacidades

Lo que debe existir, derivado de S1 a S9:

- **Vistas de estado**: `triage`, `show` (por hunk, archivo o selector
  `needs`), `changes`, `units`, `history`, `report`. Paginadas, con tabla de
  contenidos y "siguiente", nunca derrame a archivo. Son 557 de las 708
  llamadas al CLI.
- **Lectura del código**: `search_checkout` (varios patrones, include/exclude,
  contexto, tope) y `read_checkout` (archivo, rango). Cubren 538 greps + 78
  Reads + 190 Grep + los `sed -n`. `read_base_file` para el lado base (11 +
  S3, S7). `revision_diff` para comparar revisiones (S9, S7).
- **Escrituras de análisis**: `set_analysis`, `set_units` (parcial, devuelve
  pendientes), `set_revision_summary`, con validación de cobertura e ids en
  la llamada. Son 286 llamadas hoy, más 248 Write y 34 Edit que desaparecen.
- **Comentarios**: `comment add/edit/delete`, precedidos por `show` del
  anclaje. Solo 7 llamadas hoy, pero es el cierre de los chats.

Lo que puede agruparse: `triage`+`show` inicial como una sola vista paginada;
`changes`+`units` como una vista de refresh (aparecen juntos 38 veces).

Lo que no conviene retirar todavía: un Bash de solo lectura acotado al
checkout. Razón: `git` no fue necesario en ningún caso leído, pero `sed -n`,
`wc`, `ls` y pipelines de filtrado aparecen en ~90 llamadas y en el chat el
revisor pide cosas no previstas (contar ocurrencias en el lado base, listar
migraciones). Sin esa válvula, cada carencia de las tools tipadas se vuelve
una denegación como las 123 de hoy. Retirarlo cuando dos ciclos de evaluación
muestren que las tools cubren lo que el shell hacía.

No asumido: que Bash sea imprescindible para Codex. En Codex el Bash
equivalente es `exec_command` dentro de Code Mode, con su propio sandbox; lo
que se comparte son las vistas y escrituras tipadas, no el shell.

## 6. Candidatos de evaluación viejo vs nuevo

Especificaciones; ninguna se ejecutó ni requiere fixtures privadas.

1. **Primer análisis con verificación (S1/S2).** Inputs: un PR sintético de
   10 a 15 archivos, 30 a 80 hunks, checkout del head. Esperado, independiente
   del modelo: todos los hunks cubiertos, import a la primera, cero
   denegaciones, cuerpos de hunk leídos ≥ 90 %. Detectar: imports repetidos,
   hunks sin cuerpo leído, ids inventados. Datos: reproducible con cualquier
   repo público; el viejo flujo se mide con los mismos contadores de este
   estudio.
2. **Búsqueda denegada y recuperación (S2/S3).** Inputs: el mismo PR con una
   ruta de checkout ambigua (directorio padre con varios PRs). Esperado: el
   flujo nuevo no deniega; el viejo deniega y debe recuperarse en ≤ 1 intento.
   Detectar: lectura del lado base como sustituto silencioso del head.
3. **Refresh en dos rondas (S5).** Inputs: revisión 1 analizada, revisión 2
   con 40 a 70 hunks nuevos y 5 unidades cambiadas. Esperado: pendientes
   reportados por el import parcial y resueltos; resumen de revisión escrito;
   ninguna lectura rechazada por tamaño. Detectar: unidades vaciadas no
   revividas, tercios de salida sin leer.
4. **Refresh vacío (S4).** Inputs: revisión sin hunks nuevos. Esperado:
   terminar en < 10 s sin escribir, declarando que no hay trabajo. Detectar:
   escrituras vacías, verificación innecesaria.
5. **Chat de call sites (S6).** Inputs: 5 preguntas fijas sobre un símbolo del
   PR sintético. Esperado: respuesta cita archivo y línea existentes en el
   head; cero globs silenciosos. Detectar: citas a líneas inexistentes,
   respuestas sin leer código.
6. **Chat "¿atendieron mis comentarios?" (S9).** Inputs: 9 comentarios
   anclados en revisión 1 y una revisión 2 que atiende 7. Esperado: tabla con
   7/1/1 correctos. Detectar: comparación contra el head en vez de contra la
   revisión; comentarios perdidos.
7. **Anclaje y creación de comentario (S8).** Inputs: pedido de un comentario
   en una línea dada. Esperado: `show` antes de `comment add`, un solo borrador
   con el anclaje correcto. Detectar: comentario duplicado, línea corrida.
8. **Salida grande (S7).** Inputs: `changes` de > 100 KB. Esperado: el agente
   recorre todas las páginas o declara cuáles omitió. Detectar: respuesta
   basada en la primera página sin decirlo.

## 7. Pendientes y limitaciones

- **Calidad de las reviews: no juzgable con estos registros.** `done` y exit 0
  dicen que la corrida terminó; el razonamiento está vacío, el estado del PR en
  ese momento no se conserva y no hay verdad de referencia. Lo resuelve un
  conjunto de PRs sintéticos con unidades y hallazgos esperados (sección 6).
- **127 corridas antiguas y 25 chats sin transcript**: el período agosto a
  mediados de septiembre está subrepresentado; las conclusiones valen sobre
  todo para 2.1.280 en adelante.
- **Un solo repositorio y un solo harness.** No hay sesiones de Codex ni de
  otro equipo; nada aquí mide cómo Codex compondría estas operaciones.
- **Causas de denegación**: se infiere por forma de comando y por la ruta
  equivocada; no se ejecutaron las reglas de permisos contra cada comando.
  Lo resuelve una tabla de reglas por versión aplicada a los 1.383 comandos.
- **Fallos sin causa registrada** (3 de 5 leídos): el log de Purview no guarda
  por qué se detuvo una corrida. Lo resuelve registrar el último evento del
  harness y el motivo de cancelación en `analysis-finished`.
- **Errores silenciosos de shell** no se cuentan por bandera; su frecuencia
  real en el universo no se midió.
- **Derrames y scratch persistentes**: un Write sobrescribió un archivo de
  una corrida anterior (A12); para comparaciones reproducibles hace falta
  scratch por corrida.
