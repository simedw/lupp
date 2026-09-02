export const SPEECH_SILENCE_GRACE_MS = 2000;

export type SpeechSegment = { frames: Float32Array[]; sampleRate: number; durationMs: number; endedAt: number };
type VoiceCallbacks = {
  now(): number;
  onLevel(level: number): void;
  onSpeechStart(event: { startedAt: number }): void;
  onSpeechEnd(segment: SpeechSegment): void;
  onDiscard(durationMs: number): void;
};

export class VoiceCapture {
  callbacks: VoiceCallbacks;
  stream: MediaStream | null;
  context: AudioContext | null;
  processor: ScriptProcessorNode | null;
  speaking: boolean;
  muted: boolean;
  noiseFloor: number;
  preRoll: Float32Array[];
  frames: Float32Array[];
  silenceMs: number;
  lastVoiceFrame: number;

  constructor(callbacks: VoiceCallbacks) {
    this.callbacks = callbacks;
    this.stream = null;
    this.context = null;
    this.processor = null;
    this.speaking = false;
    this.muted = true;
    this.noiseFloor = 0.004;
    this.preRoll = [];
    this.frames = [];
    this.silenceMs = 0;
    this.lastVoiceFrame = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.context = new AudioContext();
    const source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => this.process(event.inputBuffer.getChannelData(0));
    source.connect(this.processor);
    this.processor.connect(this.context.destination);
    this.muted = false;
  }

  process(input: Float32Array) {
    if (!this.context) return;
    const sampleRate = this.context.sampleRate;
    const frame = new Float32Array(input);
    let energy = 0;
    for (const sample of frame) energy += sample * sample;
    const rms = Math.sqrt(energy / frame.length);
    const frameMs = frame.length / this.context.sampleRate * 1000;
    const threshold = Math.max(0.012, this.noiseFloor * 3.2);
    const voiced = !this.muted && rms > threshold;
    this.callbacks.onLevel(Math.min(1, rms / Math.max(threshold * 2.5, .035)));

    if (!this.speaking) {
      if (!voiced) this.noiseFloor = this.noiseFloor * .985 + rms * .015;
      this.preRoll.push(frame);
      const maxPreRoll = Math.max(1, Math.ceil(500 / frameMs));
      if (this.preRoll.length > maxPreRoll) this.preRoll.shift();
      if (!voiced) return;
      this.speaking = true;
      // The current voiced frame is already in the pre-roll.
      this.frames = [...this.preRoll];
      this.lastVoiceFrame = this.frames.length;
      this.silenceMs = 0;
      const preRollMs = this.preRoll.reduce((sum, item) => sum + item.length / sampleRate * 1000, 0);
      this.callbacks.onSpeechStart({ startedAt: Math.max(0, this.callbacks.now() - preRollMs) });
      return;
    }

    this.frames.push(frame);
    if (voiced) {
      this.lastVoiceFrame = this.frames.length;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
      if (this.silenceMs >= SPEECH_SILENCE_GRACE_MS) this.finalize();
    }
  }

  finalize() {
    if (!this.speaking || !this.context) return;
    const sampleRate = this.context.sampleRate;
    const tailFrames = Math.ceil(.15 * this.context.sampleRate / this.frames[0].length);
    const frames = this.frames.slice(0, Math.min(this.frames.length, this.lastVoiceFrame + tailFrames));
    const durationMs = frames.reduce((sum, frame) => sum + frame.length / sampleRate * 1000, 0);
    this.speaking = false;
    this.frames = [];
    this.preRoll = [];
    this.lastVoiceFrame = 0;
    this.silenceMs = 0;
    if (durationMs < 1000) this.callbacks.onDiscard(durationMs);
    else this.callbacks.onSpeechEnd({ frames, sampleRate: this.context.sampleRate, durationMs, endedAt: this.callbacks.now() });
  }

  setMuted(muted: boolean) {
    if (muted && this.speaking) this.finalize();
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() || []) track.enabled = !muted;
    this.callbacks.onLevel(0);
  }

  async stop() {
    if (this.speaking) this.finalize();
    this.processor?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.stream = null;
    this.context = null;
    this.muted = true;
  }
}
