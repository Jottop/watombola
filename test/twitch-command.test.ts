import { describe, expect, it } from 'vitest';
import { buildEntry, parseEntryCommand, twitchUserId } from '../src/lib/twitch-command';

const CMD = '!entrar';
const none = new Set<string>();

describe('parseEntryCommand', () => {
  it('matchea el comando exacto', () => {
    expect(parseEntryCommand('!entrar', CMD)).toBe(true);
  });

  it('ignora mayusculas', () => {
    expect(parseEntryCommand('!ENTRAR', CMD)).toBe(true);
    expect(parseEntryCommand('!EnTrAr', CMD)).toBe(true);
  });

  it('acepta texto extra despues del comando', () => {
    expect(parseEntryCommand('!entrar porfa', CMD)).toBe(true);
  });

  it('soporta comandos con espacios', () => {
    expect(parseEntryCommand('!sorteo ahora', '!sorteo ahora')).toBe(true);
    expect(parseEntryCommand('!sorteo ya', '!sorteo ahora')).toBe(false);
    expect(parseEntryCommand('!sorteo', '!sorteo ahora')).toBe(false);
  });

  it('no matchea si el comando no esta al principio', () => {
    expect(parseEntryCommand('hola !entrar', CMD)).toBe(false);
  });

  it('tolera espacios alrededor', () => {
    expect(parseEntryCommand('   !entrar  ', CMD)).toBe(true);
    expect(parseEntryCommand('!entrar', '  !entrar ')).toBe(true);
  });

  it('no matchea prefijos parecidos', () => {
    expect(parseEntryCommand('!entrantes', CMD)).toBe(false);
    expect(parseEntryCommand('!entrarx', CMD)).toBe(false);
  });

  it('no matchea con comando vacio', () => {
    expect(parseEntryCommand('!entrar', '')).toBe(false);
    expect(parseEntryCommand('!entrar', '   ')).toBe(false);
  });

  it('deja pasar otro comando configurado', () => {
    expect(parseEntryCommand('!participar', '!participar')).toBe(true);
    expect(parseEntryCommand('!entrar', '!participar')).toBe(false);
  });
});

describe('buildEntry', () => {
  const message = (extra: Record<string, unknown> = {}) => ({
    username: 'fulanito',
    message: '!entrar',
    userInfo: { displayName: 'Fulanito', username: 'fulanito', isBot: false },
    messageInfo: { userId: '12345' },
    ...extra,
  });

  it('arma el candidato con un comando valido', () => {
    expect(buildEntry(message(), CMD, none)).toEqual({
      userId: 'twitch:12345',
      displayName: 'Fulanito',
    });
  });

  it('ignora mensajes que no son el comando', () => {
    expect(buildEntry(message({ message: 'hola' }), CMD, none)).toBeNull();
  });

  it('ignora a los bots', () => {
    const bot = message({ userInfo: { displayName: 'Nightbot', isBot: true }, messageInfo: { userId: '9' } });
    expect(buildEntry(bot, CMD, none)).toBeNull();
  });

  it('no deja anotarse dos veces al mismo usuario', () => {
    const known = new Set([twitchUserId('12345')]);
    expect(buildEntry(message(), CMD, known)).toBeNull();
  });

  it('permite mismo nombre visible con distinto userId', () => {
    const known = new Set([twitchUserId('99999')]);
    expect(buildEntry(message(), CMD, known)).not.toBeNull();
  });

  it('cae al username si no viene userInfo', () => {
    const bare = { username: 'fulanito', message: '!entrar' };
    expect(buildEntry(bare, CMD, none)).toEqual({
      userId: 'twitch:fulanito',
      displayName: 'fulanito',
    });
  });

  it('descarta mensajes sin usuario identificable', () => {
    expect(buildEntry({ message: '!entrar' }, CMD, none)).toBeNull();
  });

  it('normaliza el id a minuscula', () => {
    const upper = message({ messageInfo: { userId: 'ABC123' } });
    expect(buildEntry(upper, CMD, none)?.userId).toBe('twitch:abc123');
  });

  it('acepta userId numerico (como lo declara mtmi)', () => {
    const numeric = message({ messageInfo: { userId: 777 } });
    expect(buildEntry(numeric, CMD, none)?.userId).toBe('twitch:777');
  });
});
