# Tómbola para sorteos

Overlay transparente para OBS con bombo de bolas animadas. Los participantes se
cargan a mano, por archivo, o **solos cuando alguien escribe el comando en el
chat de Twitch**.

## Páginas

| Ruta | Qué es |
|---|---|
| `/overlay` | La pantalla del sorteo. Es la fuente de navegador de OBS. |
| `/control` | Cargar y editar participantes, configurar Twitch, ver el historial. |
| `/` | Landing con los atajos. |

## Ponerla en OBS

1. Fuentes → **+** → **Navegador**.
2. URL `http://localhost:4321/overlay` (o la del deploy).
3. Ancho `1920`, alto `1080`, FPS `60`.
4. **Desmarca** "Apagar la fuente cuando no sea visible", si no la animación se
   congela entre escenas.
5. Activa **Controlar el mouse mediante OBS** para poder hacer clic en el bombo.

El teclado depende de que la fuente tenga el foco. Para sortear sin depender de
eso, alcanza con hacer clic sobre el bombo.

Parámetros útiles en la URL: `?bg=dark` para previsualizar con fondo, `?ui` para
mostrar la línea de estado, `?help` para dejar los atajos visibles.

## Atajos del overlay

| Tecla | Acción |
|---|---|
| `Espacio` / `Enter` / clic | Sortear |
| `R` | Reiniciar el bombo |
| `M` | Silenciar |
| `Esc` | Cerrar el ganador |

## Participantes desde Twitch

Se activa en `/control` → "Participantes desde Twitch". Quien escriba el comando
(en default `!entrar`) en el chat del canal entra solo a la tómbola, con su bola
cayendo al bombo y un aviso discreto en pantalla.

Detalles que conviene saber:

- **Sin token ni backend.** Se usa [mtmi](https://github.com/ManzDev/mtmi), que se
  conecta por WebSocket al IRC de Twitch de forma anónima y en modo lectura.
  Por eso **escucha el overlay**, no el panel de control: recarga la fuente de
  OBS después de cambiar el canal o el comando.
- **Deduplica por `userId`**, no por nombre: alguien que cambia su nombre visible
  no se cuela dos veces. Los bots se ignoran.
- Si ya hay un sorteo en curso, la persona se guarda para el siguiente: no puede
  entrar en una ronda cuyo ganador ya está definido.
- Avisos honestos: mtmi no expone eventos de conexión, así que la interfaz solo
  afirma que *pidió* escuchar. Si Twitch corta la conexión (pasa con IRC anónimo
  en canales muy activos) el único indicio real está en la consola del navegador.

## Datos de prueba

El checkbox "Datos de prueba al iniciar" de la sección Participantes es un
interruptor sobre la lista: al activarlo entran los 57 nombres ficticios y al
desactivarlos se van. **No toca lo que hayas cargado a mano o desde Twitch**: se
reconoce a los de prueba por el prefijo de su id (`mock-`) y solo se sacan
esos. El overlay se entera al instante por el evento `storage`, sin recargar la
fuente.

También queda como preferencia para la primera carga: si no hay lista guardada y
el checkbox está apagado, la tómbola arranca vacía.

## Historial y mantenimiento

En `/control`, la sección **Historial de sorteos** guarda los últimos 50 ganadores.
Se puede borrar todo el historial o quitar un registro suelto con su botón
*Quitar*.

La sección **Mantenimiento** tiene el botón *Borrar todo ahora, sin confirmar*: borra
todo lo que la app guarda en ese navegador (participantes, historial,
configuración de Twitch y la preferencia de datos de prueba) y recarga la página.
Es lo que conviene usar si algo quedó trabado. **No pide confirmación ni se puede
deshacer**, así que el aviso está en el propio botón.

## Desarrollo

```sh
npm install
npm run dev        # servidor de desarrollo
npm test           # tests unitarios (física, sorteo, store, comando de Twitch)
npm run check      # astro check (tipos + plantillas)
npm run test:browser   # prueba real en Edge: screenshots en shots/
```

Los dos scripts de prueba construyen el proyecto antes de correr, porque ejecutan
el **bundle real** y no una copia de la lógica. `test:browser` además intercepta
el `WebSocket` para comprobar que mtmi se conecta de verdad.

## Cómo está armado

```
src/lib/
  types.ts          Participant, DrawRecord
  rng.ts            azar criptográfico + PRNG con seed para tests
  store.ts          localStorage: participantes, sorteos, config de Twitch
  physics.ts        simulación del bombo (puro, sin DOM)
  drum-machine.ts   estados idle -> spinning -> ejecting -> reveal (puro)
  renderer.ts       dibujado en canvas
  audio.ts          efectos sintetizados con WebAudio
  confetti.ts       partículas
  twitch-command.ts lógica del comando de entrada (puro, testeable sin mtmi)
  twitch.ts         el único archivo que importa mtmi
```

`physics.ts` y `drum-machine.ts` no tocan el DOM, así que se testean directo. El
ganador lo decide `rng.ts` con `crypto.getRandomValues`, **no** la simulación:
dejarlo en las bolas daría sesgo por acumulación en los bordes.
