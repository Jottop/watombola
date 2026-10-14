import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDraw,
  addTestParticipants,
  applyTestData,
  clearDraws,
  clearEverything,
  clearParticipants,
  DEFAULT_TWITCH_CONFIG,
  deleteDraw,
  isTestDataEnabled,
  isTestParticipant,
  listDraws,
  listParticipants,
  MAX_PARTICIPANTS,
  parseImportText,
  readTwitchConfig,
  removeTestParticipants,
  saveParticipants,
  toBallLabel,
  upsertParticipant,
  writeTwitchConfig,
} from '../src/lib/store';

function fakeStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const stub: Storage = {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  vi.stubGlobal('localStorage', stub);
  return map;
}

beforeEach(() => {
  fakeStorage();
});

function setTestDataEnabled(enabled: boolean): void {
  localStorage.setItem('tombola:datosDePrueba:v1', String(enabled));
}

describe('datos de prueba', () => {
  it('arranca habilitado si nunca se toco el flag', () => {
    expect(isTestDataEnabled()).toBe(true);
  });

  it('siembra la lista mock cuando esta habilitado y no hay nada guardado', () => {
    setTestDataEnabled(true);
    expect(listParticipants().length).toBeGreaterThan(10);
  });

  it('arranca vacio si el flag esta deshabilitado', () => {
    setTestDataEnabled(false);
    expect(listParticipants()).toEqual([]);
  });
});

describe('interruptor de datos de prueba', () => {
  beforeEach(() => {
    setTestDataEnabled(false);
  });

  it('activarlo agrega los nombres de prueba a una lista vacia', () => {
    const list = applyTestData(true);
    expect(list.length).toBeGreaterThan(10);
    expect(list.every(isTestParticipant)).toBe(true);
    expect(isTestDataEnabled()).toBe(true);
  });

  it('desactivarlo saca solo los de prueba', () => {
    saveParticipants([
      ...applyTestData(true),
      { id: 'twitch:1', name: 'fulano' },
      { id: 'manual-1', name: 'ana' },
    ]);

    const list = applyTestData(false);
    expect(list).toHaveLength(2);
    expect(list.some(isTestParticipant)).toBe(false);
    expect(list.map((p) => p.name).sort()).toEqual(['ana', 'fulano']);
    expect(isTestDataEnabled()).toBe(false);
  });

  it('no borra los participantes cargados a mano ni por Twitch', () => {
    saveParticipants([{ id: 'twitch:99', name: 'zulema' }]);
    const list = addTestParticipants();

    expect(list).toHaveLength(1 + 57);
    expect(list[0]!.name).toBe('zulema');
  });

  it('agregar dos veces no duplica', () => {
    const first = addTestParticipants();
    const second = addTestParticipants();
    expect(second).toHaveLength(first.length);
  });

  it('quitar cuando no hay nada de prueba no rompe nada', () => {
    saveParticipants([{ id: 'twitch:1', name: 'fulano' }]);
    expect(removeTestParticipants()).toHaveLength(1);
  });

  it('el ciclo completo es reversible', () => {
    const on = applyTestData(true);
    const off = applyTestData(false);
    const again = applyTestData(true);
    expect(off).toHaveLength(0);
    expect(again).toHaveLength(on.length);
  });
});

describe('upsertParticipant', () => {
  beforeEach(() => {
    setTestDataEnabled(false);
  });

  it('agrega una vez y no repite al mismo id', () => {
    const first = upsertParticipant({ id: 'twitch:1', name: 'fulano' });
    expect(first.added).toBe(true);

    const second = upsertParticipant({ id: 'twitch:1', name: 'fulano' });
    expect(second.added).toBe(false);
    expect(second.list).toHaveLength(1);
  });

  it('permite mismo nombre con distinto id', () => {
    upsertParticipant({ id: 'twitch:1', name: 'fulano' });
    const second = upsertParticipant({ id: 'twitch:2', name: 'fulano' });
    expect(second.added).toBe(true);
    expect(second.list).toHaveLength(2);
  });

  it('avisa cuando la lista esta llena', () => {
    saveParticipants(
      Array.from({ length: MAX_PARTICIPANTS }, (_, i) => ({ id: `x${i}`, name: `n${i}` })),
    );
    const result = upsertParticipant({ id: 'twitch:999', name: 'tarde' });
    expect(result.added).toBe(false);
    expect(result.full).toBe(true);
    expect(result.list).toHaveLength(MAX_PARTICIPANTS);
  });
});

