# Spike: Claude y Codex como harnesses pares

Fecha: 2026-10-21. Estado: experimento local; no integra ni modifica el runtime de Purview.

**Siguiente bloque implementado:** [evaluación funcional con servicios reales](eval.md).
Compara Claude actual, Claude con superficie MCP compartida y Codex con esa misma
superficie sobre cuatro casos fijos. Tiene tests locales sin inferencia remota;
las comparaciones con modelos reales quedan para la Mac. No reemplaza el harness
del producto ni demuestra paridad general de calidad.

## Conclusión

**Viable el contrato de operaciones compartidas por MCP; integración condicionada por el aislamiento de Codex.** Los dos harnesses reales ejecutan las mismas operaciones tipadas y devuelven los mismos rechazos del servidor. No hace falta traducir reglas `Bash(...)` de Claude a reglas de Codex.

El spike no demuestra todavía un adapter listo para producción. En particular, no demuestra que reutilizar el login y la configuración existentes de Codex conserve el aislamiento requerido. Tampoco evalúa calidad de modelos: las respuestas del modelo son deterministas y locales.

## Reproducir

Node >=20.11. Ejecutado en Linux x64, en un orb con Node 26.10.0 y las capacidades de sandbox que necesita Codex, y en macOS 27.0 arm64 (Apple Silicon) con Node 26.3.0 de Homebrew. El runner también resuelve el binario de macOS x64 y Linux arm64, pero esas plataformas están pendientes de ejecución. Windows no está implementado. No requiere una API key, login ni el servidor de Purview.

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

Cada escenario crea HOME y directorios de configuración temporales y una whitelist de variables de entorno. No toma credenciales reales ni usa `~/.purview` o el puerto 4779. Los procesos se cierran antes de borrar sus directorios: la limpieza espera a que no quede ningún hijo del proceso de test (un Claude Code abortado todavía escribe su log de cierre de MCP bajo el HOME temporal un instante después de `abort()`), y falla si alguno persiste.

La fixture impide transportes Git mediante `protocol.allow=never`, sin cargar configuración Git personal/sistema, y dirige HTTP(S) a un proxy local que rechaza CONNECT sin reenviarlo. Git bloqueado por sí solo no contiene la preparación de plugins: Codex tiene fallbacks HTTPS. El proxy permite observar esos intentos; **no es una garantía de permisos del producto ni un sandbox de red para todo app-server**. La configuración normal desactiva `features.plugins` y `features.remote_plugin`. Cada app-server pertenece a un grupo de procesos del test que se termina al cerrar, incluidos hijos de preparación del control positivo. No se deja un daemon corriendo.

La autorización de la fixture vuelve a leer en cada mutación el grant activo, el tipo de tarea, la revisión, la pertenencia del comentario a la PR y su estado draft. La PR no la elige el modelo. Esta fixture serial no implementa transacciones, control de concurrencia ni un sistema de grants utilizable en producción.

## Evidencia ejecutada

Última ejecución en Linux x64: **44 tests, 44 pass, 0 fail**. En macOS 27.0 arm64 con Node 26.3.0 (Homebrew): **44 tests, 44 pass, 0 fail**, en dos corridas consecutivas tras corregir una carrera del propio test (abajo), sin procesos ni directorios temporales remanentes. La primera corrida en macOS dio 42/44: el control positivo de preparación de plugins alcanza dos hosts por el proxy (`chatgpt.com:443` y, unos 20 ms después, `github.com:443`); el subtest dejaba de esperar al primero y el segundo, ya en la cola de accept del proxy cuando se mata el grupo de procesos, llegaba después de que el subtest gated tomara su línea base y se le atribuía. El control ahora espera a que su egreso quede quieto 750 ms antes de ceder el turno, y el subtest gated, que también espera la quietud, sigue exigiendo exactamente cero intentos y nombra los hosts si los hubiera. El conteo incluye subtests y pruebas que caracterizan limitaciones: no equivale a 44 garantías de seguridad satisfechas.

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

El perfil agrega el runtime de Codex, el runtime de Node y las rutas mínimas del sistema a las raíces de lectura: no promete un filesystem que contenga exclusivamente el checkout. Falta verificar las mismas restricciones en macOS x64, Linux arm64 y con inferencia remota.

