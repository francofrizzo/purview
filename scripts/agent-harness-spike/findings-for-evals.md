# Hallazgos del spike, organizados para construir evals

Cada entrada es una conducta observada en corridas reales de 2026-10-21, con
dónde está la evidencia, cómo convertirla en un caso de eval y qué regla de
grader la detectaría. Los casos existentes viven en `eval-fixture.mjs` y los
graders en `eval.mjs`; los reportes en `eval-reports/`. Todo lo de PRs reales
está sanitizado: conteos y conclusiones, sin contenido de las PRs.

Convenciones: **evidencia** apunta a un archivo de reporte (cada línea `run`
tiene `caseId`, `arm`, `repeat`, `answer`, `operations`, `grading`) o a una
sección de [eval-results.md](eval-results.md). **Estado**: `cubierto` (ya hay
caso y grader), `parcial`, `falta`.

## 1. Formato: Claude antepone prosa al JSON pedido

- **Observado**: en `code-investigation` y `large-diff-read`, Claude (baseline y
  compartido por igual) responde "41 + 9·7 = 104\n\n{...}" cuando el prompt pide
  solo JSON. 10 de 48 corridas en producción, 7 de 24 en el prototipo. Codex
  nunca. Es un hábito del modelo, no de la superficie.
- **Evidencia**: `eval-reports/2026-10-21-mac-production-rep2-4-36.jsonl`,
  runs `code-investigation` de ambos brazos Claude; `eval-reports/2026-10-21-mac-claude-paired-24.jsonl`.
- **Eval**: ya existe; el grader exige `JSON.parse(answer)`. Para el producto
  no importa (nadie pide JSON al modelo), pero sirve de canario de "sigue la
  instrucción de formato". Si se quiere medir contenido sin el ruido de
  formato, agregar un grader tolerante que extraiga el primer bloque `{...}`
  y reportar las dos métricas por separado.
- **Estado**: cubierto (estricto); parcial (tolerante, falta).

## 2. Findings verificados pero no emitidos

- **Observado**: en la PR real grande (76 archivos, solo markdown) Claude
  compartido hizo spot-checks, los relató en el resumen y emitió 0 findings;
  Claude actual encontró el único `warning` verdadero (una firma de función
  citada en una skill que ya no existe). En la PR chica Codex vio la frase
  obsoleta del README, la escribió en el summary de la unidad y no la emitió
  como finding. Patrón: la verificación ocurre, la persistencia como finding no.
- **Evidencia**: eval-results.md, "PRs reales", tablas de análisis fresco y
  lectura por PR.
- **Eval**: fixture con N hunks donde un cambio contradice el checkout de forma
  verificable (ejemplo: un doc o comentario que cita un identificador que la
  rama renombró). Grader: existe un finding cuyo `evidence` nombra el archivo
  correcto y cuyo texto menciona el identificador; que el summary lo mencione
  no cuenta. Variante grande: el mismo plantado entre 150+ hunks de docs.
- **Estado**: cubierto por `documented-api-contradiction` (1 hunk) y
  `large-documented-api-contradiction` (162 hunks). Pendiente correr modelos
  reales; son casos dirigidos, no prueba de descubrimiento espontáneo.

## 3. Sobreclasificación de docs como `core-logic`

- **Observado**: Codex clasificó 10 de 21 unidades como `core-logic` en una PR
  que solo toca markdown de skills de agentes, extendiendo la regla del rubric
  del equipo sobre "prompts y configuración de asistentes". Los Claude: todo
  `docs`.
- **Evidencia**: eval-results.md, "PRs reales", PR grande.
- **Eval**: fixture solo-markdown con un rubric de equipo que tiene una regla
  "prompts bajo `prompts/**` son comportamiento" y archivos fuera de ese glob.
  Grader: ninguna unidad fuera del glob es `core-logic`; las de dentro sí.
- **Estado**: falta.

## 4. Granularidad: demasiadas unidades en PRs grandes

- **Observado**: Codex 21 unidades y 360 s contra 8–10 unidades y 94–113 s de
  los Claude, misma PR. El prompt pide "fewest coherent decisions" y "~30 or
  fewer"; 21 cumple la letra, no el espíritu.
- **Evidencia**: eval-results.md, "PRs reales".
- **Eval**: fixture grande con K decisiones reales (archivos agrupados por
  tema). Grader: número de unidades no generadas entre K y 2K; ningún par de
  unidades comparte el mismo directorio y kind sin razón (heurística débil;
  mejor como métrica reportada que como pass/fail).
- **Estado**: parcial. La variante documental grande registra unidades, hunks y
  temas como métricas, sin convertir una heurística de agrupación en pass/fail.

## 5. Idioma ambiguo

- **Observado**: Codex escribió en castellano en dos PRs y en inglés en otra del
  mismo repo; los Claude siempre en inglés. Causa verificada: el prompt pedía
  "the reader's language" y ninguna capa lo definía (rubric del equipo en
  inglés, descripción de la PR en castellano). Arreglado en `main` con una
  regla explícita (`languageRule` en `packages/server/src/rubric.ts`): una capa
  del rubric manda; si no, el idioma del título y la descripción de la PR.
