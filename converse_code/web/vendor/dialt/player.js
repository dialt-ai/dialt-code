import { SAMPLE_RATE } from './audio.js';

// Initial buffer before playback starts (and on recovery after an underrun) to absorb
// network jitter from the streamed TTS. Trades a little first-audio latency for gap-free
// playback. 100 ms suits the binary WebSocket transport.
const JITTER_LEAD = 0.1;

// How far ahead of the playhead we keep audio scheduled. Committing only a small horizon keeps
// clear() (barge/interrupt) responsive — little audio is locked into already-started sources.
const SCHEDULE_AHEAD = 0.2;
// Hidden tabs throttle setInterval to ~1 Hz (and the AudioContext keeps running), so the visible
// horizon starves playback into 0.2 s bursts with ~0.8 s gaps. When the page is hidden, commit a
// horizon comfortably past one throttled tick instead. clear() stays sound at any horizon — it
// stops every tracked source, started or not — so the only cost is barge fade granularity in a
// tab nobody is looking at.
const HIDDEN_SCHEDULE_AHEAD = 2.5;
const TICK_MS = 25;

// clear() fades the master bus out over this long before stopping sources — a hard stop() cuts
// the waveform mid-sample and pops audibly (canceled/reset/reconnect). Must stay well under
// JITTER_LEAD so audio enqueued right after a clear starts at full gain.
const CLEAR_FADE = 0.025;

// Streaming PCM player for gapless assistant audio.
//
//   enqueue(samples) — append assistant audio (16 kHz f32) to the play queue.
//   clear()          — discard queued audio (a barge/interrupt) and stop playing now.
//   stop()           — clear() + tear down (full stop / disconnect).
// Playback intentionally remains a unity-gain AudioContext path. Physical output routing, maximum
// loudness, and full-duplex attenuation belong to the browser/OS; WebKit device tests found no
// reliable web override. Do not add software boost, output-route switching, or audio-session
// manipulation here. Native media integrations are the boundary for route guarantees.
export class StreamingPlayer {
  constructor() {
    this.onScheduled = null;
    this.onCleared = null;
    this.context = null;
    this.master = null;      // master gain bus — lets clear() fade out instead of popping
    this.ratio = 1;          // ctxRate / SAMPLE_RATE
    this.phase = 0;          // carried fractional read position across chunks (resampler)
    this.carry = 0;          // last input sample of the previous chunk (seamless interpolation)
    this.fadeEnd = 0;        // ctx time a clear()'s fade completes — new audio never starts inside it
    this.queue = [];         // Float32Array chunks at 16 kHz, awaiting scheduling
    this.held = [];          // exact native-rate tails, replayed before unscheduled PCM
    this.holdId = null;
    this.nextTime = 0;       // ctx time of the next sample to schedule
    // Reply-audio starvation telemetry: an underrun is the reply queue draining mid-reply and
    // playback re-buffering. Session totals; takePlaybackStats() reads and resets them, so the
    // client can attribute a window (one reply) and report it upstream. Purely observational.
    this._replyAudioScheduled = false;   // a reply chunk was scheduled since markReplyStart()
    this._stats = { underruns: 0, starved_ms: 0, max_gap_ms: 0 };
    this.scheduled = [];     // in-flight sources (see module comment)
    this.timer = null;
    this._onVisibility = () => this._schedule();
  }