En macOS el "runtime de Node" no es solo el ejecutable. El Node de Homebrew está enlazado dinámicamente: dyld abre `libnode` y una veintena de bibliotecas repartidas en `/opt/homebrew/Cellar/*/lib`, alcanzadas por los symlinks de `/opt/homebrew/opt/<pkg>`, y libcrypto lee `openssl.cnf` de su OPENSSLDIR al arrancar. Con solo el ejecutable en las raíces, Node muere con `dyld: Library not loaded` (exit 134) antes de ejecutar JavaScript, y con las bibliotecas pero sin `openssl.cnf` sale con 1. `nodeRuntimeReadRoots()` en `runtime.mjs` calcula la clausura con `otool -L` (resolviendo `@rpath`, `@loader_path` y `@executable_path`) y concede lectura a cada directorio de biblioteca en su forma literal y real, al directorio padre de cada symlink del camino (el sandbox canonicaliza las raíces, así que conceder el symlink concede su destino y no el enlace, y el enlace solo se sigue donde su padre es legible) y al OPENSSLDIR. En Linux sigue siendo el ejecutable solo. Las aserciones del test no cambiaron: sigue exigiendo que la red esté bloqueada y la escritura denegada bajo el perfil restringido.

### Codex: los overrides no reemplazan la configuración heredada

Se plantó un servidor MCP `ambient` en el `config.toml` de un CODEX_HOME temporal y se inició app-server con `mcp_servers.purview` en overrides. `mcpServerStatus/list` confirmó que **el servidor ambient también arrancó y conectó**, con sus herramientas registradas. No se afirma que todas hayan sido publicadas al modelo: la conexión sola ya viola el requisito de no iniciar servidores heredados.

Una nueva prueba planta dos MCP que escriben archivos al iniciar: uno personal y otro en `.codex/config.toml` de un checkout confiable. El control positivo arranca ambos. Con CODEX_HOME privado y cwd neutral tanto en el proceso como en el thread, ninguno escribe su marcador y solo `purview` aparece conectado. `config/read` con el mismo cwd e `includeLayers` confirma inventario y procedencia, sin el layer del checkout.

El runtime del spike aplica desde el arranque `features.hooks=false`, `notify=[]`, `features.plugins=false`, `features.remote_plugin=false`, `plugins._default.enabled=false` y `orchestrator.mcp.enabled=false`; se comprueban sus valores efectivos y que el MCP propio sigue funcionando. Según el código fuente, `notify` es independiente de hooks y un plugin explícitamente habilitado prevalece sobre `_default=false`. Estas comprobaciones no son una auditoría de todas las variantes de hooks/plugins.

**La segunda fase resuelve la preparación de plugins para esta versión, no el aislamiento completo del proceso.** La primera observó preparación bajo `CODEX_HOME/.tmp/plugins-clone-*` aun con activación deshabilitada. El control positivo nuevo reproduce el arranque de preparación con `features.plugins=true` y `_default.enabled=false`: aparece el lock de sincronización. Con `features.plugins=false`, no aparecen el lock, los directorios de preparación ni intentos HTTPS observados por el proxy durante startup, login con API key ficticia y un turno real del harness. La fuente confirma que el feature gate precede tanto al sync local como al refresh remoto. No confundir este resultado con una prueba de ausencia de cualquier tráfico o efecto del proceso, ni con login ChatGPT real.

La CLI stock no expone los `LoaderOverrides` internos para ignorar todos los layers personales, de proyecto y de sistema, ni `PluginStartupTasks::Skip`. HOME privado y cwd neutral tampoco suprimen configuración/requirements de `/etc/codex`, preferencias administradas de macOS o política enterprise. `config/read` observa estado después de iniciar: no es una barrera previa a todo efecto de startup.

Para producción se necesita aceptar/verificar expresamente esas fuentes del host, aislar externamente el proceso o evaluar un host Rust pequeño que use los controles de embedding existentes. No se implementó un host Rust ni un fork. El hallazgo de plugins ya no justifica por sí solo un host Rust.

### Codex: autenticación separada de configuración

Se ejecutaron `account/login/start` con una **API key ficticia**, `account/read`, reinicio y `account/logout` contra el binario real. El proveedor local exige auth y comprueba el header Bearer exacto. El almacén privado en modo `file` crea `auth.json` con permisos 0600, se carga en un proceso nuevo y se elimina al hacer logout. Una configuración y credencial señuelo en el HOME original no se seleccionan ni modifican. Una política `forced_login_method=chatgpt` rechaza el login de API key. No se enviaron credenciales reales ni se comprobó su aceptación por OpenAI.

