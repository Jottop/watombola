# AGENTS.md

Overlay de sorteos con tombola para OBS. Astro 7 + TypeScript estricto, sin framework
de UI: todo el bundle es TypeScript plano sobre `<canvas>`.

`README.md` tiene la guía de uso y de montaje en OBS. Acá va lo que **no** se deduce
leyendo el código.

## Comandos

```sh
npm run dev            # server de desarrollo (localhost:4321)
npm test               # vitest: 6 archivos, ~83 tests, ~1s. Es el feedback rápido.
npm run check          # astro check = tipos + plantillas .astro. Da 0 errores hoy.
npm run build          # ~3s
npm run smoke          # corre el bundle real de /overlay con stubs de DOM. VER ABAJO.
npm run test:browser   # prueba real en Edge, screenshots en shots/. Lento.
```

Node >= 22.12 (ver `engines`). Orden útil: `npm test` -> `npm run check` -> Recién ahí
`smoke` / `test:browser`, que reconstruyen todo.

Correr **un solo archivo** de test: `npx vitest run test/physics.test.ts`.
No hay `vitest.config.*`: los tests viven en `test/` (raiz), no junto al código, y
vitest corre con defaults. No los muevas a `src/` sin agregar el include.

## Trampas verificadas

- **`npm run smoke` imprime `OK` y se queda colgado para siempre.** El bundle del
  overlay registra un `setInterval` real (`In`, cada 1s) que el harness de stubs nunca
  limpia, y el script no hace `process.exit(0)` al final. Hay que cortarlo con Ctrl+C.
  Peor: si lo redirigís a un archivo o lo pipeás, **perdés todo el output**, porque
  Node no cierra los streams hasta salir. Para ver el resultado, corrélo con
  `Start-Process` con redirect, leé el archivo, y matalo.
- Los dos scripts de Puppeteer tienen el path de Edge hardcodeado
  (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`). No son
  configurables: en otra máquina o con Chrome fallan.
- `scripts/diag-overlay.mjs` **no está en `package.json`**. Se corre a mano
  (`node scripts/diag-overlay.mjs [url]`) y necesita `npm run dev` ya levantado.
  Es el que sirve para depurar "no dibuja nada" (reporta canvas, fase, pixels con
  alpha, y qué hay en localStorage).
- `shots/` está en `.gitignore`, pero los dos scripts de navegador escriben ahí.
  En un clon nuevo el screenshot revienta con ENOENT: creá el directorio primero.
- `smoke` y `test:browser` corren `astro build` antes a propósito: ejercitan el
  **bundle real**, no una copia de la lógica. `smoke` importa
  `dist/_astro/overlay*.js`, así que si renombrás la page se rompe el `readdirSync`
  que lo busca por prefijo.

## Arquitectura

Tres páginas, sin backend: `/overlay` (la fuente de OBS), `/control` (panel),
`/` (landing).

`src/lib/` separa la lógica **pura** (sin DOM) de la que dibuja, y esa separación es
lo que hace que los tests sean directos:

| Puro y testeable | Con DOM / efectos |
|---|---|
| `physics.ts` (simulación del bombo) | `renderer.ts` (canvas) |
| `drum-machine.ts` (máquina de estados) | `audio.ts` (WebAudio) |
| `rng.ts` (azar) | `confetti.ts` |
| `store.ts` (localStorage) | `pages/overlay.astro` |
| `twitch-command.ts` (parseo del comando) | `pages/control.astro` |

`twitch.ts` es **el único** archivo que importa `mtmi`. Si agregás lógica de Twitch,
va en `twitch-command.ts` para que siga testeable.

Máquina de estados del bombo: `idle -> spinning -> ejecting -> reveal`.
Temporales en constantes exportadas (`SPIN_DURATION`, `REVEAL_DURATION`, etc.) al
tope de `drum-machine.ts`.

### El ganador lo decide el azar, no la física

Esto es deliberado y fácil de romper por accidente: `rng.ts` elige al ganador con
`crypto.getRandomValues` **antes** de la animación. No uses "la bola que salió" ni
la posición final de la simulación para decidir el resultado: la física produce sesgo
por acumulación en los bordes. Para tests, `rng.ts` exporta `seededRandom` (mulberry32)
y **todas** las funciones aceptan un `RandomSource` inyectable — usalo en vez de
mockear `Math.random`.

## Contrato entre /control y /overlay

Son páginas separadas sin servidor: se comunican **solo por `localStorage`**.

- Las claves están hardcodeadas **en dos lugares**: las constantes de
  `src/lib/store.ts` (`tombola:participantes:v1`, `tombola:sorteos:v1`,
  `tombola:datosDePrueba:v1`, `tombola:twitch:v1`) y los literales en el listener
  `storage` de `overlay.astro`. Si tocás una clave, actualizá los dos lados o el
  overlay deja de reaccionar.
- El evento `storage` **solo se dispara en otras pestañas**, nunca en la que escribe.
  Por eso el overlay además polea con `setInterval` para detectar cambios externos.
- `MAX_PARTICIPANTS = 200` es el mismo tope que usa la física para dimensionar la
  rejilla de colisiones. Si lo subís, subí `maxBalls` en `createDrumState` y pensá
  en el costo O(n) por frame.
- Los datos de prueba se distinguen por el **prefijo de id `mock-`**
  (`TEST_ID_PREFIX` en `store.ts`). Ese prefijo es lo que permite prender y apagar los
  57 nombres ficticios sin tocar lo cargado a mano ni lo que entra por Twitch. No lo
  reemplaces por una bandera en otra parte.

## Twitch (mtmi)

Conexión **anónima por WebSocket al IRC de Twitch**, desde el navegador. Sin token,
sin backend, sin credenciales en la página. Solo lectura.

- **Escucha el overlay, no el panel de control.** Cambiar canal o comando en
  `/control` reconecta, pero hay que **recargar la fuente de OBS** para que tome el
  cambio.
- mtmi no expone eventos de conexión, así que la UI solo puede afirmar que *pidió*
  escuchar. Si se cae la conexión, el único indicio real está en la consola del
  navegador.
- `mtmi` tiene el flag `debug` **invertido**: siempre escribe en consola, no hay
  forma de desactivarlo por API.
- Dos trampas de la librería que `twitch.ts` esquiva y hay que respetar si se toca:
  `Client` no tiene `off()` (los listeners se acumulan para siempre, por eso el
  listener se registra una sola vez y lee de una sesión en módulo), y en `close()`
  reconecta solo tras un cierre con código 1006 usando `client.options` (por eso hay
  que limpiar ese campo para cortar de verdad).

## Robustez del overlay

Corre **desatendido durante horas** de stream, sin nadie mirando. Por eso:

- El bucle de `requestAnimationFrame` envuelve el frame en `try/catch` y pide el
  siguiente frame en el `finally`: una excepción en un frame no puede matar la
  animación. Loguea los primeros 3 y después sigue en silencio. Mantené ese patrón.
- El `dt` está topado a 0.05s (`overlay.astro`). Sin ese clamp, un frame perdido
  después de una pausa de OBS rompe la simulación.
- `audio.unlock()` es async (política de autoplay): `trigger()` es `async` y hay que
  dejar correr el microtask. Si tocás el arranque del sorteo, no la trates como
  síncrona.

## Estilo

- Comentarios y textos de UI en **español**, sin tildes ni `ñ` en el código
  (sí se usan en el README y en las caras de la UI). Es una convención deliberada
  del proyecto: mantenela.
- Las funciones puras reciben sus dependencias como parámetros (`RandomSource`,
  `DrumEvents`) en vez de importar singletons. Es lo que permite testearlas.