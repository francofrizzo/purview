# Comparación sobre PRs reales

Protocolo usado el 2026-10-21 (resultados sanitizados en
[../eval-results.md](../eval-results.md), sección "PRs reales"). Compara los
tres harnesses del producto (`claude-code` actual, `claude-shared`, `codex`)
sobre PRs del lector, con copias privadas del estado. Nunca toca el Purview en
uso: ni el puerto 4779, ni `~/.purview`, ni los checkouts gestionados (solo los
lee, resueltos por sha).

Requisitos: `pnpm --filter @reviewer/core build`, `pnpm --filter @reviewer/server build`,
y en el entorno `PURVIEW_CLAUDE_BIN`, `PURVIEW_CODEX_BIN`, `PURVIEW_CODEX_HOME`
(ver [../integration.md](../integration.md)). Las corridas gastan cuota.

```sh
R=github.com/owner/repo
OUT=/tmp/realpr-state                      # fuera del repo; borrar al terminar
node prepare.mjs $OUT $R 123 456 789       # una raíz por brazo, 3 PRs, sin secretos ni checkouts
./server.sh $OUT/claude-shared 47910 &     # un server privado por brazo, nunca en paralelo entre brazos
node drive.mjs 47910 $R 123 fresh          # análisis fresco; imprime conteos y títulos
node drive.mjs 47910 $R 456 refresh        # refresh + análisis incremental
node chat.mjs 47910 $R 456 "<pregunta>" "<pedido de draft>"   # pregunta, draft, Stop
kill %1
```

Elegir PRs: una chica, una mediana con findings y, si se puede, con commits
nuevos en GitHub (para el incremental), y una grande. Correr los brazos en serie
para no mezclar cuota ni tiempos.

Qué guardar: conteos, tiempos, títulos de unidades y conclusiones. No subir
diffs, transcripts, cuerpos de comentarios, tokens ni cuentas. La adjudicación
de calidad por unidad y por finding es humana: un `done` no dice nada de eso.

Límites conocidos: con `managedCheckouts: false` un refresh que trae un head
nuevo solo tiene checkout si el Purview en uso (o el lector) ya lo tiene en un
worktree; si no, el run trabaja "con código posiblemente viejo" y lo dice.
`drive.mjs` lee `analysisJob` y `state`; `chat.mjs` consume el stream hasta el
final y luego lee los mensajes y los comentarios.
