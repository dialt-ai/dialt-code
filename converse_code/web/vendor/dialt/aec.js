import { SAMPLE_RATE } from './audio.js';

// SDK-side echo cancellation: libwebrtc APM (AEC3) compiled to WASM, fed the assistant's own
// playback as the far-end reference. Exists because WebKit (every iOS browser + Mac Safari)
// runs ONE shared mic pipeline per device, so we cannot both capture AEC-only audio and trust
// `echoCancellation:true` there: Apple's VPIO welds AEC to a noise suppressor that is harmful
// to ASR (finding #80, +12.5 WER at -15 dB), and a parallel raw capture strips AEC entirely
// (2026-07-03 prod echo incident). On WebKit the app captures fully raw and cancels here, with
// the same ENGINE desktop Chrome applies natively — but NOT the same behavior: desktop runs the
// browser's own AEC3 at its untunable defaults, and its residual suppressor eats the user's
// voice during double-talk (2026-07-13 gold replay: 20/20 VAD-barge misses are double-talk;
// raw mic fires the barge gate, AEC'd mic doesn't). The "unify on this canceller everywhere"
// plan was SETTLED NEGATIVE 2026-07-14 (ROADMAP improvement #1): measured on the battery's
// wasm arm, AEC3 v2.1's suppressor config space tops out at 12/22 barge catches vs native
// Chrome's 16/22 / 1 false fire — so desktop keeps the native canceller, and this module stays
// WebKit-only at upstream defaults. TUNED_AEC3_CONFIG + startMic({sdkAec:true}) remain the
// ship path if a future engine/config beats the battery gate.

const APM_FRAME = 160;       // 10 ms at 16 kHz — the APM's fixed processing quantum
const RENDER_PUMP_MS = 10;   // far-end feed cadence; AEC3's delay estimator absorbs the jitter

// The ONE tuned AEC3 config (ROADMAP improvement #1) — comma-separated key=value
// overrides applied via apm_create_with_config; '' = upstream defaults. Any change here
// must first beat the front-end battery gate (run_frontend.py, catch rate AND false
// fires vs the browser-arm baseline) — tune with eval/runners/sweep_wasm_aec.py.
export const TUNED_AEC3_CONFIG = '';

// True where getUserMedia AEC cannot deliver the AEC-only front-end spec: supported iOS browser
// builds (including branded Chrome/Firefox/Edge) and Mac Safari. The device gate deliberately
// keeps new iOS engine variants on the conservative SDK path until physically certified. Desktop
// Chromium keeps its native per-stream AEC3; Firefox desktop keeps Gecko's per-stream canceller.
export function needsSdkAec(ua = globalThis.navigator?.userAgent || '') {
  const iosDevice = /iPhone|iPad|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (globalThis.navigator?.maxTouchPoints || 0) > 1); // iPadOS masquerades as Mac
  const macSafari = /Macintosh/.test(ua) && /Safari\//.test(ua)
    && !/Chrome\/|Chromium\/|CriOS\/|Edg/.test(ua);
  return iosDevice || macSafari;
}

// Streams two 16 kHz mono feeds through the APM:
//   render (far-end)  — assistant chunks, tapped from StreamingPlayer at schedule time and fed
//                       on the player's own clock so the reference tracks real playout;
//   capture (near-end) — mic frames via processCapture(), echo-cancelled in place of the input.
// Until init() resolves (or if it fails) processCapture passes frames through unchanged, so a
// slow/failed WASM load degrades to "no AEC" rather than breaking the uplink.
export class EchoCanceller {
  constructor({ loadModule, config = TUNED_AEC3_CONFIG } = {}) {
    this._loadModule = loadModule
      || (() => import('./aec3-wasm.js').then((m) => m.default()));
    this._config = config;
    this._mod = null;
    this._apm = 0;
    this._buf = 0;             // wasm-heap scratch for one APM frame
    this._inBuf = new Float32Array(0);
    this._outBuf = new Float32Array(0);
    this._player = null;
    this._chunks = [];         // scheduled far-end: {samples, t0} in player-context time
    this._renderClock = null;  // context time of the next far-end sample to feed
    this._pumpTimer = null;
    this._closed = false;
  }

  async init() {
    const mod = await this._loadModule();
    if (this._closed) return;
    this._mod = mod;
    if (this._config) {
      // A non-default config must actually apply: no silent fallback to defaults.
      if (typeof mod._apm_create_with_config !== 'function') {
        throw new Error('aec3-wasm.js build has no apm_create_with_config');
      }
      const ptr = mod.stringToNewUTF8(this._config);
      this._apm = mod._apm_create_with_config(SAMPLE_RATE, ptr);
      mod._free(ptr);
    } else {
      this._apm = mod._apm_create(SAMPLE_RATE);
    }
    if (!this._apm) throw new Error('apm_create failed');
    this._buf = mod._malloc(APM_FRAME * 4);
  }