describe('config de twitch', () => {
  it('devuelve los valores por defecto sin datos guardados', () => {
    expect(readTwitchConfig()).toEqual(DEFAULT_TWITCH_CONFIG);
  });

  it('guarda y relee un parche parcial', () => {
    writeTwitchConfig({ channel: 'canalito' });
    writeTwitchConfig({ enabled: true });

    const cfg = readTwitchConfig();
    expect(cfg.channel).toBe('canalito');
    expect(cfg.enabled).toBe(true);
    expect(cfg.command).toBe(DEFAULT_TWITCH_CONFIG.command);
  });

  it('descarta un comando vacio', () => {
    expect(writeTwitchConfig({ command: '   ' }).command).toBe('!entrar');
  });

  it('guarda y relee el filtro de suscriptores', () => {
    expect(writeTwitchConfig({ subscribersOnly: true }).subscribersOnly).toBe(true);
    expect(readTwitchConfig().subscribersOnly).toBe(true);
    expect(writeTwitchConfig({ subscribersOnly: false }).subscribersOnly).toBe(false);
  });

  it('el filtro no pisa los demas campos al cambiarlo', () => {
    writeTwitchConfig({ enabled: true, channel: 'canalito', command: '!entro' });
    writeTwitchConfig({ subscribersOnly: true });

    const cfg = readTwitchConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.channel).toBe('canalito');
    expect(cfg.command).toBe('!entro');
  });

  it('una config vieja sin el campo queda con el filtro apagado', () => {
    // Guardada por una version anterior: el campo no existe y no debe romper.
    localStorage.setItem(
      'tombola:twitch:v1',
      JSON.stringify({ enabled: true, channel: 'canalito', command: '!entrar' }),
    );

    const cfg = readTwitchConfig();
    expect(cfg.subscribersOnly).toBe(false);
    expect(cfg.channel).toBe('canalito');
  });

  it('un filtro con tipo raro cae al default', () => {
    localStorage.setItem(
      'tombola:twitch:v1',
      JSON.stringify({ enabled: true, channel: 'c', command: '!entrar', subscribersOnly: 'si' }),
    );
    expect(readTwitchConfig().subscribersOnly).toBe(false);
  });
});

describe('historial de sorteos', () => {
  function sembrar(): string[] {
    return ['Uno', 'Dos', 'Tres'].map((name) =>
      addDraw({ id: `twitch:${name}`, name }).id,
    );
  }

  it('guarda el ganador mas reciente primero', () => {
    const ids = sembrar();
    expect(listDraws().map((d) => d.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it('borra un registro suelto sin tocar los demas', () => {
    const ids = sembrar();
    const next = deleteDraw(ids[1]);

    expect(next).toHaveLength(2);
    expect(next.map((d) => d.id)).not.toContain(ids[1]);
    expect(next.map((d) => d.id)).toEqual([ids[2], ids[0]]);
  });

  it('borrar un id inexistente no rompe nada', () => {
    sembrar();
    expect(deleteDraw('no-existe')).toHaveLength(3);
  });

  it('clearDraws vacia el historial y deja tocar el store', () => {
    sembrar();
    clearDraws();
    expect(listDraws()).toEqual([]);

    expect(addDraw({ id: 'x', name: 'Otro' }).name).toBe('Otro');
    expect(listDraws()).toHaveLength(1);
  });
});

describe('clearEverything', () => {
  it('borra participantes, historial, twitch y la preferencia de prueba', () => {
    applyTestData(true);
    writeTwitchConfig({ enabled: true, channel: 'canalito' });
    addDraw({ id: 'twitch:1', name: 'fulano' });

    clearEverything();

    expect(localStorage.getItem('tombola:participantes:v1')).toBeNull();
    expect(localStorage.getItem('tombola:sorteos:v1')).toBeNull();
    expect(localStorage.getItem('tombola:twitch:v1')).toBeNull();
    expect(localStorage.getItem('tombola:datosDePrueba:v1')).toBeNull();

    // Vuelve al estado de primera ejecucion.
    expect(readTwitchConfig()).toEqual(DEFAULT_TWITCH_CONFIG);
    expect(isTestDataEnabled()).toBe(true);
  });

  it('vaciar participantes no toca el historial', () => {
    applyTestData(true);
    addDraw({ id: 'twitch:1', name: 'fulano' });
    clearParticipants();

    expect(listParticipants()).toEqual([]);
    expect(listDraws()).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('acorta el nombre para la bola', () => {
    expect(toBallLabel('Valeria Ortiz Mendez')).toBe('Valeria M.');
    expect(toBallLabel('Cher')).toBe('Cher');
  });

  it('ignora duplicados y vacios al importar', () => {
    const out = parseImportText('nombre\nJuan\nJuan\n\n  \nAna\n');
    expect(out.map((p) => p.name)).toEqual(['Juan', 'Ana']);
  });

  it('toma la primera columna de un CSV', () => {
    expect(parseImportText('Juan,Perez\n')[0]?.name).toBe('Juan');
  });
});
