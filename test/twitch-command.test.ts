import { describe, expect, it } from 'vitest';
import {
  buildEntry,
  giftRecipientCandidate,
  hasSubscriberBadge,
  isChannelOwner,
  parseEntryCommand,
  subscriberCandidate,
} from '../src/lib/twitch-command';

const CMD = '!entrar';

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

const message = (extra: Record<string, unknown> = {}) => ({
  username: 'fulanito',
  message: '!entrar',
  userInfo: { displayName: 'Fulanito', username: 'fulanito', isBot: false },
  messageInfo: { userId: '12345' },
  ...extra,
});

describe('buildEntry', () => {

  it('arma el candidato con un comando valido', () => {
    expect(buildEntry(message(), CMD)).toEqual({
      userId: 'twitch:12345',
      displayName: 'Fulanito',
    });
  });

  it('ignora mensajes que no son el comando', () => {
    expect(buildEntry(message({ message: 'hola' }), CMD)).toBeNull();
  });

  it('ignora a los bots', () => {
    const bot = message({ userInfo: { displayName: 'Nightbot', isBot: true }, messageInfo: { userId: '9' } });
    expect(buildEntry(bot, CMD)).toBeNull();
  });

  it('cae al username si no viene userInfo', () => {
    const bare = { username: 'fulanito', message: '!entrar' };
    expect(buildEntry(bare, CMD)).toEqual({
      userId: 'twitch:fulanito',
      displayName: 'fulanito',
    });
  });

  it('descarta mensajes sin usuario identificable', () => {
    expect(buildEntry({ message: '!entrar' }, CMD)).toBeNull();
  });

  it('normaliza el id a minuscula', () => {
    const upper = message({ messageInfo: { userId: 'ABC123' } });
    expect(buildEntry(upper, CMD)?.userId).toBe('twitch:abc123');
  });

  it('acepta userId numerico (como lo declara mtmi)', () => {
    const numeric = message({ messageInfo: { userId: 777 } });
    expect(buildEntry(numeric, CMD)?.userId).toBe('twitch:777');
  });
});

describe('hasSubscriberBadge', () => {
  it('reconoce el badge de suscriptor', () => {
    expect(hasSubscriberBadge(message({ badges: [{ name: 'subscriber', value: '12' }] }))).toBe(true);
  });

  it('reconoce al fundador, que el tag subscriber marca mal', () => {
    expect(hasSubscriberBadge(message({ badges: [{ name: 'founder', value: '7' }] }))).toBe(true);
  });

  it('da falso sin badges', () => {
    expect(hasSubscriberBadge(message())).toBe(false);
    expect(hasSubscriberBadge(message({ badges: [] }))).toBe(false);
  });

  it('ignora otros badges', () => {
    const others = [{ name: 'moderator' }, { name: 'vip' }, { name: 'premium' }, { name: 'turbo' }];
    expect(hasSubscriberBadge(message({ badges: others }))).toBe(false);
  });

  it('aguanta badges raros sin romperse', () => {
    expect(hasSubscriberBadge(message({ badges: [null, {}, { name: '' }] }))).toBe(false);
  });

  it('no confunde el campo isSub de mtmi, que viene del tag deprecado', () => {
    // mtmi calcula isSub como `subscriber !== '0'`, asi que si falta el tag da
    // true para cualquiera. Por eso el filtro mira badges y no isSub.
    const sinTag = message({ userInfo: { displayName: 'X', username: 'x', isBot: false, isSub: true } });
    expect(hasSubscriberBadge(sinTag)).toBe(false);
  });
});

describe('buildEntry con filtro de suscriptores', () => {
  const soloSubs = { subscribersOnly: true };

  it('deja entrar a quien tiene el badge', () => {
    const sub = message({ badges: [{ name: 'subscriber', value: '3' }] });
    expect(buildEntry(sub, CMD, soloSubs)).not.toBeNull();
  });

  it('deja fuera a quien no lo tiene', () => {
    expect(buildEntry(message(), CMD, soloSubs)).toBeNull();
  });

  it('con el filtro apagado deja entrar a cualquiera', () => {
    expect(buildEntry(message(), CMD, { subscribersOnly: false })).not.toBeNull();
    expect(buildEntry(message(), CMD, {})).not.toBeNull();
  });

  it('el filtro no deja pasar bots suscritos', () => {
    const bot = message({
      badges: [{ name: 'subscriber', value: '3' }],
      userInfo: { displayName: 'Nightbot', isBot: true },
    });
    expect(buildEntry(bot, CMD, soloSubs)).toBeNull();
  });
});

