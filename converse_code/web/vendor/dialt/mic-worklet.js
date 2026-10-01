class VoiceLoopMicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.sourceRate = sampleRate;
    this.frameSize = options.processorOptions?.frameSize || 512;
    this.buffer = [];
    this.sourcePos = 0;
    this.carry = 0;   // last sample of the previous block (seamless interpolation across blocks)
    this.clockOriginMs = options.processorOptions?.clockOriginMs || 0;
    this.bufferTimeMs = null;
    this.port.onmessage = (event) => {
      if (Number.isFinite(event.data?.clockOriginMs)) this.clockOriginMs = event.data.clockOriginMs;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      return true;
    }

    const mono = this.mixToMono(input);
    // Timestamp the first buffered sample on the audio thread, before main-thread delivery.
    if (this.bufferTimeMs === null) this.bufferTimeMs = currentTime * 1000;
    if (this.sourceRate === this.targetRate) {
      this.pushSamples(mono);
    } else {
      this.resampleAndPush(mono);
    }
    this.flushFrames();
    return true;
  }

  mixToMono(channels) {
    if (channels.length === 1) {
      return channels[0];
    }
    const n = channels[0].length;
    const out = new Float32Array(n);
    for (let ch = 0; ch < channels.length; ch += 1) {
      const data = channels[ch];
      for (let i = 0; i < n; i += 1) out[i] += data[i] / channels.length;
    }
    return out;
  }

  // Carrying the previous block's last sample lets read positions near a block seam interpolate
  // across it — without it, non-integer ratios (44.1 kHz mics) clamp the read position at every
  // 128-sample block and drop/repeat samples, roughening the STT/barge-VAD uplink. Branch-indexed
  // (no per-block allocation): this runs on the realtime audio thread every ~3 ms.
  resampleAndPush(input) {
    const ratio = this.sourceRate / this.targetRate;
    const n = input.length;
    while (this.sourcePos < n) {
      // Read position sits between carry⌢input[pos-1] and input[pos] — position 0 is the seam.
      const i = Math.floor(this.sourcePos);
      const frac = this.sourcePos - i;
      const a = i === 0 ? this.carry : input[i - 1];
      const b = input[i];
      this.buffer.push(a + (b - a) * frac);
      this.sourcePos += ratio;
    }
    this.sourcePos -= n;
    this.carry = input[n - 1];
  }

  pushSamples(input) {
    for (let i = 0; i < input.length; i += 1) this.buffer.push(input[i]);
  }

  flushFrames() {
    while (this.buffer.length >= this.frameSize) {
      const frame = new Float32Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i += 1) frame[i] = this.buffer.shift();
      const captureMs = this.clockOriginMs + this.bufferTimeMs;
      this.bufferTimeMs += this.frameSize / this.targetRate * 1000;
      this.port.postMessage({ type: "frame", frame, captureMs }, [frame.buffer]);
    }
  }
}

registerProcessor("voice-loop-mic", VoiceLoopMicProcessor);
