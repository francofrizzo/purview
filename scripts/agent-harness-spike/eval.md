# Evaluación funcional de la superficie compartida

El runtime original (`--runtime spike`, default) es **opt-in y experimental**: no registra un adapter de Codex en el
producto ni cambia el Claude que usa Purview hoy. Usa repos Git y stores Purview
reales pero sintéticos y descartables. No lee sesiones personales, no usa
`~/.purview`, no publica nada y no escucha en 4779.

**Material para evals:** [findings-for-evals.md](findings-for-evals.md) lista
cada conducta observada con su evidencia, el caso de eval que la capturaría y
su estado. El protocolo de PRs reales está en [realpr/](realpr/README.md).

**Integración posterior:** `--runtime production` usa los nuevos adapters y
prompts del producto con los mismos casos y graders, sin reescribir los informes
del spike. Ver [setup y siguiente handoff Mac](integration.md); el producto sólo
ofrece los adapters nuevos con `PURVIEW_EXPERIMENTAL_HARNESSES=1`.

## Qué se compara

| Brazo | Harness y permisos | Operaciones |
| --- | --- | --- |
| `claude-baseline` | Adapter, prompts y políticas actuales de Purview; binario fijado 2.1.305 | Tools nativas actuales, Bash y `reviewer-state` real |
| `claude-shared` | Mismo binario/modelo/effort solicitado, sin tools nativas | MCP compartido |
| `codex-shared` | app-server 0.163.0, perfil restringido y configuración controlada del spike | El mismo MCP compartido |

Cada caso/brazo/repetición tiene un checkout, sesión y store nuevos; solo el caso
optativo de resume reutiliza su propia sesión entre sus dos turnos. El orden se
invierte entre casos/repeticiones; nada corre en paralelo. El baseline arranca
una instancia HTTP efímera de los servicios reales para los comandos de comments,
en un puerto libre de loopback. Las escrituras de análisis usan core; las de
comments pasan por las rutas reales de validación, historial y papelera.

La comparación principal es **Claude actual vs. Claude compartido**, fijando el
mismo modelo y effort. Compara dos configuraciones completas, no aísla causalmente
el efecto de las tools: cambian prompts, cwd y contexto interno del harness.
Codex sirve para verificar viabilidad de la misma superficie con otro harness y
modelo, no para atribuir sus diferencias de calidad/costo únicamente al adapter.

### Casos fijos

- `code-investigation`: resolver un helper sin cambios, fuera del diff. El grader
  comprueba nombre y dos importes asimétricos, no una afirmación de éxito.
- `draft-comment`: guardar exactamente un draft, con cuerpo, audiencia y anchor
  pedidos. El grader lee el comentario persistido, no lo que dice el modelo.
- `initial-analysis`: persistir cobertura completa **y** un finding concreto con
  importes y evidencia en dos archivos. Cobertura sin finding no aprueba.
- `large-diff-read`: diff de más de 100 KB; un dato al final requiere consultar
  código sin cambios. El resultado correcto no prueba que se leyó todo el diff.

El finding grader busca tokens semánticos limitados: puede rechazar una paráfrasis
correcta y no detecta todas las interpretaciones incorrectas. Revisar también
`observed.units`, findings, comments y respuestas del reporte. No confundir estos
casos dirigidos con descubrir bugs espontáneamente en PRs reales.

Los cuatro casos anteriores siguen siendo el default: **24 corridas** para la
pareja Claude. Los casos nuevos no se agregan automáticamente a una tanda.

### Casos optativos: hallazgos materiales en documentación

- `documented-api-contradiction`: un quickstart prescribe una función inexistente
  y una firma incompatible con la implementación sin cambios. Exige un finding
  persistido en la unidad del hunk afectado, con evidencia en ambos archivos.
  Mencionarlo sólo en el resumen no aprueba.
- `large-documented-api-contradiction`: la misma contradicción entre 162 hunks
  documentales de tres temas coherentes. La cantidad de unidades se registra como
  métrica, sin umbral de aprobación: agrupar más no demuestra mejor revisión.

Los casos piden explícitamente verificar documentación: miden ese contrato dirigido,
no descubrimiento espontáneo. El grader conserva límites de vocabulario; adjudicar
paráfrasis correctas por separado, sin reescribir el resultado estricto.

### Versiones del grader y relectura sin cuota