describe('isChannelOwner', () => {
  it('reconoce el badge de broadcaster', () => {
    expect(isChannelOwner(message({ badges: [{ name: 'broadcaster', value: '1' }] }))).toBe(true);
  });

  it('da falso para el resto', () => {
    expect(isChannelOwner(message())).toBe(false);
    expect(isChannelOwner(message({ badges: [] }))).toBe(false);
    expect(isChannelOwner(message({ badges: [{ name: 'subscriber', value: '1' }] }))).toBe(false);
    expect(isChannelOwner(message({ badges: [{ name: 'moderator', value: '1' }] }))).toBe(false);
  });
});

describe('el dueño del canal siempre puede entrar', () => {
  const owner = message({ badges: [{ name: 'broadcaster', value: '1' }] });
  const soloSubs = { subscribersOnly: true };

  it('entra con el filtro de suscriptores activado', () => {
    expect(buildEntry(owner, CMD, soloSubs)).not.toBeNull();
  });

  it('entra con el filtro apagado', () => {
    expect(buildEntry(owner, CMD, { subscribersOnly: false })).not.toBeNull();
  });

  it('el filtro apagado no cambia nada para un suscriptor comun', () => {
    const sub = message({ badges: [{ name: 'subscriber', value: '3' }] });
    expect(buildEntry(sub, CMD, soloSubs)).not.toBeNull();
  });

  it('un moderador sin suscripcion sigue afuera', () => {
    const mod = message({ badges: [{ name: 'moderator', value: '1' }] });
    expect(buildEntry(mod, CMD, soloSubs)).toBeNull();
  });

  it('un VIP sin suscripcion sigue afuera', () => {
    const vip = message({ badges: [{ name: 'vip', value: '1' }] });
    expect(buildEntry(vip, CMD, soloSubs)).toBeNull();
  });

  it('un bot con badge de broadcaster tampoco entra', () => {
    const botOwner = message({
      badges: [{ name: 'broadcaster', value: '1' }],
      userInfo: { displayName: 'Nightbot', isBot: true },
    });
    expect(buildEntry(botOwner, CMD, soloSubs)).toBeNull();
  });
});

describe('subscriberCandidate', () => {
  const notice = (extra: Record<string, unknown> = {}) => ({
    username: 'fulanito',
    userInfo: { displayName: 'Fulanito', username: 'fulanito', isBot: false },
    messageInfo: { userId: '12345' },
    ...extra,
  });

  it('arma el candidato de una sub Prime', () => {
    expect(subscriberCandidate(notice({ subInfo: { subPlan: { isPrime: true } } }))).toEqual({
      userId: 'twitch:12345',
      displayName: 'Fulanito',
    });
  });

  it('tambien acepta una sub de pago', () => {
    expect(subscriberCandidate(notice({ subInfo: { subPlan: { isPrime: false } } }))).not.toBeNull();
  });

  it('en modo primeOnly ignora las renovaciones de pago', () => {
    const pago = notice({ subInfo: { subPlan: { isPrime: false } } });
    expect(subscriberCandidate(pago, { primeOnly: true })).toBeNull();
  });

  it('en modo primeOnly acepta una renovacion Prime', () => {
    const prime = notice({ subInfo: { subPlan: { isPrime: true } } });
    expect(subscriberCandidate(prime, { primeOnly: true })).not.toBeNull();
  });

  it('ignora a los bots', () => {
    const bot = notice({ userInfo: { displayName: 'Nightbot', isBot: true } });
    expect(subscriberCandidate(bot)).toBeNull();
  });
});

describe('giftRecipientCandidate', () => {
  it('agrega al receptor del regalo, no a quien lo dona', () => {
    const gift = {
      username: 'gifter',
      userInfo: { displayName: 'ElGifter', username: 'gifter', isBot: false },
      messageInfo: { userId: '1' },
      giftInfo: {
        gifterUserName: 'gifter',
        gifterDisplayName: 'ElGifter',
        recipientId: '222',
        recipientUserName: 'afortunado',
        recipientDisplayName: 'Afortunado',
      },
    };
    expect(giftRecipientCandidate(gift)).toEqual({
      userId: 'twitch:222',
      displayName: 'Afortunado',
    });
  });

  it('cae al login del receptor si no viene el display name', () => {
    const gift = { giftInfo: { recipientUserName: 'afortunado' } };
    expect(giftRecipientCandidate(gift)?.displayName).toBe('afortunado');
  });

  it('ignora un regalo masivo sin receptor individual', () => {
    expect(giftRecipientCandidate({ giftInfo: undefined })).toBeNull();
  });
});
