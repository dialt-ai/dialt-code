import { SAMPLE_RATE } from './audio.js';

// Capture health: whether the microphone is actually capturing, and a capture clock that stays on
// the page clock when it is not. Both exist because WebKit can stop the audio thread and hand
// over digital silence after the first frame has arrived (field sessions 8200d587, 99cc423c,
// 94a1e316: two ~0.8 s audio-thread stalls bracketing ~2.5 s of exact zeros, shortly after
// capture opened). The first frame alone therefore does not prove the microphone is live.

// A persistent rise this large in the arrival-minus-capture floor is capture time the audio
// thread lost. It sits well above worklet delivery jitter and slow clock drift, and below the
// 0.65-0.8 s stalls seen in the field.
export const CLOCK_STALL_MS = 150;
// The floor is the minimum over this much arrival time. A main-thread pause delays frames and
// then delivers them in a burst whose last frame is back on the floor, so the window always
// contains an on-time frame; an audio-thread stall has no burst, so every later frame is late.
export const CLOCK_WINDOW_MS = 500;
// No frame for this long while the page itself kept running means the audio thread stopped.
export const CAPTURE_GAP_MS = 300;
// This much captured digital silence on a raw capture means the device stopped delivering audio.
export const CAPTURE_SILENCE_MS = 300;
const WATCHDOG_MS = 100;
// A watchdog tick this late means the page was paused too, so a frame gap is not evidence.
const WATCHDOG_LATE_MS = 150;

// Worklet timestamps advance by sample count, so time the audio thread never rendered vanishes
// from them and every later frame is stamped early by the stall. This re-anchors the stamps to
// the page clock so the uplink keeps the documented capture_clock_v1 contract (page monotonic
// time) and the recorder renders the stall as a gap instead of pulling later audio earlier.
// The correction lands CLOCK_WINDOW_MS after capture resumes, so the recorder places that
// window's audio early by the stall and inserts the gap after it; timing is right from then on.
export class CaptureClock {
  constructor() {
    this._offsetMs = 0;
    this._floorMs = Infinity;   // lowest arrival-minus-capture lag seen: the pipeline's own delay
    this._window = [];          // [arrivalMs, lagMs] over the last CLOCK_WINDOW_MS of arrivals
  }

  // Returns the corrected capture time and the capture time recovered on this frame (ms).
  observe(captureMs, arrivalMs) {
    const corrected = captureMs + this._offsetMs;
    const lag = arrivalMs - corrected;
    if (lag < this._floorMs) this._floorMs = lag;
    const win = this._window;
    win.push([arrivalMs, lag]);
    while (win.length > 1 && arrivalMs - win[1][0] >= CLOCK_WINDOW_MS) win.shift();
    if (arrivalMs - win[0][0] < CLOCK_WINDOW_MS) return { captureMs: corrected, stallMs: 0 };
    let windowFloor = Infinity;
    for (const [, windowLag] of win) windowFloor = Math.min(windowFloor, windowLag);
    const stallMs = windowFloor - this._floorMs;
    if (stallMs < CLOCK_STALL_MS) return { captureMs: corrected, stallMs: 0 };
    this._offsetMs += stallMs;
    this._window = [];
    return { captureMs: corrected + stallMs, stallMs };
  }
}

// Digital silence: most samples exactly zero. A live device opened without processing has a
// noise floor, so its samples are essentially never exactly zero; a frame that is mostly zeros
// means the device is not delivering audio (a stray nonzero sample does not change that).
// Processed audio can legitimately go to zero (AEC suppressing echo), so only raw captures use it.
export function isDigitalSilence(frame) {
  let zeros = 0;
  for (let i = 0; i < frame.length; i += 1) if (frame[i] === 0) zeros += 1;
  return zeros * 2 > frame.length;
}

// 'warming' until capture is proven live, 'healthy' while it is, 'interrupted' when it stops:
// no frames for CAPTURE_GAP_MS (the audio thread stopped) or, on a raw capture, CAPTURE_SILENCE_MS
// of digital silence (frames flow but the device delivers nothing). Proof of life is any frame,
// or on a raw capture a frame that is not digital silence. A raw capture that stays silent for
// signalTimeoutMs while frames flow is accepted as unverified and the silence rule is dropped
// for it: that device evidently outputs digital silence in a quiet room.
export class CaptureHealth {
  constructor({
    requireSignal, signalTimeoutMs, onChange,
    now = () => performance.now(), timers = globalThis,
  }) {
    this.requireSignal = requireSignal;
    this.signalTimeoutMs = signalTimeoutMs;
    this.onChange = onChange;
    this._now = now;
    this._timers = timers;
    this.state = 'warming';
    this.detail = {};
    this._timer = null;
    this._lastFrameMs = null;
    this._lastTickMs = null;
    this._awaitingSinceMs = null;
    this._silentMs = 0;   // current run of digital silence, in captured audio time
  }

  start() {
    const t = this._now();
    this._lastTickMs = t;
    this._awaitingSinceMs = t;
    this._timer = this._timers.setInterval(() => this._tick(), WATCHDOG_MS);
    this._timer?.unref?.();   // Node: never keep a process alive for a capture watchdog
  }

  stop() {
    if (this._timer != null) this._timers.clearInterval(this._timer);
    this._timer = null;
  }

  frame(frame) {
    this._lastFrameMs = this._now();
    const silent = this.requireSignal && isDigitalSilence(frame);
    this._silentMs = silent ? this._silentMs + (frame.length / SAMPLE_RATE) * 1000 : 0;
    if (this.state === 'healthy') {
      if (this._silentMs >= CAPTURE_SILENCE_MS) this._interrupt('capture_silent');
    } else if (!silent) {
      this._set('healthy', {});
    }
  }

  _tick() {
    const t = this._now();
    const late = t - this._lastTickMs > WATCHDOG_LATE_MS;
    this._lastTickMs = t;
    if (late || this._lastFrameMs == null) return;
    const flowing = t - this._lastFrameMs <= CAPTURE_GAP_MS;
    if (this.state === 'healthy') {
      if (!flowing) this._interrupt('capture_stall');
    } else if (this.requireSignal && flowing && t - this._awaitingSinceMs >= this.signalTimeoutMs) {
      this.requireSignal = false;
      this._set('healthy', { signal_unverified: true });
    }
  }

  _interrupt(code) {
    this._awaitingSinceMs = this._now();
    this._set('interrupted', { code });
  }

  _set(state, detail) {
    this.state = state;
    this.detail = detail;
    this.onChange?.(state, detail);
  }
}
