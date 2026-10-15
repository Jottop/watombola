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

  fanfare(): void {
    if (!this.ctx || !this.master || this.settings.muted) return;
    const t = this.now();
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];

    notes.forEach((freq, i) => {
      const at = t + i * 0.085;
      const osc = this.ctx!.createOscillator();
      osc.type = i === notes.length - 1 ? 'triangle' : 'sine';
      osc.frequency.value = freq;

      const gain = this.ctx!.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.26, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + (i === notes.length - 1 ? 0.9 : 0.32));

      osc.connect(gain);
      gain.connect(this.master!);
      osc.start(at);
      osc.stop(at + 1);
    });

    const shimmer = this.ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.setValueAtTime(2093, t + 0.42);
    shimmer.frequency.exponentialRampToValueAtTime(3136, t + 1.1);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t + 0.42);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);

    shimmer.connect(gain);
    gain.connect(this.master);
    shimmer.start(t + 0.42);
    shimmer.stop(t + 1.3);
  }
}