**Decisión del spike: login ChatGPT nuevo e independiente**, mediante el RPC público, en vez de importar el login de la CLI. `chatgptAuthTokens`, la alternativa para inyectar un access token externo, está marcada en la fuente como `UNSTABLE, FOR OPENAI INTERNAL USE ONLY - DO NOT USE`. No se construye un broker sobre ella. Copiar refresh tokens tampoco es un contrato de integración y puede acoplar la rotación entre stores. El costo visible del camino elegido es pedir un login adicional; no se presenta como reutilización transparente del login actual.

`auth-smoke.mjs` prepara ese login y un smoke remoto usando el mismo binario y MCP. Su HOME y CODEX_HOME persistentes viven solo en `~/.purview-harness-spike-auth/{home,codex}`, con directorio padre 0700 y store de archivo 0600; el cwd de proceso/thread es temporal, neutral y fuera del HOME real. No importa API keys del entorno ni copia `~/.codex`; conserva proxy/certificados para el transporte. Comprueba configuración efectiva antes de pedir login o arrancar el turno, pero después del startup, no como interlock previo.

El smoke exige observar por MCP lectura, edición válida y tres rechazos reales (otra PR, publicado, revisión vieja), además del estado final completo. Si el modelo evita las llamadas inválidas, **falla como evidencia incompleta**, no cuenta su negativa verbal como autorización probada. El validador pasa contra transporte determinista y una prueba negativa demuestra que omitir rechazos no lo hace pasar. El CLI sin login también se ejecutó con HOME descartable y proxy cerrado: superó el preflight y falló en `stage=account`, con exit 1 y sin imprimir datos de cuenta. **Ejecutado en la Mac (macOS 27.0 arm64, Node 26.3.0)**: `auth:login` completó el OAuth de ChatGPT en el navegador de la persona, con el almacén privado en `~/.purview-harness-spike-auth` (directorio 0700, `auth.json` 0600; el store normal de la CLI no se seleccionó). `auth:smoke` contra `gpt-6.1-sol` real terminó con exit 0 y estos checks:

```json
{"platform":"darwin","arch":"arm64","node":"v26.3.0","checks":{"read":true,"draftUpdated":true,"foreignDenied":true,"publishedDenied":true,"staleDenied":true}}
```

Es decir, con inferencia remota auténtica el modelo leyó el review por MCP, editó el draft válido y las tres llamadas inválidas (otra PR, publicado, revisión vieja) fueron rechazadas por el servidor con el estado intacto. No se registró URL OAuth, token ni contenido de `auth.json`.

## Decisión de diseño después del spike

Mantener la división propuesta:

1. **Purview autoriza operaciones de dominio.** Tools tipadas, contexto de PR/run no elegible por el modelo, revisión y estado actual validados al ejecutar. Annotations MCP y aprobación del harness no son la autoridad.
2. **Cada adapter controla las rutas alternativas.** Claude puede empezar tool-only. Codex requiere aislamiento de configuración y políticas efectivas, contemplando herramientas anidadas. No traducir su sandbox a una imitación de `Bash(...)`.
3. **Lectura de código como decisión explícita.** Si se ofrecen herramientas nativas de lectura/ejecución, comprobar raíces, symlinks, red y escritura. El [bloque de eval](eval.md) ahora implementa lectura/búsqueda acotada por MCP para probar el primer camino común; todavía no está integrada al producto.
4. **Fallos de compatibilidad cierran el acceso.** Una versión/modelo/configuración que no permita garantizar las restricciones debe marcarse incompatible, sin degradar silenciosamente a permisos amplios.

No recomendaría implementar todo el adapter de Codex antes de resolver estos puntos de salida:

- Configuración de Codex controlada, sin iniciar MCP/hooks/plugins ajenos, y decisión de autenticación independiente de esa herencia.
- Confirmación del perfil ya probado en Linux en las demás plataformas soportadas; no degradar a read-only amplio si un perfil falla.
- Pruebas autenticadas con modelos reales y las plataformas que Purview vaya a soportar. Este orb no tiene credenciales disponibles.
- Revalidación de autorización al reanudar, y semántica de cancelación durante una operación en curso, con los servicios reales y sus transacciones.

Una API key no elimina la necesidad de harness. Este spike usa los loops de Claude y Codex, reemplazando solo su transporte de modelo. Un tercer backend directo a una API puede reutilizar las mismas operaciones y autorización, pero debe implementar o incorporar loop, tools, sesiones, streaming y cancelación. No fue construido aquí.

