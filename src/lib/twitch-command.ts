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
  badges?: BadgeLike[];
  messageInfo?: {
    // Twitch manda el user-id como string; mtmi lo declara number. Aceptamos
    // los dos y normalizamos, asi no dependemos de ese detalle.
    userId?: string | number;
    isEmoteOnly?: boolean;
  };
}

/** Badge de chat. mtmi lo parsea desde el tag `badges` del IRC. */
export interface BadgeLike {
  name?: string;
  value?: string;
}

/**
 * Forma de los USERNOTICE que nos interesan (sub, resub, primepaidupgrade y
 * subgift). mtmi arma estos campos desde los tags del IRC, pero sus tipos no
 * siempre los declaran, asi que definimos la forma que usamos.
 */
export interface TwitchNoticeLike {
  username?: string;
  userInfo?: {
    username?: string;
    displayName?: string;
    isBot?: boolean;
  };
  messageInfo?: {
    userId?: string | number;
  };
  subInfo?: {
    wasGifted?: boolean;
    subPlan?: {
      isPrime?: boolean;
    };
  };
  giftInfo?: {
    recipientId?: string | number;
    recipientUserName?: string;
    recipientDisplayName?: string;
  };
}

export interface EntryCandidate {
  /** Clave estable del usuario. Cambiar el nombre visible no genera otra entrada. */
  userId: string;
  displayName: string;
}

export interface EntryOptions {
  /** Si esta activo, solo entran quienes tengan el badge de suscriptor. */
  subscribersOnly?: boolean;
}

/**
 * Badges que cuentan como "suscriptor del canal".
 *
 * Ojo con el tag `subscriber` del IRC, que es la via obvia: esta deprecado por
 * Twitch y se sabe que marca `subscriber=0` a los fundadores, que si son
 * suscriptores. El campo `isSub` de mtmi sale de ahi, asi que tampoco sirve.
 * El badge si es la fuente correcta.
 *
 * `founder` va aparte porque no siempre viene junto a `subscriber`.
 */
const SUBSCRIBER_BADGES = new Set(['subscriber', 'founder']);

/** Si quien escribio tiene el badge de suscriptor del canal. */
export function hasSubscriberBadge(raw: TwitchMessageLike): boolean {
  return (raw.badges ?? []).some((badge) => SUBSCRIBER_BADGES.has(badge?.name ?? ''));
}

/**
 * Si quien escribio es el dueño del canal.
 *
 * mtmi no expone `isBroadcaster` en el `userInfo`, asi que se lee del badge
 * `broadcaster`, que Twitch solo le manda a ese usuario y solo en su canal.
 */
export function isChannelOwner(raw: TwitchMessageLike): boolean {
  return (raw.badges ?? []).some((badge) => badge?.name === 'broadcaster');
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
 * Devuelve el candidato si el mensaje es una entrada valida. Los bots se
 * ignoran: un !entrar de Nightbot no compite.
 *
 * No se descarta a quien ya esta en la lista: el store es el que aplica el tope
 * de dos pelotas por persona.
 */
export function buildEntry(
  raw: TwitchMessageLike,
  command: string,
  options: EntryOptions = {},
): EntryCandidate | null {
  const text = raw.message ?? '';
  if (!parseEntryCommand(text, command)) return null;
  if (raw.userInfo?.isBot) return null;
  // El dueño del canal entra siempre, tenga o no tenga el filtro activo: es su
  // canal y su sorteo, y casi nunca esta suscrito a si mismo. Moderadores y
  // VIPs siguen sin pasar, porque no son parte del filtro.
  if (options.subscribersOnly && !isChannelOwner(raw) && !hasSubscriberBadge(raw)) return null;

  const rawUserId = raw.messageInfo?.userId ?? raw.userInfo?.username ?? raw.username;
  if (rawUserId === undefined || rawUserId === null) return null;

  const userId = String(rawUserId).trim();
  if (!userId) return null;

  const displayName = (raw.userInfo?.displayName ?? raw.username ?? userId).trim();
  if (!displayName) return null;

  return { userId: twitchUserId(userId), displayName };
}

/**
 * Candidato a partir de un aviso de suscripcion. Sirve para `sub`,
 * `primepaidupgrade` y, con `primeOnly`, para las renovaciones Prime.
 *
 * Las subs Prime llegan como `sub` con `subInfo.subPlan.isPrime` en true: no
 * necesitan un evento propio, pero el filtro de `resub` si las distingue de las
 * renovaciones de pago.
 */
export function subscriberCandidate(
  raw: TwitchNoticeLike,
  options: { primeOnly?: boolean } = {},
): EntryCandidate | null {
  if (options.primeOnly && !raw.subInfo?.subPlan?.isPrime) return null;
  if (raw.userInfo?.isBot) return null;

  const rawUserId = raw.messageInfo?.userId ?? raw.userInfo?.username ?? raw.username;
  if (rawUserId === undefined || rawUserId === null) return null;

  const userId = String(rawUserId).trim();
  if (!userId) return null;

  const displayName = (
    raw.userInfo?.displayName ??
    raw.userInfo?.username ??
    raw.username ??
    userId
  ).trim();
  if (!displayName) return null;

  return { userId: twitchUserId(userId), displayName };
}

/**
 * Candidato a partir de un `subgift`. Solo cuenta el receptor: el que regala
 * viene en `userInfo`/`gifter*` y no debe entrar por este evento.
 */
export function giftRecipientCandidate(raw: TwitchNoticeLike): EntryCandidate | null {
  const info = raw.giftInfo;
  if (!info) return null;

  const rawUserId = info.recipientId ?? info.recipientUserName;
  if (rawUserId === undefined || rawUserId === null) return null;

  const userId = String(rawUserId).trim();
  if (!userId) return null;

  const displayName = (info.recipientDisplayName ?? info.recipientUserName ?? userId).trim();
  if (!displayName) return null;

  return { userId: twitchUserId(userId), displayName };
}