El default sigue siendo `--grader-version 1`, la regla histórica. Para tandas
nuevas, `--grader-version 2` cambia **solo** la cláusula de contradicción documental:
reconoce formas como "does not export it", "has no such export" y "exports only…";
no exige los nombres de parámetros cuando el problema probado es la función
inexistente. Sigue exigiendo warning, ambos símbolos, evidencia en ambos archivos
y finding en la unidad del hunk afectado. Mencionar los símbolos, afirmar que la
API correcta no existe o poner el hallazgo sólo en el resumen no aprueba.
Es un reconocedor acotado en inglés, no entailment general ni un juez de calidad:
puede equivocarse con paráfrasis, negaciones complejas u otros idiomas.
La versión queda en las opciones del manifest y en cada grading.

No hace falta repetir las seis corridas documentales para aplicar esa regla:

```sh
node scripts/agent-harness-spike/regrade.mjs \
  scripts/agent-harness-spike/eval-reports/2026-10-21-mac-production-docs-6.jsonl \
  /tmp/purview-docs-regrade-nuevo.jsonl
```

Sólo admite esos casos sintéticos con el mismo hash de prompt. Reconstruye las
unidades en un store descartable y reevalúa la cláusula finding; conserva los
checks originales de transporte, revisión, comentarios y cobertura. El reporte
secundario registra hashes del original y del código del grader, no incluye
contenido y nunca sobrescribe archivos. Esto **no es una nueva tanda de modelos**
ni modifica los 0/6 históricos. La relectura v2 dio 6/6 (ver eval-results.md).

Handoff opcional, con autorización de gasto en la Mac (6 corridas, no automático):

```sh
node scripts/agent-harness-spike/eval.mjs --runtime production --grader-version 2 --run \
  --cases documented-api-contradiction,large-documented-api-contradiction \
  --arms claude-baseline,claude-shared,codex-shared --repeats 1 \
  --claude-model claude-sonnet-5-5 --effort medium --timeout-ms 600000 \
  --out /tmp/purview-eval-documentation-nuevo.jsonl
```

### Casos optativos: incremental y resume

- `incremental-analysis`: parte de un análisis r1 persistido y ejecuta la
  migración real de core a r2, sin GitHub. Hay un hunk idéntico, uno modificado,
  uno nuevo y uno retirado. Debe conservar la unidad estable y su finding,
  corregir el importe del finding modificado (55→69, no el viejo 55→104),
  clasificar la nueva comisión de 11, anotar la unidad retirada y guardar un
  resumen de revisión. Cobertura completa sola no alcanza; reemplazar el análisis
  entero tampoco aprueba. Los tres brazos pueden correrlo con sesión nueva.
- `resumed-incremental`: primero lee contexto, unidades y diff de r1 sin escribir.
  Se cierra el proceso, se migra a r2 y se abre un proceso nuevo que reanuda la
  misma sesión con un grant MCP nuevo, ligado a r2. Debe resolver el mismo trabajo
  incremental sin arrastrar los importes viejos. El grader valida el estado final
  y el runner comprueba identidad de sesión y ausencia de escrituras en el primer
  turno. Eso no demuestra que el modelo use bien cualquier contexto histórico.

Resume se ofrece **solo en los brazos compartidos**. El baseline de producción
usa instrucciones distintas para análisis inicial e incremental; Claude ignora
instrucciones nuevas al reanudar y su adapter rechaza ese cambio. No se fuerza una
equivalencia que quite esa protección. El incremental con sesión nueva sí permite
comparar baseline y superficie compartida.

Pruebas locales con ambos binarios y proveedor determinista verifican el protocolo
de cold resume, patches reales y rechazo de instrucciones incompatibles. Pruebas
MCP verifican grants viejos, reconexión con revisión vieja y revocación: una corrida
posterior no recrea el archivo de autorización anterior. Esto **no es evidencia
de calidad con modelos reales**; eso queda para la Mac.

**No evaluado:** calidad general de review, consentimiento para editar drafts
humanos, concurrencia de producción ni todos los ataques de prompt injection.

## Superficie compartida y límites

Lecturas: `review_context`, `review_diff`, `review_units`, `review_changes`,
`list_paths`, `read_code`, `search_code`, `read_base_file`, `file_history`,
`revision_diff`, `list_comments`. Incluye código fuera del diff, head/base,
historia local, globs y múltiples patrones **literales**, no regex. Los resultados
paginables llevan `nextCursor`; se rechazan cursores de contenido/consulta vieja.
Los archivos de más de 2 MiB y binarios se rechazan; las líneas de código se
recortan a 2.000 caracteres con una marca `truncated`. No hay shell general ni
ejecución de tests en la nueva superficie.

Análisis: `set_analysis`, `patch_units`, `set_revision_summary`. Chat:
`create_draft`, `edit_draft`, `delete_draft`. No se ofrecen herramientas de análisis
al chat ni de comments al análisis. PR, revisión, actor y store vienen del runner,
no de argumentos del modelo. Se valida revisión vigente y revocación al ejecutar;
la cola es local al proceso MCP. Una operación ya admitida puede terminar al
cancelar: no hay rollback ni claim de transacción entre procesos.

