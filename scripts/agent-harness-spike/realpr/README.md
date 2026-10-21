# Comparación sobre PRs reales

Comparación manual de `claude-code`, `claude-shared` y `codex`. Las corridas
gastan cuota: estos comandos son para una persona que autoriza ese gasto,
no para CI. Los tests de abajo usan únicamente fixtures y HTTP local.

Desde la raíz del checkout, construir core/server con los comandos habituales.
Usar la autenticación existente y las variables de [integración](../integration.md);
este protocolo no hace login ni administra credenciales.

## Preparar (sin modelos ni servidor)

```sh
R=github.com/owner/repo
OUT=/tmp/realpr-state-nuevo   # NO debe existir; su directorio padre sí
export PURVIEW_STATE_DIR=/ruta/a/copia-privada-del-estado
node scripts/agent-harness-spike/realpr/prepare.mjs "$OUT" "$R" 123 456
```

Sin `PURVIEW_STATE_DIR`, prepare lee `~/.purview` como origen, nunca lo escribe.
No usar ese origen en tests. Rechaza destinos existentes, solapados con origen
o con `~/.purview`, traversal y symlinks dentro de los PRs seleccionados.
No reintentar sobre una salida parcial: elegir otro destino nuevo.
Las copias contienen datos privados, no son un dataset sanitizado ni libres de
secretos. No subirlas. Guardarlas con acceso restringido y eliminarlas manualmente
solo después de verificar la ruta y detener su servidor.

Cada copia fija agentes y `autoAnalyze: false` en **repo.json local**: prevalece
sobre la configuración committed y global. Preserva repoPath, overlays locales,
meta y cachés committed; borra chat, job y scratch en las copias únicamente.
Desactiva checkouts gestionados, update checks y LAN en configuración global.

## Ejecutar un brazo a la vez (autorización humana)

En una terminal, en primer plano; detener con Ctrl-C al terminar el brazo:

```sh
sh scripts/agent-harness-spike/realpr/server.sh "$OUT/claude-shared" 47910
```

En otra terminal, repetir las variables R/OUT y ejecutar:

```sh
node scripts/agent-harness-spike/realpr/drive.mjs 47910 "$R" 123 claude-shared fresh
node scripts/agent-harness-spike/realpr/drive.mjs 47910 "$R" 456 claude-shared refresh
node scripts/agent-harness-spike/realpr/chat.mjs 47910 "$R" 456 claude-shared
```

En un orb, usar en cambio un servicio supervisado (`amp orb service start`) con
ese comando, y detenerlo con `amp orb service stop`; no background con `&`.
Repetir en serie cambiando raíz y argumento de brazo. Nunca usar 4779 ni la raíz
del servidor personal; todos los clientes rechazan 4779 y puertos fuera de
1024–65535. El puerto debe pertenecer al servidor privado correcto: las APIs
no certifican su directorio de estado. No ejecutar clientes contra otro proceso.

Drive verifica configuración efectiva y procedencia repo antes de lanzar;
en refresh la vuelve a verificar. Comprueba job terminado, `metrics.run` (no
campos imaginarios del job), correlación con el job iniciado, revisión, cobertura
y checkout mismatch. Un resultado vacío o hunks sin asignar da salida no cero.
Chat verifica agente/modelo de la API y harness de sesión, respuestas no vacías,
draft GitHub nuevo, Stop confirmado con mensaje interrumpido y un turno posterior.
Si la respuesta termina antes del Stop, falla: no cuenta como prueba de Stop.
El timer se cancela al cerrar el stream y la solicitud Stop se espera antes de
continuar. Timeouts/fallos no garantizan que el proceso remoto se haya detenido.

Solo se imprimen conteos, estados, tiempos, selección verificada y uso numérico.
No títulos, snippets, paths, mensajes de error remotos, sesiones ni cuerpos.
`resolvedModelMatchesRequested` compara el nombre reportado por el proveedor;
un alias puede diferir legítimamente. No se imprime ese valor arbitrario.
Chat expone el modelo seleccionado, no certifica el modelo interno del proveedor:
su API no ofrece esa metadata. La calidad/citas requieren adjudicación humana
privada; un `done` o estos chequeos no demuestran calidad.

## Límites

Los worktrees no se copian ni aíslan. `managedCheckouts: false` no los vuelve
inmutables: otra sesión, git o herramientas del agente pueden modificarlos.
Para comparación controlada proporcionar worktrees dedicados y verificar HEAD
y limpieza entre brazos. No usar worktrees en edición activa. Un refresh con head
nuevo requiere un checkout disponible; no aceptar una corrida con código viejo.
La copia no es snapshot atómico si el origen cambia mientras se prepara.
Los prompts de chat son instrucciones, no una barrera de seguridad contra acciones
de herramientas. Supervisar y no pedir publicar comentarios.

## Verificación sin cuota

```sh
node --test scripts/agent-harness-spike/realpr/*.test.mjs
```
