import { MOCK_PARTICIPANTS } from '../data/mockParticipants';
import type { DrawRecord, Participant } from './types';

const PARTICIPANTS_KEY = 'tombola:participantes:v1';
const DRAWS_KEY = 'tombola:sorteos:v1';
const TEST_DATA_KEY = 'tombola:datosDePrueba:v1';
const TWITCH_KEY = 'tombola:twitch:v1';

/** Todas las claves que escribe la app, para poder borrarlas juntas. */
const APP_KEYS = [PARTICIPANTS_KEY, DRAWS_KEY, TEST_DATA_KEY, TWITCH_KEY] as const;

export const MAX_PARTICIPANTS = 200;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function isValidName(raw: string): boolean {
  return normalizeName(raw).length >= 2;
}

/** "Valeria Ortiz Mendez" -> "Valeria M." para que entre legible en la bola. */
export function toBallLabel(name: string): string {
  const parts = normalizeName(name).split(' ').filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  const initial = parts[parts.length - 1]!.charAt(0).toUpperCase();
  return `${parts[0]} ${initial}.`;
}

function seed(): Participant[] {
  return MOCK_PARTICIPANTS.map((p) => ({ ...p }));
}

/** Los datos de prueba se identifican por el prefijo de id, para poder sacarlos
 *  de la lista sin tocar lo que se haya cargado a mano o por chat de Twitch. */
export const TEST_ID_PREFIX = 'mock-';

export function isTestParticipant(participant: Participant): boolean {
  return participant.id.startsWith(TEST_ID_PREFIX);
}

/**
 * Interruptor de los datos de prueba. Marcado agrega los 57 nombres ficticios
 * a la lista que haya (conservando lo cargado a mano o por Twitch); desmarcado
 * los saca. En ambos casos queda persistido como preferencia para la carga
 * inicial.
 */
export function applyTestData(enabled: boolean): Participant[] {
  setTestDataEnabled(enabled);
  return enabled ? addTestParticipants() : removeTestParticipants();
}

export function addTestParticipants(): Participant[] {
  const list = listParticipants();
  const present = new Set(list.map((p) => p.id));
  const fresh = MOCK_PARTICIPANTS.filter((p) => !present.has(p.id)).map((p) => ({ ...p }));

  const next = [...list, ...fresh].slice(0, MAX_PARTICIPANTS);
  saveParticipants(next);
  return next;
}

export function removeTestParticipants(): Participant[] {
  const next = listParticipants().filter((p) => !isTestParticipant(p));
  saveParticipants(next);
  return next;
}

/**
 * Si los datos de prueba estan habilitados, la primera carga (cuando no hay
 * lista guardada) siembra los 57 nombres ficticios. Deshabilitarlo NO borra la
 * lista actual: solo cambia que pasa en esa carga inicial. Para meterlos a
 * pedido esta el boton "Cargar datos de ejemplo" del panel de control.
 */
export function isTestDataEnabled(): boolean {
  const store = storage();
  if (!store) return true;
  const raw = store.getItem(TEST_DATA_KEY);
  return raw === null ? true : raw === 'true';
}

export function setTestDataEnabled(enabled: boolean): void {
  storage()?.setItem(TEST_DATA_KEY, String(enabled));
}

export function listParticipants(): Participant[] {
  const store = storage();
  const seedList = (): Participant[] => (isTestDataEnabled() ? seed() : []);

  if (!store) return seedList();

  const raw = store.getItem(PARTICIPANTS_KEY);
  if (raw === null) {
    const initial = seedList();
    store.setItem(PARTICIPANTS_KEY, JSON.stringify(initial));
    return initial;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('no es una lista');
    return parsed.filter(
      (p): p is Participant =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as Participant).id === 'string' &&
        typeof (p as Participant).name === 'string',
    );
  } catch {
    return seed();
  }
}

export function saveParticipants(list: Participant[]): void {
  storage()?.setItem(PARTICIPANTS_KEY, JSON.stringify(list));
}

export function clearParticipants(): void {
  saveParticipants([]);
}

/**
 * Alta de un participante sin perder el resto de la lista. La deduplicacion es
 * por `id`, que para los que vienen de Twitch es `twitch:<userId>`: asi
 * alguien que cambia su nombre visible no se cuela dos veces en el sorteo.
 */
export function upsertParticipant(participant: Participant): {
  list: Participant[];
  added: boolean;
  full: boolean;
} {
  const list = listParticipants();

  if (list.some((p) => p.id === participant.id)) return { list, added: false, full: false };
  if (list.length >= MAX_PARTICIPANTS) return { list, added: false, full: true };

  const next = [...list, participant];
  saveParticipants(next);
  return { list: next, added: true, full: false };
}

export interface TwitchConfig {
  enabled: boolean;
  channel: string;
  command: string;
  /** Si esta activo, solo pueden entrar por chat los suscriptores del canal. */
  subscribersOnly: boolean;
}

export const DEFAULT_TWITCH_CONFIG: TwitchConfig = {
  enabled: false,
  channel: '',
  command: '!entrar',
  subscribersOnly: false,
};