  async ensureContext() {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.ratio = this.context.sampleRate / SAMPLE_RATE;
      this.phase = 0;
      this.carry = 0;
      this.fadeEnd = 0;
      this.nextTime = this.context.currentTime;
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  // Continuous linear resample of a 16 kHz chunk up to the context's native rate, carrying the
  // fractional read position AND the previous chunk's last sample across chunks — read positions
  // near a chunk seam interpolate across it instead of flat-holding (an audible tick per chunk).
  _resample(input) {
    if (this.ratio === 1) return Float32Array.from(input);
    const step = 1 / this.ratio;
    const n = input.length;
    const out = new Float32Array(Math.ceil((n - this.phase) / step) + 1);
    let pos = this.phase;
    let k = 0;
    while (pos < n) {
      // Read position pos sits between carry⌢input[pos-1] and input[pos] — position 0 is the seam.
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i === 0 ? this.carry : input[i - 1];
      const b = input[i];
      out[k++] = a + (b - a) * frac;
      pos += step;
    }
    this.phase = pos - n; // remainder feeds the start of the next chunk
    this.carry = input[n - 1];
    return k === out.length ? out : out.subarray(0, k);
  }

  async enqueue(samples) {
    if (!samples || samples.length === 0) return;
    const epoch = this._enqueueEpoch;
    await this.ensureContext();
    if (epoch !== this._enqueueEpoch) return;
    this.queue.push(Float32Array.from(samples));
    this._ensureTimer();
    this._schedule();
  }

  /** A reply boundary (`turn`): underruns before any of this reply's audio belong to no reply. */
  markReplyStart() {
    this._replyAudioScheduled = false;
  }

  /** Read and reset the starvation counters (see the constructor note). */
  takePlaybackStats() {
    const out = { underruns: this._stats.underruns,
                  starved_ms: Math.round(this._stats.starved_ms),
                  max_gap_ms: Math.round(this._stats.max_gap_ms) };
    this._stats = { underruns: 0, starved_ms: 0, max_gap_ms: 0 };
    return out;
  }

  // Schedule queued PCM up to SCHEDULE_AHEAD past the playhead. Each call drains whole chunks
  // off the front of the queue into a BufferSource.
  _schedule() {
    if (!this.context || this.holdId !== null) return;
    const now = this.context.currentTime;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    // Re-buffer JITTER_LEAD when the queue had drained (first chunk or underrun) — and never
    // start inside a clear()'s fade, however the two constants are tuned relative to each other.
    if (this.nextTime <= now) {
      if (this.queue.length && this._replyAudioScheduled) {
        // Mid-reply drain: the playhead passed the last scheduled reply sample before the next
        // chunk arrived. The gap is how long the speaker starved (plus the re-buffer lead).
        const gap = (now - this.nextTime) * 1000;
        this._stats.underruns += 1;
        this._stats.starved_ms += gap;
        if (gap > this._stats.max_gap_ms) this._stats.max_gap_ms = gap;
      }
      this.nextTime = Math.max(now + JITTER_LEAD, this.fadeEnd);
    }
    const horizon = hidden ? HIDDEN_SCHEDULE_AHEAD : SCHEDULE_AHEAD;
    while (this.held.length && this.nextTime < now + horizon) {
      const { data, src } = this.held.shift();
      this._scheduleChunk(src, data);
    }
    if (this.held.length) return;
    while (this.queue.length && this.nextTime < now + horizon) {
      const src = this.queue.shift();
      this._scheduleChunk(src);
    }
  }

  _scheduleChunk(src, retainedData = null) {
    this._replyAudioScheduled = true;
    const now = this.context.currentTime;
    const data = retainedData ?? this._resample(src);
    if (!data.length) return;
    const buffer = this.context.createBuffer(1, data.length, this.context.sampleRate);
    buffer.copyToChannel(data, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    const startAt = Math.max(now, this.nextTime);
    source.start(startAt);
    this.onScheduled?.(src, startAt);
    this.nextTime = startAt + buffer.duration;
    const entry = { source, startAt, endAt: this.nextTime, data, src };
    this.scheduled.push(entry);
    source.onended = () => { this.scheduled = this.scheduled.filter((e) => e !== entry); };
  }

  pendingMs() {
    if (!this.context) return 0;
    const now = this.context.currentTime;
    const replyEnd = this.scheduled.reduce((end, entry) => Math.max(end, entry.endAt), 0);
    const scheduled = replyEnd > now ? Math.max(0, this.nextTime - now) : 0;
    const queued = this.queue.reduce((s, c) => s + c.length, 0) / SAMPLE_RATE;
    const held = this.held.reduce((s, c) => s + c.data.length, 0) / this.context.sampleRate;
    return (scheduled + queued + held) * 1000;
  }

  // Stop at the current sample cursor, retaining the exact rendered native-rate tail.
  pause(holdId) {
    if (this.holdId !== null) return this.holdId === holdId;
    this.holdId = holdId;
    const ctx = this.context;
    if (!ctx) return true;
    const now = ctx.currentTime;
    const tails = [];
    for (const e of this.scheduled) {
      if (e.endAt > now) {
        const offset = Math.min(e.data.length, Math.max(0,
          Math.ceil((now - e.startAt) * ctx.sampleRate)));
        const refOffset = Math.min(e.src.length, Math.max(0,
          Math.ceil((now - e.startAt) * SAMPLE_RATE)));
        tails.push({ data: e.data.slice(offset), src: e.src.slice(refOffset) });
      }
      try { e.source.stop(now); } catch { /* already ended */ }
    }
    this.held = [...tails, ...this.held];
    this.scheduled = [];
    this.nextTime = now;
    this.onCleared?.(now);
    return true;
  }

  resume(holdId) {
    if (this.holdId !== holdId) return false;
    this.holdId = null;
    // A deliberate hold is not an underrun.
    this.nextTime = Math.max((this.context?.currentTime ?? 0) + JITTER_LEAD, this.fadeEnd);
    this._schedule();
    return true;
  }

  // Device output latency (context clock -> speaker), in ms.
  deviceLatencyMs() {
    if (!this.context) return 0;
    return (this.context.outputLatency || this.context.baseLatency || 0) * 1000;
  }

  // Time to actual silence at the speaker if nothing else happens: pending playout plus the
  // device output latency. This is what the server timestamps to measure the stop half of
  // barge latency.
  remainingMs() {
    return this.pendingMs() + this.deviceLatencyMs();
  }

  _ensureTimer() {
    if (this.timer != null) return;
    this.timer = setInterval(() => this._schedule(), TICK_MS);
    // Top up the schedule the instant the tab hides — the first throttled tick can be a full
    // second away, which would otherwise leave a one-off gap at the visibility transition.
    // (visibilitychange itself fires unthrottled; document is absent under node tests.)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  _clearTimer() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
  }

  // Discard queued audio (barge/interrupt) and stop playing — via a short master-bus fade, so
  // the cut lands on silence instead of popping mid-waveform. `fadeS` overrides the fade for a
  // barge hard-clear (~150 ms reads as a yield, not a glitch); the default stays pop-guard short.
  clear(fadeS = CLEAR_FADE) {
    this.holdId = null;
    this.held = [];
    this._enqueueEpoch = (this._enqueueEpoch ?? 0) + 1;
    this.queue = [];
    this.phase = 0;
    this.carry = 0;
    const ctx = this.context;
    if (ctx && this.scheduled.length) {
      const now = ctx.currentTime;
      const stopAt = now + fadeS;
      const gain = this.master.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, stopAt);
      // Restore the instant the sources stop: same-time automation events apply in insertion
      // order, so the bus is back at 1 exactly when nothing is left playing. _schedule() keeps
      // any new audio out of the fade window via fadeEnd.
      gain.setValueAtTime(1, stopAt);
      for (const { source } of this.scheduled) {
        try { source.stop(stopAt); } catch { /* already stopped */ }
      }
      this.scheduled = [];
      this.fadeEnd = stopAt;
      this.onCleared?.(stopAt);
    }
    this.nextTime = ctx?.currentTime || 0;
  }

  stop() {
    this.clear(0);
    this._clearTimer();
    // Full teardown must release the AudioContext: browsers cap live contexts per tab (~6 in
    // Chrome), and every session/connect-attempt builds a fresh player — leaking contexts here
    // made audio silently die after a few Start/Stop or provider switches until a page refresh.
    // ensureContext() recreates on next use (it already handles state === 'closed').
    const ctx = this.context;
    this.context = null;
    this.master = null;
    if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
      ctx.close().catch(() => {});
    }
  }
}
