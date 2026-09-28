import { FRAME_SAMPLES, SAMPLE_RATE } from './audio.js';
import { CaptureClock } from './capture-health.js';
import { addWorkletModule, defaultWorkletModuleUrls } from './worklet-url.js';

export class CaptureStalledError extends Error {
  constructor(message = 'Microphone capture opened but produced no audio frames') {
    super(message);
    this.name = 'CaptureStalledError';
    this.code = 'capture_stalled';
    this.retryable = true;
  }
}

export class CaptureAbortedError extends Error {
  constructor(message = 'Microphone capture was stopped during startup') {
    super(message);
    this.name = 'AbortError';
    this.code = 'capture_aborted';
    this.retryable = true;
  }
}

// SDK-owned mic capture. Exists so the AEC-only front-end spec is the default, not a doc the app
// must re-read: echo cancellation ON, noise suppression + AGC OFF. Browser defaults enable BOTH —
// NS is neutral-to-harmful for the ASR (finding #80: bundled NS +12.5 WER at −15 dB) and AGC
// distorts levels — so an app that hand-rolls getUserMedia({audio:true}) silently degrades the
// loop. Frames come out as 16 kHz 512-sample Float32 via an AudioWorklet resampler.
// `processing:false` opens the mic fully raw (AEC+NS+AGC off): used for the optional raw ablation
// track, and by DialtClient.startMic on WebKit where the SDK's own AEC3 cancels instead.
export class MicCapture {
  constructor({ onFrame, onClockStall, processing = true, workletUrl, deviceId } = {}) {
    this.onFrame = onFrame;
    this.onClockStall = onClockStall;
    this.processing = processing;
    this.deviceId = deviceId || null;
    // The worklet ships with the SDK; apps only override this if their bundler relocates assets.
    // Keep the primary URL literal at this call site: Vite/Rollup/Webpack discover and emit
    // worklet assets from this exact new URL(<literal>, import.meta.url) shape.
    const [defaultWorkletUrl, fallbackWorkletUrl] = defaultWorkletModuleUrls(
      new URL('./mic-worklet.js', import.meta.url), 'mic-worklet.js', import.meta.url,
    );
    this.workletUrl = workletUrl || defaultWorkletUrl;
    this.fallbackWorkletUrl = workletUrl ? null : fallbackWorkletUrl;
    this.context = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.silentSink = null;
    this._startToken = null;
    this._firstFrameReject = null;
  }

  async start({ firstFrameTimeoutMs = 2000 } = {}) {
    if (this.context) return;
    if (!Number.isFinite(firstFrameTimeoutMs) || firstFrameTimeoutMs <= 0) {
      throw new RangeError('firstFrameTimeoutMs must be a positive finite number');
    }
    const token = {};
    this._startToken = token;
    const clock = new CaptureClock();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: this.processing,   // AEC on for the loop; off for the raw track
        noiseSuppression: false,             // AEC-only spec: NS off (neutral-to-harmful for ASR)
        autoGainControl: false,              // AEC-only spec: AGC off (distorts levels)
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
      },
    });
    if (this._startToken !== token) {
      for (const track of stream.getTracks()) track.stop();
      throw new CaptureAbortedError();
    }
    this.stream = stream;
    try {
      this.context = new AudioContext();
      await addWorkletModule(
        this.context.audioWorklet, this.workletUrl, this.fallbackWorkletUrl,
      );
      if (this._startToken !== token) throw new CaptureAbortedError();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, 'voice-loop-mic', {
        processorOptions: { targetRate: SAMPLE_RATE, frameSize: FRAME_SAMPLES,
          clockOriginMs: performance.now() - this.context.currentTime * 1000 },
      });
      this.context.onstatechange = () => {
        if (this.context?.state === 'running') {
          this.worklet?.port.postMessage({
            clockOriginMs: performance.now() - this.context.currentTime * 1000,
          });
        }
      };
      let firstFrameResolve;
      const firstFrame = new Promise((resolve, reject) => {
        firstFrameResolve = resolve;
        this._firstFrameReject = reject;
      });
      this.worklet.port.onmessage = (event) => {
        if (event.data?.type === 'frame') {
          // Frame arrival, not signal amplitude, proves that the capture graph is operational.
          // An all-zero Float32Array is valid silence and must satisfy the startup health gate.
          firstFrameResolve();
          this._firstFrameReject = null;
          const monotonic = globalThis.performance?.now?.();
          const arrivalMs = Number.isFinite(monotonic) ? monotonic : Date.now();
          let captureMs = arrivalMs;
          if (Number.isFinite(event.data.captureMs)) {
            const observed = clock.observe(event.data.captureMs, arrivalMs);
            captureMs = observed.captureMs;
            if (observed.stallMs) this.onClockStall?.(observed.stallMs);
          }
          this.onFrame?.(event.data.frame, captureMs);
        }
      };
      this.silentSink = this.context.createGain();
      this.silentSink.gain.value = 0;
      this.source.connect(this.worklet);
      this.worklet.connect(this.silentSink);
      this.silentSink.connect(this.context.destination);
      await this.context.resume();
      if (this._startToken !== token) throw new CaptureAbortedError();
      let timer;
      try {
        await Promise.race([
          firstFrame,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new CaptureStalledError()), firstFrameTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this._firstFrameReject = null;
      }
    } catch (err) {
      // Partial start (e.g. addModule failed): release the live tracks and the AudioContext, or
      // the mic indicator stays lit and the leaked context counts against Chrome's per-page cap.
      // stop() failing here must not mask the original error or leave `context` set (which
      // would make the started-guard block a retry).
      try { await this.stop(); } catch { this.context = null; this.stream = null; }
      throw err;
    }
  }

  async stop() {
    this._startToken = null;
    this._firstFrameReject?.(new CaptureAbortedError());
    this._firstFrameReject = null;
    const worklet = this.worklet;
    const source = this.source;
    const silentSink = this.silentSink;
    const stream = this.stream;
    const context = this.context;
    // Clear ownership synchronously so concurrent stop/restart calls cannot release a resource
    // twice while AudioContext.close() is awaiting its browser task.
    this.context = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.silentSink = null;
    if (worklet?.port) worklet.port.onmessage = null;
    try { worklet?.disconnect(); } catch { /* already disconnected */ }
    try { source?.disconnect(); } catch { /* already disconnected */ }
    try { silentSink?.disconnect(); } catch { /* already disconnected */ }
    for (const track of stream?.getTracks() || []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    if (context && context.state !== 'closed') {
      try { await context.close(); } catch { /* release references even if the browser rejects */ }
    }
  }
}