Los drafts humanos y publicados se rechazan. Las lecturas impiden `..`, rutas
absolutas, `.git` y symlinks que salgan del checkout; esto no es una defensa
TOCTOU frente a procesos externos que muten concurrentemente el filesystem.
El límite de página es sobre los items; campos auxiliares como remaining/summary
no tienen un presupuesto global de respuesta. No extrapolar a repos arbitrarios.

Dos detalles de compatibilidad observados con binarios reales:

- Claude `--safe-mode` desactiva incluso MCP explícito. Solo el brazo compartido
  lo sustituye por `--restricted`, setting sources vacías, hooks/memoria
  desactivados, slash commands desactivados y MCP estricto. `--tools ''` elimina
  las tools nativas y `dontAsk` no concede aprobaciones extra. No se usa `--bare`,
  porque cambia autenticación a API key. Las políticas administradas siguen
  aplicándose; no se promete aislamiento de todo contexto/instrucción personal.
- Codex omitía `set_analysis` cuando las parejas de líneas del schema core se
  publicaban como tuplas draft-7. El servidor publica la forma equivalente de
  array homogéneo de longitud dos; **la ejecución sigue validando el schema core
  original**. No se mantiene otra copia del payload de análisis. Codex puede
  ofrecer Code Mode y helpers internos aunque shell esté desactivado: el perfil
  de filesystem/red sigue siendo necesario, como demostró el spike anterior.

El proceso MCP es código confiable del runner, fuera del sandbox del modelo;
necesita leer core/server y escribir el store sintético. No se le pasa un command
ni argumentos elegibles por el modelo para arrancarlo.

## Ejecutar en la Mac

En un worktree limpio de `spike/agent-harness-compat`, actualizado sin descartar
ediciones locales. Desde la raíz del repo, Node >=20.11 y pnpm disponibles:

```sh
pnpm install --frozen-lockfile
pnpm --filter @reviewer/core build
pnpm --filter @reviewer/server build
npm ci --prefix scripts/agent-harness-spike --no-audit --no-fund
npm test --prefix scripts/agent-harness-spike
npm run test:eval --prefix scripts/agent-harness-spike
node scripts/agent-harness-spike/eval.mjs --list
```

Los tests usan respuestas deterministas locales, **no hacen inferencia remota**.
`--list` y la invocación sin `--run` no arrancan ningún harness. Para inferencia
real hacen falta `--run` y un `--out` nuevo: se consume cuota. No sobreescribe
reportes anteriores. La carpeta de salida debe existir.

Primero una pareja corta para descubrir incompatibilidades nativas/auth:

```sh
node scripts/agent-harness-spike/eval.mjs --run \
  --cases code-investigation --repeats 1 \
  --claude-model claude-sonnet-5-5 --effort medium \
  --out /tmp/purview-eval-claude-smoke.jsonl
```

Si esa pareja funciona, la tanda fija de cuatro casos y tres repeticiones son
**24 corridas**, hasta tres minutos por corrida por defecto:

```sh
node scripts/agent-harness-spike/eval.mjs --run \
  --claude-model claude-sonnet-5-5 --effort medium \
  --out /tmp/purview-eval-claude-paired.jsonl
```

Claude usa el login normal de la CLI, no pide un login separado. En macOS la
CLI lee ese login del Keychain con la cuenta `$USER`: el runner pasa `USER` y
`LOGNAME` al hijo; sin ellas el hijo responde "Not logged in" sin tocar la API
(hallazgo de la Mac, ver `eval-results.md`). `PURVIEW_EVAL_DEBUG_LOG=<archivo>`
vuelca stderr del hijo y sus eventos `system`/`result` en ese archivo, aparte
del reporte, para diagnosticar un fallo de arranque; contiene IDs de sesión y
no se publica. También respeta
las variables de autenticación Anthropic explícitas si existen: no afirmar que
una corrida usó Max si la máquina tenía una API key seleccionada. No copiar ni
imprimir tokens y no cambiar la autenticación para hacer pasar una prueba.
Se crean sesiones de eval nuevas; la CLI puede conservar sus transcripts en su
almacén habitual. Solo el store/checkout sintético se borra al terminar.

Codex es opcional en la primera comparación. Usa **el login privado ya probado**
en `~/.purview-harness-spike-auth/{home,codex}`. No copia `~/.codex` ni inicia OAuth
automáticamente. Si falta, usar el handoff existente de `auth:login` con aprobación
humana; no improvisar credenciales. Para sus 12 corridas:

