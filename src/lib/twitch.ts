import { client } from 'mtmi';
import { listParticipants, type TwitchConfig } from './store';
import { buildEntry, type EntryCandidate, type TwitchMessageLike } from './twitch-command';

/**
 * mtmi corre en el navegador: se conecta por WebSocket al IRC de Twitch de
 * forma anonima (NICK justinfan), asi que no hace falta token, backend ni
 * credenciales en la pagina. Solo lectura.
 *
 * Dos trampas de la libreria que hay que esquivar:
 *
 * 1. `Client` no tiene `off()`: los listeners se acumulan para siempre y cada
 *    reconectaria los duplicaria. Por eso el listener se registra UNA sola vez
 *    y lee de una sesion activa en modulo.
 * 2. En `close()`, si el socket muere con codigo 1006 reconecta solo a los 5s
 *    usando `client.options`. Para cortar de verdad hay que limpiar ese campo
 *    (es publico), si no el overlay "apagado" vuelve a conectarse solo.
 *
 * Ademas mtmi tiene el flag `debug` invertido (`!debug && (debug = true)`), asi
 * que siempre escribe en consola. No hay forma de desactivarlo por API.
 */

export interface TwitchHandlers {
  onEntry: (candidate: EntryCandidate) => void;
}

interface Session {
  config: TwitchConfig;
  handlers: TwitchHandlers;
  known: Set<string>;
  entries: number;
}

let session: Session | null = null;
let listenerRegistered = false;

function ensureListener(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;

  client.on('message', (raw) => {
    const current = session;
    if (!current) return;

    const candidate = buildEntry(
      raw as TwitchMessageLike,
      current.config.command,
      current.known,
    );
    if (!candidate) return;

    current.known.add(candidate.userId);
    current.entries += 1;
    current.handlers.onEntry(candidate);
  });
}

function knownFromStore(): Set<string> {
  return new Set(listParticipants().map((p) => p.id));
}

/** Arranca (o cambia de canal) la escucha. Devuelve una funcion para cortarla. */
export function connectTwitch(
  config: TwitchConfig,
  handlers: TwitchHandlers,
): () => void {
  ensureListener();
  disconnectTwitch();

  if (!config.enabled || !config.channel) return () => {};

  session = { config, handlers, known: knownFromStore(), entries: 0 };

  client.connect({
    channels: [config.channel.toLowerCase()],
    secure: true,
    avatarProvider: 'decapi',
    badges: [],
    customApi: {
      url: 'https://decapi.me/twitch/avatar/{{username}}',
      extract: 'avatar',
    },
    debug: false,
  });

  return disconnectTwitch;
}

export function disconnectTwitch(): void {
  session = null;
  client.close();
  // Sin esto, un cierre con codigo 1006 dispara la reconexion automatica de
  // mtmi con la configuracion anterior.
  client.options = undefined;
}

export function isTwitchListening(): boolean {
  return session !== null;
}

export function twitchEntriesSoFar(): number {
  return session?.entries ?? 0;
}
