# Spike: Claude y Codex como harnesses pares

Fecha: 2026-10-21. Estado: experimento local; no integra ni modifica el runtime de Purview.

## Conclusión

**Viable el contrato de operaciones compartidas por MCP; integración condicionada por el aislamiento de Codex.** Los dos harnesses reales ejecutan las mismas operaciones tipadas y devuelven los mismos rechazos del servidor. No hace falta traducir reglas `Bash(...)` de Claude a reglas de Codex.

El spike no demuestra todavía un adapter listo para producción. En particular, no demuestra que reutilizar el login y la configuración existentes de Codex conserve el aislamiento requerido. Tampoco evalúa calidad de modelos: las respuestas del modelo son deterministas y locales.

## Reproducir

Node >=20.11. Ejecutado en Linux x64, en un orb con Node 26.10.0 y las capacidades de sandbox que necesita Codex. El runner también resuelve el binario de macOS x64/arm64 y Linux arm64, pero esas plataformas están pendientes de ejecución. Windows no está implementado. No requiere una API key, login ni el servidor de Purview.

```sh
npm ci --prefix scripts/agent-harness-spike --no-audit --no-fund
npm test --prefix scripts/agent-harness-spike
```

El paquete está fuera del workspace `packages/*`, con dependencias y lockfile propios. No agrega dependencias al producto. `runtime.mjs` inicia el binario nativo de Codex para que la terminación llegue al proceso real, sin depender del launcher de npm. Canonicaliza el binario y los directorios temporales para contemplar symlinks como `/var` → `/private/var` en macOS.

Versiones fijadas:

| Componente | Versión |
| --- | --- |
| Claude Agent SDK | 0.3.305 |
| Claude Code incluido en ese SDK | 2.1.305, comprobado en el evento de inicio |
| Codex | 0.163.0 |
| MCP SDK | 1.32.1 |

## Qué se ejecuta realmente

- **Claude:** `query()` del SDK, con su proceso real y protocolo nativo.
- **Codex:** `codex app-server --listen stdio://`, cliente JSON-RPC y notificaciones reales.
- **MCP:** el mismo servidor stdio externo para ambos, con `read_review` y `edit_draft`.
- **Transporte de modelo:** servidor HTTP local que emite SSE de Messages o Responses y fuerza llamadas concretas. También observa las herramientas que el harness declara y los resultados que devuelve al modelo. No se llama a un modelo remoto.
- **Estado:** un JSON descartable en un directorio temporal; no son los servicios, eventos ni autorización actuales de Purview. El servidor MCP, fuera del sandbox del agente, es quien escribe ese estado.

Cada escenario crea HOME y directorios de configuración temporales y una whitelist de variables de entorno. No toma credenciales reales ni usa `~/.purview` o el puerto 4779. Los procesos se cierran antes de borrar sus directorios.

La fixture impide transportes Git mediante `protocol.allow=never`, sin cargar configuración Git personal/sistema. Esto contiene la preparación de marketplaces de plugins que Codex puede intentar en background; **no es una garantía de permisos del producto ni un sandbox de red para todo app-server**. Cada app-server pertenece a un grupo de procesos del test que se termina al cerrar, incluidos hijos de preparación de plugins. No se deja un daemon corriendo.

La autorización de la fixture vuelve a leer en cada mutación el grant activo, el tipo de tarea, la revisión, la pertenencia del comentario a la PR y su estado draft. La PR no la elige el modelo. Esta fixture serial no implementa transacciones, control de concurrencia ni un sistema de grants utilizable en producción.

## Evidencia ejecutada

Última ejecución: **34 tests, 34 pass, 0 fail**. El conteo incluye subtests y pruebas que caracterizan limitaciones: no equivale a 34 garantías de seguridad satisfechas.