function normalizeTwitchConfig(raw: unknown): TwitchConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TWITCH_CONFIG };
  const cfg = raw as Partial<TwitchConfig>;
  const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : DEFAULT_TWITCH_CONFIG.enabled,
    channel: typeof cfg.channel === 'string' ? cfg.channel.trim() : DEFAULT_TWITCH_CONFIG.channel,
    command: command || DEFAULT_TWITCH_CONFIG.command,
    subscribersOnly:
      typeof cfg.subscribersOnly === 'boolean'
        ? cfg.subscribersOnly
        : DEFAULT_TWITCH_CONFIG.subscribersOnly,
  };
}

export function readTwitchConfig(): TwitchConfig {
  const raw = storage()?.getItem(TWITCH_KEY);
  if (!raw) return { ...DEFAULT_TWITCH_CONFIG };
  try {
    return normalizeTwitchConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TWITCH_CONFIG };
  }
}

export function writeTwitchConfig(patch: Partial<TwitchConfig>): TwitchConfig {
  const next = normalizeTwitchConfig({ ...readTwitchConfig(), ...patch });
  storage()?.setItem(TWITCH_KEY, JSON.stringify(next));
  return next;
}

export function listDraws(): DrawRecord[] {
  const raw = storage()?.getItem(DRAWS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DrawRecord[]) : [];
  } catch {
    return [];
  }
}

export function addDraw(participant: Participant): DrawRecord {
  const record: DrawRecord = {
    id: makeId(),
    participantId: participant.id,
    name: participant.name,
    drawnAt: Date.now(),
  };
  const all = [record, ...listDraws()].slice(0, 50);
  storage()?.setItem(DRAWS_KEY, JSON.stringify(all));
  return record;
}

export function deleteDraw(id: string): DrawRecord[] {
  const next = listDraws().filter((d) => d.id !== id);
  storage()?.setItem(DRAWS_KEY, JSON.stringify(next));
  return next;
}

export function clearDraws(): void {
  storage()?.removeItem(DRAWS_KEY);
}

/**
 * Borra todo lo que la app guarda en este navegador: participantes, historial,
 * configuracion de Twitch y la preferencia de datos de prueba. La app vuelve
 * a su estado de primera ejecucion.
 */
export function clearEverything(): void {
  const store = storage();
  if (!store) return;
  for (const key of APP_KEYS) store.removeItem(key);
}

const HEADER = /^nombre$/i;

/**
 * Entrada de lista de suscriptores: "nick: 70". El numero son meses de
 * suscripcion y no forma parte del nombre.
 *
 * El `: <digitos>` final es lo que distingue este formato de un CSV
 * "nombre,apellido", y por eso el disparador no puede ser la coma.
 */
const SUB_ENTRY = /^(.+?)\s*:\s*\d+$/;

/**
 * De una linea, saca los nombres que aporta.
 *
 * Hace DOS cosas distintas segun la linea, y es deliberado:
 *
 * - CSV de una persona ("Juan,Perez"): una sola entrada, la primera columna.
 *   Esto es lo que hacia siempre.
 * - Lista de suscriptores ("joaking: 70, enddor: 64"): cada segmento es una
 *   persona. Sin esto la linea entera se tomaba como una sola y se perdian
 *   todas menos la primera.
 *
 * El modo se decide por el PRIMER segmento: "Juan,Perez" no matchea el patron
 * (no hay ":" seguido de digitos) asi que nunca se parte en dos.
 */
function namesFromRow(row: string): string[] {
  const segments = row
    .split(/[,;\t]/)
    .map((c) => c.trim())
    .filter((c) => c !== '');

  if (segments.length === 0) return [];

  if (!SUB_ENTRY.test(segments[0]!)) return [segments[0]!];

  const names: string[] = [];
  for (const segment of segments) {
    const match = SUB_ENTRY.exec(segment);
    // Un segmento suelto que no matchea dentro de una linea de suscriptores se
    // ignora: casi siempre es ruido de pegado a mano.
    if (match) names.push(match[1]!);
  }
  return names;
}

/**
 * Acepta CSV/TSV/TXT: una columna, o "nombre,apellido" / "nombre<TAB>apellido".
 * Tambien acepta listas de suscriptores "nick: meses" separadas por coma, en una
 * sola linea o una por linea.
 */
export function parseImportText(text: string): Participant[] {
  const seen = new Set<string>();
  const out: Participant[] = [];

  for (const line of text.split(/\r?\n/)) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;

    for (const field of namesFromRow(row)) {
      const name = normalizeName(field.replace(/^["']|["']$/g, ''));
      if (!isValidName(name) || HEADER.test(name)) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ id: makeId(), name });
      if (out.length >= MAX_PARTICIPANTS) return out;
    }
  }

  return out;
}

export function toCsv(list: readonly Participant[]): string {
  const rows = list.map((p) => `"${p.name.replace(/"/g, '""')}"`);
  return ['nombre', ...rows].join('\n');
}
