/**
 * Logica pura del comando de entrada. No importa mtmi: recibe la forma del
 * evento de "message" y devuelve un candidato. Asi se puede testear sin la
 * dependencia y sin red.
 */

export interface TwitchMessageLike {
  username?: string;
  message?: string;
  userInfo?: {
    displayName?: string;
    username?: string;
    isBot?: boolean;
  };
  messageInfo?: {
    // Twitch manda el user-id como string; mtmi lo declara number. Aceptamos
    // los dos y normalizamos, asi no dependemos de ese detalle.
    userId?: string | number;
    isEmoteOnly?: boolean;
  };
}

export interface EntryCandidate {
  /** Clave estable del usuario. Cambiar el nombre visible no genera otra entrada. */
  userId: string;
  displayName: string;
}

/**
 * Matchea el comando token a token al principio del mensaje, sin distinguir
 * mayusculas. Token a token y no startsWith para que "!entrantes" no cuente
 * como "!entrar", y con todos los tokens del comando para que un comando con
 * espacios (por ejemplo "!sorteo ahora") tambien funcione.
 */
export function parseEntryCommand(text: string, command: string): boolean {
  const expected = command.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (expected.length === 0) return false;

  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < expected.length) return false;

  return expected.every((token, i) => tokens[i] === token);
}

export function twitchUserId(user: string): string {
  return `twitch:${user.toLowerCase()}`;
}

/**
 * Devuelve el candidato si el mensaje es una entrada valida y el usuario todavia
 * no se anotaba. Los bots se ignoran: un !entrar de Nightbot no compite.
 */
export function buildEntry(
  raw: TwitchMessageLike,
  command: string,
  knownUserIds: ReadonlySet<string>,
): EntryCandidate | null {
  const text = raw.message ?? '';
  if (!parseEntryCommand(text, command)) return null;
  if (raw.userInfo?.isBot) return null;

  const rawUserId = raw.messageInfo?.userId ?? raw.userInfo?.username ?? raw.username;
  if (rawUserId === undefined || rawUserId === null) return null;

  const userId = String(rawUserId).trim();
  if (!userId) return null;

  const id = twitchUserId(userId);
  if (knownUserIds.has(id)) return null;

  const displayName = (raw.userInfo?.displayName ?? raw.username ?? userId).trim();
  if (!displayName) return null;

  return { userId: id, displayName };
}