| Caso | Claude | Codex |
| --- | --- | --- |
| Leer review y editar draft mediante el mismo MCP | Estado actualizado y resultado recibido por el modelo | Igual |
| Editar comentario de otra PR | `outside_review`, estado intacto | Igual |
| Editar comentario publicado | `not_draft`, estado intacto | Igual |
| Usar revisión vieja | `stale_revision`, estado intacto | Igual |
| Quitar permiso de edición cambiando tarea a analysis en una sesión existente | `operation_not_granted`, estado intacto | Igual |
| Revocar un run en una sesión existente | `revoked`, estado intacto | Igual |
| Continuar sesión | Mismo ID en sucesivas invocaciones/procesos del SDK | `thread/resume` en un proceso app-server nuevo y nueva lectura MCP |
| Cancelar esperando respuesta del modelo | Abort termina en menos de 5 s | `turn/interrupt` termina como `interrupted` |
| Ruta alternativa de escritura | Una llamada Bash forzada es rechazada; no crea archivo | `tools.apply_patch` dentro de Code Mode se ejecuta y es rechazado por read-only; no crea archivo |

La cancelación se prueba antes de empezar una operación: **no demuestra rollback ni cancelación atómica de una mutación MCP en curso**. Claude termina con `Error: Claude Code process aborted by user`, no con un error cuyo nombre sea necesariamente `AbortError`.

### Claude: se obtiene un inventario exclusivo

`tools: []`, `settingSources: []`, `strictMcpConfig: true`, `permissionMode: "dontAsk"` y los dos nombres MCP en `allowedTools` producen exactamente esas dos herramientas en todas las solicitudes observadas. Settings personales/proyecto deliberadamente permisivos y un `.mcp.json` del checkout no amplían ese inventario.

Esto demuestra una configuración tool-only para el caso probado, no un sandbox de sistema operativo ni aislamiento total de todos los canales de configuración administrada.

### Codex: inventario visible y herramientas anidadas

Con shell, búsqueda web, imágenes y subagentes deshabilitados, el modelo `gpt-6.1-sol` recibe:

```text
functions.exec
functions.wait
clock.sleep
mcp__purview.edit_draft
mcp__purview.read_review
```

La metadata incluida de ese modelo selecciona Code Mode y Responses Lite. Por eso las declaraciones llegan en `input[type=additional_tools].tools`, y desactivar `features.code_mode.enabled` no elimina por sí solo `functions.exec`. No se alteró la metadata del modelo para obtener un resultado favorable.

Se invocó realmente `functions.exec` con JavaScript raw, no como una función con argumento `{code: ...}`. Su inventario anidado observado contiene `apply_patch`, operaciones de recursos MCP y reloj. Los globals `fetch`, `process` y `require` son `undefined`; no se observaron shell, web search ni spawn de agentes en ese inventario. No es una auditoría exhaustiva del aislamiento V8.

Una llamada real a `await tools.apply_patch(...)` devolvió:

```text
patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings
```

**No se consiguió un inventario literal de solo dos herramientas en Codex.** La condición útil es impedir efectos alternativos, no exigir los mismos nombres o el mismo inventario que Claude. El adapter debe verificarlo para cada combinación soportada de versión y metadata de modelo.

`default_tools_approval_mode = "approve"` para el servidor MCP propio permite sus llamadas junto con `approval_policy = "never"`. Es una decisión del harness para ese servidor confiable; no sustituye la autorización de cada operación en Purview. El cliente del spike rechaza cualquier solicitud de aprobación/grant que no conozca.

### Codex: read-only no significa lectura acotada

Pruebas reales mediante `command/exec`, independientemente de que shell esté oculto al modelo:

- `readOnly` impide escribir un archivo; el mismo comando con `workspaceWrite` sí lo crea con el contenido esperado.
- Con red habilitada, un comando alcanza el servidor local; con red deshabilitada, el mismo comando falla.
- `readOnly` permite leer un archivo fuera del checkout, directamente y mediante symlink.
- El campo `readOnly.access` de la forma anterior se **rechaza explícitamente** en 0.163.0. No se ignora silenciosamente ni aplica restricciones de lectura.
- Un perfil nombrado con filesystem mínimo, checkout y helper de Codex legibles permite leer dentro, y deniega lectura fuera y por symlink. Se probó mediante `command/exec.permissionProfile` con opt-in de API experimental.

La segunda fase también prueba **turnos reales del harness** con shell deliberadamente habilitado y llamadas emitidas por la fixture del modelo a `functions.exec` → `tools.exec_command`:

- Proceso y thread arrancan en un directorio neutral, separado del checkout legible.
- `thread/start.permissions = "purview-read"` selecciona el perfil desde el inicio; `turn/start.permissions` permite cambiarlo. Ambos requieren opt-in experimental. No se mezcla con `sandbox`/`sandboxPolicy`.
- El perfil restringido permite leer el sentinel dentro del checkout, deniega el de fuera y el symlink, no permite crear un archivo y bloquea una conexión al servidor local.
- Un perfil de control amplio permite esas mismas lecturas, escritura y conexión. Se comprueban código de salida, stdout exacto y contenido del archivo, no solo texto que podría aparecer en un error.
- `tools.apply_patch` anidado sigue rechazado bajo el perfil nombrado.
- Después de cerrar app-server, iniciar otro y hacer `thread/resume`, se conserva el cwd neutral y el perfil restringido; se repiten lectura permitida y lectura fuera denegada sin reenviar el selector.

En Linux el sandbox puede ocultar una ruta denegada como `No such file or directory`, no necesariamente `Permission denied`. El sentinel existe fuera del sandbox y el control amplio lo lee: la prueba no depende de la redacción del error.

El perfil agrega el runtime de Codex, el ejecutable de Node y las rutas mínimas del sistema a las raíces de lectura: no promete un filesystem que contenga exclusivamente el checkout. Falta verificar las mismas restricciones en otras plataformas y con inferencia remota.

### Codex: los overrides no reemplazan la configuración heredada

Se plantó un servidor MCP `ambient` en el `config.toml` de un CODEX_HOME temporal y se inició app-server con `mcp_servers.purview` en overrides. `mcpServerStatus/list` confirmó que **el servidor ambient también arrancó y conectó**, con sus herramientas registradas. No se afirma que todas hayan sido publicadas al modelo: la conexión sola ya viola el requisito de no iniciar servidores heredados.

Una nueva prueba planta dos MCP que escriben archivos al iniciar: uno personal y otro en `.codex/config.toml` de un checkout confiable. El control positivo arranca ambos. Con CODEX_HOME privado y cwd neutral tanto en el proceso como en el thread, ninguno escribe su marcador y solo `purview` aparece conectado. `config/read` con el mismo cwd e `includeLayers` confirma inventario y procedencia, sin el layer del checkout.

El runtime del spike aplica desde el arranque `features.hooks=false`, `notify=[]`, `plugins._default.enabled=false` y `orchestrator.mcp.enabled=false`; se comprueban sus valores efectivos y que el MCP propio sigue funcionando. Según el código fuente, `notify` es independiente de hooks y un plugin explícitamente habilitado prevalece sobre `_default=false`. Estas comprobaciones no son una auditoría de todas las variantes de hooks/plugins.

**Sigue sin estar resuelto el aislamiento completo del proceso.** En una ejecución se observó preparación de un repositorio de plugins bajo `CODEX_HOME/.tmp/plugins-clone-*` aun con activación deshabilitada; la limpieza falló con `ENOTEMPTY` en `.git/objects`. El código de app-server habilita tareas de preparación de plugins por defecto. De ahí los controles Git y de procesos de la fixture. No confundir impedir activación de plugins con impedir toda preparación en background.

La CLI stock no expone los `LoaderOverrides` internos para ignorar todos los layers personales, de proyecto y de sistema, ni `PluginStartupTasks::Skip`. HOME privado y cwd neutral tampoco suprimen configuración/requirements de `/etc/codex`, preferencias administradas de macOS o política enterprise. `config/read` observa estado después de iniciar: no es una barrera previa a todo efecto de startup.

Para producción se necesita aceptar/verificar expresamente esas fuentes del host, aislar externamente el proceso o evaluar un host Rust pequeño que use los controles de embedding existentes. No se implementó un host Rust ni un fork. La reutilización del login existente sigue pendiente y no se resuelve copiando toda la configuración personal.

## Decisión de diseño después del spike

Mantener la división propuesta:

1. **Purview autoriza operaciones de dominio.** Tools tipadas, contexto de PR/run no elegible por el modelo, revisión y estado actual validados al ejecutar. Annotations MCP y aprobación del harness no son la autoridad.
2. **Cada adapter controla las rutas alternativas.** Claude puede empezar tool-only. Codex requiere aislamiento de configuración y políticas efectivas, contemplando herramientas anidadas. No traducir su sandbox a una imitación de `Bash(...)`.
3. **Lectura de código como decisión explícita.** Si se ofrecen herramientas nativas de lectura/ejecución, comprobar raíces, symlinks, red y escritura. Para el primer camino común, es razonable exponer lectura/búsqueda acotada por MCP; sus implementaciones reales todavía no existen en este spike.
4. **Fallos de compatibilidad cierran el acceso.** Una versión/modelo/configuración que no permita garantizar las restricciones debe marcarse incompatible, sin degradar silenciosamente a permisos amplios.

No recomendaría implementar todo el adapter de Codex antes de resolver estos puntos de salida:

- Configuración de Codex controlada, sin iniciar MCP/hooks/plugins ajenos, y decisión de autenticación independiente de esa herencia.
- Confirmación del perfil ya probado en Linux en las demás plataformas soportadas; no degradar a read-only amplio si un perfil falla.
- Pruebas autenticadas con modelos reales y las plataformas que Purview vaya a soportar. Este orb no tiene credenciales disponibles.
- Revalidación de autorización al reanudar, y semántica de cancelación durante una operación en curso, con los servicios reales y sus transacciones.

Una API key no elimina la necesidad de harness. Este spike usa los loops de Claude y Codex, reemplazando solo su transporte de modelo. Un tercer backend directo a una API puede reutilizar las mismas operaciones y autorización, pero debe implementar o incorporar loop, tools, sesiones, streaming y cancelación. No fue construido aquí.

## Próximo paso en la máquina del usuario

El siguiente resultado que este orb no puede producir es la misma matriz en el sistema operativo del usuario. La branch `spike/agent-harness-compat` contiene solo este experimento. Desde un clon existente, para no cambiar su branch ni sus ediciones:

```sh
git fetch origin spike/agent-harness-compat
git worktree add --detach ../purview-harness-spike origin/spike/agent-harness-compat
npm ci --prefix ../purview-harness-spike/scripts/agent-harness-spike --no-audit --no-fund
npm test --prefix ../purview-harness-spike/scripts/agent-harness-spike
```

Prerequisito: Node >=20.11 instalado. La instalación descarga las dependencias y sus binarios fijados; los tests usan el proveedor local y no piden login. Devolver plataforma/arquitectura, versión de Node, resumen y errores de tests; no enviar tokens, `auth.json` ni configuración privada. En un host administrado, las fuentes globales mencionadas arriba siguen siendo un límite del experimento: no ejecutar asumiendo aislamiento completo.

No hay prueba autenticada incluida en este paso. Validar el login real y modelos remotos será un paso separado después de decidir cómo separar autenticación y configuración; no se modifican los stores de login actuales.

## Referencias y límites de versión

El código ejecutable y su lockfile son la evidencia reproducible. Para contrastar el contrato, usar las fuentes de la misma versión, no asumir que documentación rolling describe exactamente el binario instalado:

- [Claude Agent SDK: overview](https://platform.claude.com/docs/en/agent-sdk/overview), [permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) y [MCP](https://platform.claude.com/docs/en/agent-sdk/mcp).
- [Codex app-server](https://developers.openai.com/codex/app-server/) y [config reference](https://developers.openai.com/codex/config-reference/).
- [Fuente de Codex fijada a rust-v0.163.0](https://github.com/openai/codex/tree/rust-v0.163.0/codex-rs): metadata de modelos en `models-manager/models.json`, serialización Responses Lite en `core/src/client.rs`, selección de tools en `core/src/tools/mod.rs` y contrato de permisos en `app-server-protocol`.
- Controles internos de carga: [`LoaderOverrides`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/state.rs#L41-L62); opciones de runtime: [`PluginStartupTasks`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/lib.rs#L468-L506). No son flags de aislamiento de la CLI stock.
- Selector experimental: [`turn/start.permissions`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L230-L245); hooks y notify independientes: [`registry.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/registry.rs#L118-L142).
- `codex app-server generate-json-schema` del binario fijado: el test inspecciona el schema generado para `CommandExecParams`.
- Contrato actual de Purview: `packages/server/src/agent/types.ts` y `packages/server/src/agent/claude-code/permissions.ts`. No se modificaron en este spike.
