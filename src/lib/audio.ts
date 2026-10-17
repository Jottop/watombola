export interface AudioSettings {
  volume: number;
  muted: boolean;
}

/**
 * Todo el audio es sintetizado con WebAudio: cero archivos, cero licencias y
 * se puede re-armonizar cambiando numeros.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private spinSource: AudioBufferSourceNode | null = null;
  private spinGain: GainNode | null = null;
  private spinFilter: BiquadFilterNode | null = null;
  private spinLfo: OscillatorNode | null = null;
  private spinLfoAmount: GainNode | null = null;
  private lastTick = 0;

  private settings: AudioSettings = { volume: 0.7, muted: false };

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  get config(): AudioSettings {
    return { ...this.settings };
  }

  apply(settings: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...settings };
    if (this.master && this.ctx) {
      const target = this.settings.muted ? 0 : this.settings.volume;
      this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
  }

  /** Debe llamarse desde un gesto del usuario: OBS bloquea el audio hasta entonces. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;

      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.settings.muted ? 0 : this.settings.volume;
      this.master.connect(this.ctx.destination);
      this.noise = this.makeNoise(this.ctx);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      // ruido marron: mas grave y menos siseo que el blanco
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    return buffer;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  startSpin(): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise || this.settings.muted) return;
    this.stopSpin();

    const t = ctx.currentTime;

    // Base leve de giro: ruido marron filtrado con una oscilacion lenta de volumen.
    // Queda por debajo de los rebotes y no usa un sierra agresivo.
    this.spinSource = ctx.createBufferSource();
    this.spinSource.buffer = noise;
    this.spinSource.loop = true;

    this.spinFilter = ctx.createBiquadFilter();
    this.spinFilter.type = 'bandpass';
    this.spinFilter.frequency.value = 140;
    this.spinFilter.Q.value = 0.8;

    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 300;

    this.spinGain = ctx.createGain();
    this.spinGain.gain.setValueAtTime(0.0001, t);
    this.spinGain.gain.exponentialRampToValueAtTime(0.12, t + 0.9);

    this.spinLfo = ctx.createOscillator();
    this.spinLfo.type = 'sine';
    this.spinLfo.frequency.value = 0.7;

    this.spinLfoAmount = ctx.createGain();
    this.spinLfoAmount.gain.value = 0.035;

    this.spinSource.connect(this.spinFilter);
    this.spinFilter.connect(body);
    body.connect(this.spinGain);
    this.spinGain.connect(master);
    this.spinLfo.connect(this.spinLfoAmount);
    this.spinLfoAmount.connect(this.spinGain.gain);
    this.spinSource.start();
    this.spinLfo.start();
  }

  /** t en [0,1]: abre un poco el filtro y acelera la oscilacion del giro. */
  updateSpin(t: number): void {
    const ctx = this.ctx;
    const filter = this.spinFilter;
    const lfo = this.spinLfo;
    if (!ctx || !filter || !lfo) return;
    const progress = Math.min(1, Math.max(0, t));
    const now = ctx.currentTime;
    filter.frequency.setTargetAtTime(140 + progress * 520, now, 0.25);
    lfo.frequency.setTargetAtTime(0.6 + progress * 1.5, now, 0.25);
  }

  stopSpin(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;

    if (this.spinGain) {
      this.spinGain.gain.cancelScheduledValues(t);
      this.spinGain.gain.setTargetAtTime(0.0001, t, 0.12);
    }
    if (this.spinSource) {
      try {
        this.spinSource.stop(t + 0.5);
      } catch {
        /* ya detenido */
      }
    }
    if (this.spinLfoAmount) {
      this.spinLfoAmount.gain.cancelScheduledValues(t);
      this.spinLfoAmount.gain.setTargetAtTime(0.0001, t, 0.08);
    }
    if (this.spinLfo) {
      try {
        this.spinLfo.stop(t + 0.5);
      } catch {
        /* ya detenido */
      }
    }
    this.spinSource = null;
    this.spinGain = null;
    this.spinFilter = null;
    this.spinLfo = null;
    this.spinLfoAmount = null;
  }

  /** Golpe seco al sacar una bola. `step` 0..1 sube el tono a lo largo del sorteo. */
  pop(step: number): void {
    if (!this.ctx || !this.master || this.settings.muted) return;
    const t = this.now();

    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    const base = 420 * 2 ** (step * 0.9);
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.45, t + 0.16);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  /**
   * Golpe leve al sacudir el bombo a mano (tecla R). Un cuerpo grave corto y un
   * roce sordo, mas bajo y apagado que un rebote para que no compita con el
   * sonido del sorteo.
   */
  knock(): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise || this.settings.muted) return;
    const t = ctx.currentTime;

    const body = ctx.createOscillator();
    body.type = 'sine';
    const low = 150 + Math.random() * 40;
    body.frequency.setValueAtTime(low, t);
    body.frequency.exponentialRampToValueAtTime(low * 0.6, t + 0.18);

    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.18, t + 0.012);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);

    const thud = ctx.createBufferSource();
    thud.buffer = noise;
    thud.playbackRate.value = 0.7;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 320;
    band.Q.value = 1.1;

    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, t);
    thudGain.gain.exponentialRampToValueAtTime(0.1, t + 0.008);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

    body.connect(bodyGain);
    bodyGain.connect(master);
    thud.connect(band);
    band.connect(thudGain);
    thudGain.connect(master);

    body.start(t);
    body.stop(t + 0.3);
    thud.start(t, Math.random() * 1.5);
    thud.stop(t + 0.22);
  }

  /**
   * Rebote entre bolas.
   *
   * Cada impacto combina cuerpo grave, resonancia media y ataque agudo para que
   * se distinga del fondo del giro. La densidad y el nivel siguen la agitacion.
   */
  tick(intensity = 1): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise || this.settings.muted) return;
    // Sin agitacion no hay golpe que sonar. Ademas WebAudio tira RangeError si
    // exponentialRampToValueAtTime recibe 0, asi que nunca puede quedar en 0.
    if (!Number.isFinite(intensity) || intensity <= 0.02) return;

    const strength = Math.min(1, Math.max(0, intensity));
    const voice = 0.35 + 0.65 * strength;
    const t = ctx.currentTime;
    const gap = 0.09 - 0.055 * voice;
    if (t - this.lastTick < gap) return;
    this.lastTick = t;

    const bodyDecay = 0.1 + Math.random() * 0.05;
    const bodyPeak = Math.max(0.004, 0.3 * voice);
    const resonancePeak = Math.max(0.004, 0.18 * voice);
    const pingPeak = Math.max(0.004, 0.1 * voice);

    // Cuerpo del choque.
    const body = ctx.createOscillator();
    body.type = 'sine';
    const low = 300 + Math.random() * 220;
    body.frequency.setValueAtTime(low, t);
    body.frequency.exponentialRampToValueAtTime(low * 0.45, t + bodyDecay);

    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(bodyPeak, t + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + bodyDecay);

    // Resonancia hueca en la zona donde el ruido marron tiene mas energia.
    const knock = ctx.createBufferSource();
    knock.buffer = noise;
    knock.playbackRate.value = 0.8 + Math.random() * 0.7;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 750 + Math.random() * 650;
    band.Q.value = 1.7;

    const knockGain = ctx.createGain();
    const resonanceDecay = bodyDecay * 0.65;
    knockGain.gain.setValueAtTime(0.0001, t);
    knockGain.gain.exponentialRampToValueAtTime(resonancePeak, t + 0.004);
    knockGain.gain.exponentialRampToValueAtTime(0.0001, t + resonanceDecay);

    // Ataque corto para que cada rebote tenga definicion.
    const ping = ctx.createOscillator();
    ping.type = 'triangle';
    ping.frequency.value = 1500 + Math.random() * 900;

    const pingGain = ctx.createGain();
    const pingDecay = 0.035;
    pingGain.gain.setValueAtTime(0.0001, t);
    pingGain.gain.exponentialRampToValueAtTime(pingPeak, t + 0.003);
    pingGain.gain.exponentialRampToValueAtTime(0.0001, t + pingDecay);

    body.connect(bodyGain);
    bodyGain.connect(master);
    knock.connect(band);
    band.connect(knockGain);
    knockGain.connect(master);
    ping.connect(pingGain);
    pingGain.connect(master);

    body.start(t);
    body.stop(t + bodyDecay + 0.05);
    knock.start(t, Math.random() * 1.5);
    knock.stop(t + resonanceDecay + 0.05);
    ping.start(t);
    ping.stop(t + pingDecay + 0.02);
  }

  /**
   * Fanfarria del ganador, estilo casino.
   *
   * Una corrida rapida de campanillas que desemboca en un acorde brillante y unos
   * destellos, como una tragamonedas que paga. Cada campanilla mezcla el tono
   * base con un parcial inarmonico (x2.76): asi suena a metal y no a nota pura.
   */
  fanfare(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.settings.muted) return;
    const t = ctx.currentTime;

    const bell = (freq: number, at: number, dur: number, peak: number): void => {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      gain.connect(master);

      const tone = ctx.createOscillator();
      tone.type = 'sine';
      tone.frequency.value = freq;
      tone.connect(gain);
      tone.start(at);
      tone.stop(at + dur + 0.05);

      // Parcial inarmonico: es lo que le da el timbre metalico a la campanilla.
      const overtone = ctx.createOscillator();
      overtone.type = 'sine';
      overtone.frequency.value = freq * 2.76;

      const overtoneGain = ctx.createGain();
      overtoneGain.gain.setValueAtTime(0.0001, at);
      overtoneGain.gain.exponentialRampToValueAtTime(peak * 0.5, at + 0.004);
      overtoneGain.gain.exponentialRampToValueAtTime(0.0001, at + dur * 0.55);

      overtone.connect(overtoneGain);
      overtoneGain.connect(master);
      overtone.start(at);
      overtone.stop(at + dur + 0.05);
    };

    // Corrida ascendente de campanillas.
    const run = [659.25, 783.99, 987.77, 1174.66, 1318.51, 1567.98, 1975.53];
    run.forEach((freq, i) => bell(freq, t + i * 0.055, 0.28, 0.13));

    // Acorde final brillante, sostenido.
    const chordAt = t + run.length * 0.055 + 0.02;
    [1046.5, 1318.51, 1567.98, 2093].forEach((freq) => bell(freq, chordAt, 0.9, 0.12));

    // Destellos sueltos encima del acorde, como monedas cayendo.
    for (let i = 0; i < 4; i++) {
      bell(2093 + Math.random() * 1568, chordAt + 0.05 + i * 0.055, 0.18, 0.05);
    }
  }
}