```sh
node scripts/agent-harness-spike/eval.mjs --run --arms codex-shared \
  --codex-model gpt-6.1-sol --effort medium \
  --out /tmp/purview-eval-codex-shared.jsonl
```

También se pueden seleccionar los tres brazos con `--arms
claude-baseline,claude-shared,codex-shared` (36 corridas). `--cases` acepta la lista
separada por comas; `--repeats` admite 1..20; `--timeout-ms` 1.000..1.800.000.
SIGINT/SIGTERM detienen el plan y cierran los procesos; terminar una llamada de
startup/RPC de Codex puede demorar hasta su timeout de 20 segundos. SIGKILL/crash
no garantiza cleanup. No cancelar Purview ni procesos ajenos.

### Segunda tanda optativa

Esperar a que termine cualquier tanda en curso antes de actualizar el worktree.
No hace falta repetir los cuatro casos originales para ejecutar estos dos.
Primero el incremental con sesión nueva: dos brazos Claude × tres repeticiones
= **6 corridas**; agregar `codex-shared` explícitamente si se quiere comparar los
tres (9 corridas).

```sh
node scripts/agent-harness-spike/eval.mjs --run \
  --cases incremental-analysis --repeats 3 \
  --claude-model claude-sonnet-5-5 --effort medium \
  --out /tmp/purview-eval-incremental.jsonl
```

Después, resume compartido. Una repetición de cada harness son **2 casos, 4 turnos
de harness** (cada turno puede hacer múltiples solicitudes al modelo):

```sh
node scripts/agent-harness-spike/eval.mjs --run \
  --cases resumed-incremental --arms claude-shared,codex-shared --repeats 1 \
  --claude-model claude-sonnet-5-5 --codex-model gpt-6.1-sol --effort medium \
  --out /tmp/purview-eval-resumed.jsonl
```

Si todavía no se quiere usar Codex, seleccionar solo `--arms claude-shared`.
El timeout se aplica a cada turno; resume puede consumir dos cuotas de tiempo.
No hay login nuevo ni cambios a la autenticación existente.

## Reportar y decidir

JSONL en modo 0600: manifest (commit, dirty, plataforma, pins declarados,
opciones), cada corrida (modelo solicitado/resuelto si se reporta, tiempo,
usage/costo si existe, tool names, auditoría MCP, checks, respuesta y resultado
persistido sintético) y summary. El hash identifica el prompt de usuario del
caso, **no** el prompt completo interno del proveedor. No se guardan stderr,
protocolo crudo, datos de cuenta ni errores crudos de backend. Un fallo de setup,
transporte o timeout cuenta como fallo; no se omite. Exit 0 = todas pasan, 1 =
alguna falla, 130 = cancelado. Un fallo de escritura deja un reporte incompleto.

En resume, `wallMs` incluye los dos turnos; `usage` corresponde al turno reanudado
y `warmup.usage` registra el primero por separado. No sumarlos ciegamente: los
harnesses pueden reportar acumulados de sesión. Un warmup que no lee las tres
operaciones pedidas o escribe estado cuenta como fallo y no inicia el segundo
turno; su usage se conserva. `resumedSameSession` verifica la identidad, sin
guardar el ID ni la ruta de sesión en el reporte.

Con `--runtime production`, los brazos compartidos registran el resultado de cada
operación MCP: `name`, `ok`, `code` en fallos y `durationMs`, sin argumentos,
contenido ni rutas. `toolErrors` cuenta los fallos, incluso si después se reparan;
no es por sí solo un fallo del caso. `permissionDenials` sigue siendo `null`:
no observamos todos los permisos nativos. Esto habilita `resumed-incremental`
también en producción, verificando lecturas exitosas del warmup. Las pruebas con
proveedor determinista validan el mecanismo, no la calidad del modelo.

No sumar tokens entre proveedores como si significaran lo mismo. Costos ausentes
son desconocidos, no cero. Comparar primero correctness por caso y repetición,
después latencia/costo en los pares Claude que usaron el mismo modelo resuelto.
Revisar findings y borradores manualmente; no arreglar el grader a posteriori para
hacer verde la tanda. Conservar corridas fallidas, prompts y parámetros.

Antes de commitear un reporte, revisarlo: el modelo y las políticas administradas
pueden introducir texto no previsto; el filtrado no es un detector universal de
secretos. No adjuntar credenciales, config personal, transcripts de la CLI ni
URLs OAuth. Devolver resumen por caso, hallazgos cualitativos y reportes revisados
en esta misma branch. **No habilitar el adapter en producción** por pasar estos
casos: faltan corridas reales de los casos optativos y ejemplos representativos de
reviews reales, con un protocolo acordado y datos compartidos explícitamente.