  get ready() { return !!this._apm; }

  // Tap the player: far-end chunks arrive with their scheduled playout time; a barge/clear
  // drops the not-yet-played tail so the reference mirrors what actually reaches the speaker.
  attachPlayer(player) {
    this._player = player;
    player.onScheduled = (samples, startAt) => {
      this._chunks.push({ samples, t0: startAt });
    };
    player.onCleared = (cutAt) => {
      // Drop chunks that start after the cut and trim the one straddling it: the reference must
      // end where the speaker does, not where the chunk would have.
      this._chunks = this._chunks.filter((c) => c.t0 < cutAt).map((c) => {
        const keep = Math.round((cutAt - c.t0) * SAMPLE_RATE);
        return keep < c.samples.length ? { samples: c.samples.subarray(0, keep), t0: c.t0 } : c;
      });
    };
    if (this._pumpTimer == null) {
      this._pumpTimer = setInterval(() => this._pumpRender(), RENDER_PUMP_MS);
    }
  }

  // Feed the APM one 10 ms far-end frame per elapsed 10 ms of player-context time — scheduled
  // audio where a chunk overlaps the window, zeros where nothing was playing. Keeping the render
  // stream continuous in playout time is what lets AEC3's delay estimator lock on.
  _pumpRender() {
    const ctx = this._player?.context;
    if (!ctx || !this._apm) return;
    const now = ctx.currentTime;
    if (this._renderClock == null) this._renderClock = now;
    if (now - this._renderClock > 1) this._renderClock = now - 0.1; // tab was throttled: resync
    const frame = new Float32Array(APM_FRAME);
    while (this._renderClock + APM_FRAME / SAMPLE_RATE <= now) {
      frame.fill(0);
      for (const c of this._chunks) {
        const off = Math.round((this._renderClock - c.t0) * SAMPLE_RATE);
        if (off + APM_FRAME <= 0 || off >= c.samples.length) continue;
        for (let i = 0; i < APM_FRAME; i++) {
          const j = off + i;
          if (j >= 0 && j < c.samples.length) frame[i] = c.samples[j];
        }
      }
      this._process('_apm_process_render', frame);
      this._renderClock += APM_FRAME / SAMPLE_RATE;
      const horizon = this._renderClock - 1; // keep 1 s of history, prune older chunks
      this._chunks = this._chunks.filter((c) => c.t0 + c.samples.length / SAMPLE_RATE > horizon);
    }
  }

  // Echo-cancel one mic frame (any length). Returns a frame of the same length. Because the APM
  // quantum (160) doesn't divide the mic frame (512), the output buffer can underfill during the
  // first few frames; each underfill is covered with leading zeros (≤128 samples total, start of
  // session only) so no captured audio is ever dropped and alignment then holds for good.
  processCapture(frame) {
    if (!this._apm) return frame;
    const joined = new Float32Array(this._inBuf.length + frame.length);
    joined.set(this._inBuf); joined.set(frame, this._inBuf.length);
    let pos = 0;
    let out = this._outBuf;
    while (joined.length - pos >= APM_FRAME) {
      const processed = this._process('_apm_process_capture', joined.subarray(pos, pos + APM_FRAME));
      const merged = new Float32Array(out.length + APM_FRAME);
      merged.set(out); merged.set(processed, out.length);
      out = merged;
      pos += APM_FRAME;
    }
    this._inBuf = joined.slice(pos);
    if (out.length < frame.length) {
      const padded = new Float32Array(frame.length);
      padded.set(out, frame.length - out.length);
      out = padded;
    }
    const result = out.slice(0, frame.length);
    this._outBuf = out.slice(frame.length);
    return result;
  }

  _process(fn, frame) {
    const mod = this._mod;
    mod.HEAPF32.set(frame, this._buf >> 2);
    mod[fn](this._apm, this._buf);
    return mod.HEAPF32.slice(this._buf >> 2, (this._buf >> 2) + APM_FRAME);
  }

  close() {
    this._closed = true;
    if (this._pumpTimer != null) { clearInterval(this._pumpTimer); this._pumpTimer = null; }
    if (this._player) {
      this._player.onScheduled = null;
      this._player.onCleared = null;
      this._player = null;
    }
    if (this._mod) {
      if (this._buf) this._mod._free(this._buf);
      if (this._apm) this._mod._apm_destroy(this._apm);
      this._mod = null; this._apm = 0; this._buf = 0;
    }
    this._chunks = [];
  }
}