## Próximo paso en la máquina del usuario

La primera matriz ya pasó en macOS arm64 (ver arriba). El siguiente paso es repetir los 44 tests y ejecutar el login independiente y el smoke remoto. La branch `spike/agent-harness-compat` contiene solo este experimento. Desde un clon existente, para no cambiar su branch ni sus ediciones, crear un worktree en una ruta libre:

```sh
git fetch origin spike/agent-harness-compat
git worktree add --detach ../purview-harness-spike origin/spike/agent-harness-compat
npm ci --prefix ../purview-harness-spike/scripts/agent-harness-spike --no-audit --no-fund
npm test --prefix ../purview-harness-spike/scripts/agent-harness-spike
npm run auth:login --prefix ../purview-harness-spike/scripts/agent-harness-spike
npm run auth:smoke --prefix ../purview-harness-spike/scripts/agent-harness-spike
```

Si el worktree de la primera fase ya existe, no reutilizar estos comandos de creación sobre él: usar otra ruta libre o actualizarlo solo si está limpio. Prerequisito: Node >=20.11 instalado. La instalación descarga las dependencias y sus binarios fijados; los tests usan el proveedor local y no piden login.

`auth:login` imprime una URL OAuth: **la persona la abre localmente en su navegador y completa la autenticación**; no pegar la URL, códigos ni credenciales en el chat o en el reporte del agente. Espera hasta cinco minutos. `auth:smoke` usa ese login y hace solicitudes reales al modelo fijado `gpt-6.1-sol`, que debe estar disponible en la cuenta; puede consumir cuota. El review es ficticio y descartable, no se lee ni edita una PR real. La prueba mantiene el login privado para reejecutar, pero borra el estado temporal del review al salir. No se afirma logout remoto ni revocación de tokens al borrar archivos.

Devolver plataforma/arquitectura, versión de Node, resumen de tests y el JSON de checks del smoke. Si falla, informar solo `stage=...`; el runner no imprime errores crudos de RPC/backend, logs ni datos de cuenta. No enviar tokens, `auth.json`, URL OAuth ni configuración privada. En un host administrado, las fuentes globales mencionadas arriba siguen siendo un límite: no ejecutar asumiendo aislamiento completo ni deshabilitar políticas para lograr que pase. El orb Linux no ejecutó OAuth ni solicitudes de modelo autenticadas; la Mac sí (ver "Evidencia ejecutada").

## Referencias y límites de versión

El código ejecutable y su lockfile son la evidencia reproducible. Para contrastar el contrato, usar las fuentes de la misma versión, no asumir que documentación rolling describe exactamente el binario instalado:

- [Claude Agent SDK: overview](https://platform.claude.com/docs/en/agent-sdk/overview), [permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) y [MCP](https://platform.claude.com/docs/en/agent-sdk/mcp).
- [Codex app-server](https://developers.openai.com/codex/app-server/) y [config reference](https://developers.openai.com/codex/config-reference/).
- [Fuente de Codex fijada a rust-v0.163.0](https://github.com/openai/codex/tree/rust-v0.163.0/codex-rs): metadata de modelos en `models-manager/models.json`, serialización Responses Lite en `core/src/client.rs`, selección de tools en `core/src/tools/mod.rs` y contrato de permisos en `app-server-protocol`.
- Controles internos de carga: [`LoaderOverrides`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/state.rs#L41-L62); opciones de runtime: [`PluginStartupTasks`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/lib.rs#L468-L506). No son flags de aislamiento de la CLI stock.
- Selector experimental: [`turn/start.permissions`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L230-L245); hooks y notify independientes: [`registry.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/registry.rs#L118-L142).
- Gate de plugins: [`Feature::Plugins`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/features/src/lib.rs#L1620-L1625) y [`PluginManager`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core-plugins/src/manager.rs#L752-L770), que comprueba `plugins_enabled` antes de preparar el marketplace; el refresh remoto también retorna si está deshabilitado.
- Contrato de login: [`LoginAccountParams`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L64-L104), incluida la advertencia explícita sobre `chatgptAuthTokens`. Fuente consultada: commit del tag `83086188ae0614bd882818ff1aa23f3194962012`.
- `codex app-server generate-json-schema` del binario fijado: el test inspecciona el schema generado para `CommandExecParams`.
- Contrato actual de Purview: `packages/server/src/agent/types.ts` y `packages/server/src/agent/claude-code/permissions.ts`. No se modificaron en este spike.