- **Evidencia**: eval-results.md, "PRs reales", punto "Idioma".
- **Eval**: tres fixtures: (a) descripción en castellano sin regla en el rubric
  → castellano; (b) descripción en castellano y overlay que dice "English" →
  inglés; (c) chat con pregunta en inglés sobre una PR en castellano → responde
  en inglés. Grader: detector de idioma simple sobre títulos y summaries (listas
  de stopwords alcanzan).
- **Estado**: falta.

## 6. Diff grande: paginar todo en vez de leer el overview

- **Observado**: Codex, en `large-diff-read`, pide una página por defecto,
  intenta `limit` 500 y 1000 (rechazados: máximo 100) y después 24–25 páginas
  de 100 hunks: 2,3 M tokens y 2 min, en el prototipo y en producción pese al
  addendum. Claude compartido resuelve el mismo caso con 4–5 operaciones
  (overview + `search_code`).
- **Evidencia**: `eval-reports/2026-10-21-mac-codex-shared-12.jsonl` y
  `...-production-rep2-4-36.jsonl`, runs `large-diff-read` / `codex-shared`
  (`operations`); eval-results.md, segunda y tercera tanda.
- **Eval**: ya existe el caso; falta el grader de eficiencia: pass solo si
  `operations.length <= 8` o si los tokens de entrada quedan bajo un umbral.
  Reportar también los intentos rechazados (`ok: false` con `limit` inválido).
- **Estado**: parcial.

## 7. Límites de validación descubiertos a los golpes

- **Observado**: en el prototipo Codex envió `evidence` de más de 200
  caracteres (rechazado por el schema, reintento exitoso) y `limit` > 100. Un
  reintento por corrida, siempre resuelto. El addendum de Codex en producción
  recuerda los tamaños; no se volvió a ver el rechazo de evidence.
- **Evidencia**: `eval-reports/2026-10-21-mac-codex-shared-12.jsonl`,
  `operations` con `ok: false`, `code: invalid_operation`.
- **Eval**: métrica, no pass/fail: cantidad de operaciones rechazadas por
  corrida. Grader opcional: cero rechazos en `set_analysis`/`patch_units`.
- **Estado**: parcial (se registra, no se califica).

## 8. Incremental: severidad y "ya no aplica"

- **Observado**: en `incremental-analysis` los graders fallaron 7 de 9 por dos
  motivos: el finding reverificado volvió como `note` en vez de `warning`
  (los tres brazos), y mencionaba el valor viejo (`104`) para decir que ya no
  aplica. Sustancialmente los nueve eran correctos.
- **Evidencia**: `eval-reports/2026-10-21-mac-incremental-3arms-9.jsonl`;
  eval-results.md, segunda tanda, "Tanda 2".
- **Eval**: existe. El grader es discutible: "no mencionar 104" penaliza una
  explicación útil. Decidir si la regla es "no afirma que 104 sigue vigente"
  (más justa, requiere un patrón negativo) y si `note` es aceptable cuando el
  problema quedó resuelto por el código nuevo. Dejar la versión estricta como
  histórico y agregar la justa como segunda métrica.
- **Estado**: cubierto (estricto); falta la variante justa.

## 9. Resume en frío

- **Observado**: `resumed-incremental` 5 de 6 por grader, 6 de 6 sustantivo;
  la identidad de sesión se mantuvo en los seis; sin escrituras en el warmup.
  En esa tanda el runner de producción no auditaba el éxito de cada operación,
  por eso rechazaba ese caso ahí (tenía test nativo aparte).
- **Evidencia**: `eval-reports/2026-10-21-mac-resumed-rep1-2.jsonl`,
  `...-resumed-rep2-3-4.jsonl`.
- **Eval**: el runner de producción ahora observa `ok`/`code`/duración por
  operación y cuenta `toolErrors`; `permissionDenials` sigue desconocido.
  Habilitado el caso con lecturas exitosas obligatorias en el warmup.
- **Estado**: mecanismo cubierto con proveedor determinista; pendiente nueva
  tanda de producción con modelos reales.

## 10. Lo que funcionó sin excepción (canarios de regresión)

- Cero fallos de transporte o permisos en 70 corridas sintéticas y 15 reales.
- Incremental sobre una PR real: los tres brazos patchearon exactamente las 4
  unidades afectadas por un rename de ruta, con changelog por unidad y resumen
  de revisión correcto, sin reemplazar el análisis.
- Chat: pregunta con cita archivo:línea correcta en los tres; draft anclado en
  la misma línea por los tres sin indicarla; Stop a los 4 s interrumpe y deja
  el chat libre.
- **Eval**: vale la pena fijar estos tres como casos de "no regresión" con
  fixtures sintéticos (rename de ruta → 4 unidades tocadas y el resto intacto;
  draft con anchor esperado; Stop → `interrupted: true` y `busy: false`).
- **Estado**: parcial (incremental y draft existen en sintético; Stop falta).

## Costos de referencia (para presupuestar evals)

Por repetición completa de los cuatro casos sintéticos, código de producción:
Claude actual 0,146 USD / 50 s; Claude compartido 0,065 USD / 41 s; Codex sin
USD (tokens en eval-results.md, "Costo y uso"), 165 s dominados por el diff
grande. Una PR real mediana cuesta del orden de un análisis sintético grande.
