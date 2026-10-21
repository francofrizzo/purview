# Evaluación funcional de la superficie compartida

Este bloque es **opt-in y experimental**: no registra un adapter de Codex en el
producto ni cambia el Claude que usa Purview hoy. Usa repos Git y stores Purview
reales pero sintéticos y descartables. No lee sesiones personales, no usa
`~/.purview`, no publica nada y no escucha en 4779.

## Qué se compara

| Brazo | Harness y permisos | Operaciones |
| --- | --- | --- |
| `claude-baseline` | Adapter, prompts y políticas actuales de Purview; binario fijado 2.1.305 | Tools nativas actuales, Bash y `reviewer-state` real |
| `claude-shared` | Mismo binario/modelo/effort solicitado, sin tools nativas | MCP compartido |
| `codex-shared` | app-server 0.163.0, perfil restringido y configuración controlada del spike | El mismo MCP compartido |

Cada caso/brazo/repetición tiene un checkout, sesión y store nuevos. El orden se
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

**No evaluado:** refresh incremental/migración, reanudación de sesiones, calidad
general de review, consentimiento para editar drafts humanos, concurrencia de
producción ni todos los ataques de prompt injection. El caso grande reemplaza
deliberadamente al incremental; no se simuló una migración parcial.

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

Claude usa el login normal de la CLI, no pide un login separado. También respeta
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

## Reportar y decidir

JSONL en modo 0600: manifest (commit, dirty, plataforma, pins declarados,
opciones), cada corrida (modelo solicitado/resuelto si se reporta, tiempo,
usage/costo si existe, tool names, auditoría MCP, checks, respuesta y resultado
persistido sintético) y summary. El hash identifica el prompt de usuario del
caso, **no** el prompt completo interno del proveedor. No se guardan stderr,
protocolo crudo, datos de cuenta ni errores crudos de backend. Un fallo de setup,
transporte o timeout cuenta como fallo; no se omite. Exit 0 = todas pasan, 1 =
alguna falla, 130 = cancelado. Un fallo de escritura deja un reporte incompleto.

No sumar tokens entre proveedores como si significaran lo mismo. Costos ausentes
son desconocidos, no cero. Comparar primero correctness por caso y repetición,
después latencia/costo en los pares Claude que usaron el mismo modelo resuelto.
Revisar findings y borradores manualmente; no arreglar el grader a posteriori para
hacer verde la tanda. Conservar corridas fallidas, prompts y parámetros.

Antes de commitear un reporte, revisarlo: el modelo y las políticas administradas
pueden introducir texto no previsto; el filtrado no es un detector universal de
secretos. No adjuntar credenciales, config personal, transcripts de la CLI ni
URLs OAuth. Devolver resumen por caso, hallazgos cualitativos y reportes revisados
en esta misma branch. **No habilitar el adapter en producción** por pasar cuatro
casos: después faltan incremental/resume y ejemplos representativos de reviews
reales, con un protocolo acordado y datos compartidos explícitamente.
