type Osc = OscillatorNode;

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
  private spinOsc: Osc | null = null;
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
    if (!this.ctx || !this.master || !this.noise || this.settings.muted) return;
    this.stopSpin();

    const t = this.now();

    this.spinSource = this.ctx.createBufferSource();
    this.spinSource.buffer = this.noise;
    this.spinSource.loop = true;

    this.spinFilter = this.ctx.createBiquadFilter();
    this.spinFilter.type = 'bandpass';
    this.spinFilter.frequency.value = 180;
    this.spinFilter.Q.value = 1.1;

    this.spinGain = this.ctx.createGain();
    this.spinGain.gain.setValueAtTime(0.0001, t);
    this.spinGain.gain.exponentialRampToValueAtTime(0.32, t + 0.7);

    this.spinSource.connect(this.spinFilter);
    this.spinFilter.connect(this.spinGain);
    this.spinGain.connect(this.master);
    this.spinSource.start();

    this.spinOsc = this.ctx.createOscillator();
    this.spinOsc.type = 'sawtooth';
    this.spinOsc.frequency.value = 62;

    const oscGain = this.ctx.createGain();
    oscGain.gain.setValueAtTime(0.0001, t);
    oscGain.gain.exponentialRampToValueAtTime(0.09, t + 0.8);

    const oscFilter = this.ctx.createBiquadFilter();
    oscFilter.type = 'lowpass';
    oscFilter.frequency.value = 420;

    this.spinOsc.connect(oscFilter);
    oscFilter.connect(oscGain);
    oscGain.connect(this.master);
    this.spinOsc.start();
  }

  /** t en [0,1]: abre el filtro para que la tension suba mientras gira. */
  updateSpin(t: number): void {
    if (!this.ctx || !this.spinFilter || !this.spinOsc) return;
    const now = this.now();
    this.spinFilter.frequency.setTargetAtTime(180 + t * 900, now, 0.25);
    this.spinOsc.frequency.setTargetAtTime(62 + t * 46, now, 0.25);
  }

  stopSpin(): void {
    if (!this.ctx) return;
    const t = this.now();

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
    if (this.spinOsc) {
      try {
        this.spinOsc.stop(t + 0.5);
      } catch {
        /* ya detenido */
      }
    }
    this.spinSource = null;
    this.spinGain = null;
    this.spinFilter = null;
    this.spinOsc = null;
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

  /** Impacto contra el borde del bombo, con limite de tasa. */
  tick(intensity = 1): void {
    if (!this.ctx || !this.master || this.settings.muted) return;
    // Sin agitacion no hay golpe que sonar. Ademas WebAudio tira RangeError si
    // exponentialRampToValueAtTime recibe 0, asi que nunca puede quedar en 0.
    if (intensity <= 0.02) return;

    const t = this.now();
    if (t - this.lastTick < 0.11) return;
    this.lastTick = t;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 900 + Math.random() * 500;

    const gain = this.ctx.createGain();
    const peak = Math.max(0.004, 0.03 * Math.min(1, intensity));
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.07);
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
