import {
  binaryToFloat32, createSessionId, encodeTaggedPcm16,
  floatToPcm16Bytes, SAMPLE_RATE, toWebSocketUrl,
  UPLINK_CHANNEL_PROCESSED, UPLINK_FORMAT_TAGGED,
} from './audio.js';
import { StreamingPlayer } from './player.js';
import { EchoCanceller, needsSdkAec } from './aec.js';
import { CaptureHealth } from './capture-health.js';
import { CaptureAbortedError, CaptureStalledError, MicCapture } from './mic.js';
import { TrackFeeder, WebRtcSession } from './webrtc.js';

export {
  FRAME_SAMPLES, SAMPLE_RATE, binaryToFloat32, createSessionId, encodeTaggedPcm16,
  floatToPcm16Bytes, toWebSocketUrl,
  UPLINK_CHANNEL_PROCESSED, UPLINK_FORMAT_TAGGED,
} from './audio.js';
export { StreamingPlayer } from './player.js';
export { CaptureAbortedError, CaptureStalledError } from './mic.js';

// NO OUTPUT-ROUTING CODE, BY EXPERIMENT (2026-07-30): never touch navigator.audioSession —
// 'playback' breaks getUserMedia on real iPhones (a mic outage), and an 11-configuration
// on-device test showed modern iOS gives web pages no earpiece/speaker control at all (see
// StreamingPlayer's header). A regression test pins this.
const LISTENING_WARMUP_FRAMES = 16; // Custom capture readiness; startMic uses its first-frame gate.

// Canonical public realtime endpoint. Passing `url` remains supported for local/dev and
// legacy compatibility routes; omit it only when using the hosted API default.
export const DEFAULT_REALTIME_URL = 'wss://api.dialt.com/v1/realtime';

// Barge hard-clear fade (server sends `interrupted` with clear:true): long enough to read as a
// yield rather than a glitch, short enough that silence lands ~immediately vs the old drain.
const BARGE_CLEAR_FADE_S = 0.15;
const captureClockMs = () => {
  const monotonic = globalThis.performance?.now?.();
  return Number.isFinite(monotonic) ? monotonic : Date.now();
};

// The browser SDK is thin: stream mic frames up (via pushMicFrame), play assistant audio down, and
// reflect server events. Barge-in is SERVER-side — the broker runs its speech detector on the AEC'd
// mic uplink and yields the floor itself — so the client has no VAD/detection at all. This keeps
// every client (browser, native, phone) identical, and there's no onnxruntime-web to load.
//
// Server events: `turn` (reply starting), `asr`/`utterance` (transcripts), `done` (reply finished),
// `interrupted` (a final barge — the server stopped sending), and `canceled` (eager speculation
// retracted).
// One short-lived authorized control frame (feedback, client_error): open a fresh socket — the
// session's own socket is usually closed by the time these fire — send the frame, resolve on the
// server's ok. `kind` only labels the errors.
function brokerError(frame, fallback) {
  const err = new Error(frame?.detail || fallback);
  err.code = frame?.code;
  err.retryable = frame?.retryable;
  return err;
}

// A promise can reject with anything, not just an Error -- WASM module instantiation across
// some bundler/browser combos is one real case. String(plainObject) yields the useless
// "[object Object]"; JSON.stringify at least surfaces its fields, with String() as the final
// fallback for values JSON.stringify can't render (undefined, a function, a circular ref).
function _describeThrown(err) {
  if (typeof err?.message === 'string') return err.message;
  try {
    const json = JSON.stringify(err);
    if (json !== undefined) return json;
  } catch {
    // circular reference or similar -- fall through to String()
  }
  return String(err ?? '');
}

function sendOneShotFrame(kind, frame, { url, WebSocketImpl = globalThis.WebSocket, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(toWebSocketUrl(url));
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error(`${kind} timed out`));
    }, timeoutMs);
    const settle = (fn, value) => { clearTimeout(timer); fn(value); };
    ws.addEventListener('open', () => { ws.send(JSON.stringify(frame)); }, { once: true });
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'ok') settle(resolve, true);
        else settle(reject, new Error(m.detail || `${kind} rejected`));
      } catch (err) {
        settle(reject, err);
      }
      try { ws.close(1000); } catch { /* noop */ }
    }, { once: true });
    ws.addEventListener('error', () => settle(reject, new Error(`${kind} socket failed`)), { once: true });
    // A clean close without a reply (proxy cut the socket, server died between accept and ack)
    // must fail fast, not wait out timeoutMs. settle() on an already-settled promise is a no-op.
    ws.addEventListener('close', () => settle(reject, new Error(`${kind} socket closed before ok`)),
      { once: true });
  });
}

// Post-session feedback (thumbs + optional comment + device/browser tags). The server files it
// next to the session's recording, so pass the DialtClient's sessionId.
export function sendFeedback({ url, sessionId, rating, text, device, browser, apiKey,
  WebSocketImpl, timeoutMs } = {}) {
  if (!url || !sessionId) return Promise.reject(new Error('url and sessionId are required'));
  const frame = { type: 'feedback', session_id: sessionId };
  if (rating) frame.rating = rating;
  if (text) frame.text = text;
  if (device) frame.device = device;
  if (browser) frame.browser = browser;
  if (apiKey) frame.api_key = apiKey;
  return sendOneShotFrame('feedback', frame, { url, WebSocketImpl, timeoutMs });
}

// Client-side failure report (mic permission denied, reconnect gave up, …): without it these are
// invisible server-side — the session log just shows a start with 0s of mic audio. The server
// journals it and records it as a session_client_errors row. sessionId is optional (some failures
// predate any session).
//
// `detail` and `context` are JOURNALED, and the journal is shipped off-box to a log backend. Send
// failure diagnostics only — never transcripts, replies, or anything the user typed or said.
export function sendClientError({ url, sessionId, detail, context, apiKey,
  WebSocketImpl, timeoutMs } = {}) {
  if (!url || !detail) return Promise.reject(new Error('url and detail are required'));
  const frame = { type: 'client_error', detail };
  if (sessionId) frame.session_id = sessionId;
  if (context) frame.context = context;
  if (apiKey) frame.api_key = apiKey;
  return sendOneShotFrame('client_error', frame, { url, WebSocketImpl, timeoutMs });
}

const DIALT_MODE_FIELDS = new Set([
  'kind', 'modality', 'voice', 'instructions', 'tools', 'web_search', 'end_call',
  'greeting', 'silence_nudge_s',
  'silence_end_s', 'tool_choice', 'policy', 'brain',
]);

// Conditions and actions for agent instructions and quiet background guidance.
function validatedPolicy(value) {
  const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(value) || Object.keys(value).some((k) => !['rules', 'subject', 'include_instructions', 'background_guidance'].includes(k))) {
    throw new TypeError('dialt policy must contain rules and only supported settings');
  }
  for (const key of ['include_instructions', 'background_guidance']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') throw new TypeError(`dialt policy ${key} must be a boolean`);
  }
  const subject = Object.hasOwn(value, 'subject') ? value.subject : 'a call';
  if (typeof subject !== 'string' || !subject.trim() || [...subject].length > 200) {
    throw new TypeError('dialt policy subject must contain 1 to 200 characters');
  }
  if (!Array.isArray(value.rules) || !value.rules.length || value.rules.length > 12) {
    throw new TypeError('dialt policy rules must contain 1 to 12 rules');
  }
  const seen = new Set();
  for (const rule of value.rules) {
    if (!isObject(rule) || Object.keys(rule).length !== 3 || !['id', 'when', 'do'].every((k) => Object.hasOwn(rule, k))) {
      throw new TypeError('dialt policy rules require exactly id, when and do');
    }
    if (typeof rule.id !== 'string' || !/^[a-z]/.test(rule.id) || /[^a-z0-9_]/.test(rule.id) || rule.id.length > 40) {
      throw new TypeError('dialt policy rule id must be 1 to 40 lowercase letters, digits or underscores, starting with a letter');
    }
    if (seen.has(rule.id)) throw new TypeError('dialt policy rule id is repeated');
    seen.add(rule.id);
    for (const key of ['when', 'do']) {
      if (typeof rule[key] !== 'string' || !rule[key].trim() || [...rule[key]].length > 1000) {
        throw new TypeError(`dialt policy rule ${key} must contain 1 to 1000 characters`);
      }
    }
  }
  return value;
}

// Tool-selection constraint. Structural validation only — tool-name membership
// is the server's call (it errors with `invalid_tool_choice` and changes nothing).
function validatedToolChoice(value) {
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'tool' && typeof value.tool === 'string'
        && value.tool.trim()) return value;
    if (keys.length === 1 && keys[0] === 'allowed' && Array.isArray(value.allowed)
        && value.allowed.length
        && value.allowed.every((name) => typeof name === 'string' && name.trim())) return value;
  }
  throw new TypeError(
    'tool_choice must be "auto", "none", "required", {allowed: [...]}, or {tool: "..."}');
}

function validatedMode(value = { kind: 'dialt' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('mode must be an object');
  }
  const mode = { ...value };
  for (const [key, item] of Object.entries(mode)) {
    if (item === undefined) delete mode[key];
  }
  const allowed = mode.kind === 'dialt' ? DIALT_MODE_FIELDS : null;
  if (!allowed) throw new TypeError('mode.kind must be dialt');
  const extra = Object.keys(mode).find((key) => !allowed.has(key));
  if (extra) throw new TypeError(`unexpected ${mode.kind} mode field: ${extra}`);
  const optionalString = (key) => {
    if (Object.hasOwn(mode, key) && typeof mode[key] !== 'string') {
      throw new TypeError(`${mode.kind} ${key} must be a string`);
    }
  };
  const optionalBoolean = (key) => {
    if (Object.hasOwn(mode, key) && typeof mode[key] !== 'boolean') {
      throw new TypeError(`${mode.kind} ${key} must be a boolean`);
    }
  };
  optionalString('voice');
  if (mode.kind === 'dialt' && mode.voice !== undefined && !mode.voice.trim()) {
    throw new TypeError('dialt voice must be a non-empty roster key');
  }
  optionalBoolean('web_search');
  mode.web_search ??= false;
  if (mode.kind === 'dialt') {
    if (mode.modality !== undefined && mode.modality !== 'voice' && mode.modality !== 'text') {
      throw new TypeError('dialt modality must be voice or text');
    }
    mode.modality ??= 'voice';
    if (Object.hasOwn(mode, 'brain') && !['fast', 'smart'].includes(mode.brain)) {
      throw new TypeError('dialt brain must be fast or smart');
    }
    optionalString('instructions');
    // Declares the managed end_call(farewell) tool so the agent can end the session: true for
    // Dialt's default ending condition, { when: '...' } to state the host's own.
    if (Object.hasOwn(mode, 'end_call') && typeof mode.end_call !== 'boolean') {
      const setting = mode.end_call;
      const valid = setting && typeof setting === 'object' && !Array.isArray(setting)
        && Object.keys(setting).length === 1 && typeof setting.when === 'string'
        && setting.when.trim().length > 0;
      if (!valid) {
        throw new TypeError(`${mode.kind} end_call must be a boolean or { when: string }`);
      }
    }
    mode.end_call ??= false;
    if (Object.hasOwn(mode, 'tools') && !Array.isArray(mode.tools)) {
      throw new TypeError('dialt tools must be an array');
    }
    if (Object.hasOwn(mode, 'tool_choice')) {
      if (!Array.isArray(mode.tools) || !mode.tools.length) {
        throw new TypeError('dialt tool_choice requires a non-empty tools list');
      }
      mode.tool_choice = validatedToolChoice(mode.tool_choice);
    }
    if (mode.greeting != null && mode.greeting !== false && typeof mode.greeting !== 'string') {
      throw new TypeError('dialt greeting must be a string or false');
    }
    if (Object.hasOwn(mode, 'policy')) mode.policy = validatedPolicy(mode.policy);
    // Per-session override of the broker's two-stage silence policy (env defaults: 10s/20s), e.g.
    // a benchmark harness with long simulated-user think-time. Omit either field to keep the
    // broker's default for it; the broker also falls back to its defaults if these are omitted,
    // non-positive, or silence_end_s <= silence_nudge_s.
    for (const key of ['silence_nudge_s', 'silence_end_s']) {
      if (Object.hasOwn(mode, key) && (typeof mode[key] !== 'number'
          || !Number.isFinite(mode[key]) || mode[key] <= 0)) {
        throw new TypeError(`dialt ${key} must be a positive finite number`);
      }
    }
    if (Object.hasOwn(mode, 'silence_nudge_s') && Object.hasOwn(mode, 'silence_end_s')
        && mode.silence_end_s <= mode.silence_nudge_s) {
      throw new TypeError('dialt silence_end_s must be greater than silence_nudge_s');
    }
  }
  return mode;
}

function resumeTokenFromState(state) {
  if (state == null) return null;
  if (typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('resumeState must be an object or null');
  }
  if (state.version !== 1) {
    throw new TypeError('resumeState.version must be 1');
  }
  if (typeof state.resumeToken !== 'string' || !state.resumeToken) {
    throw new TypeError('resumeState.resumeToken must be a non-empty string');
  }
  return state.resumeToken;
}

// Shared by _openOnce/_openOnceWebRtc: marks(ms since this connect attempt began), dispatched as
// `connect_timing` once `ready` lands so an app/playground can see where connect() time went.
function connectMarks() {
  const t0 = globalThis.performance?.now?.() ?? 0;
  const marks = {};
  const mark = (name) => { marks[name] = Math.round((globalThis.performance?.now?.() ?? 0) - t0); };
  return { marks, mark };
}

export class DialtClient extends EventTarget {
  constructor({ url = DEFAULT_REALTIME_URL, sessionId = createSessionId(), player, apiKey,
    mode = { kind: 'dialt' }, user, timezone,
    WebSocketImpl = globalThis.WebSocket,
    echoCancellerFactory = () => new EchoCanceller(),
    autoReconnect = true, reconnectBaseMs = 500, reconnectMaxMs = 5000,
    maxReconnectAttempts = 12, captureStartupTimeoutMs = 2000, captureSignalTimeoutMs = 5000,
    inputDeviceId = null,
    listeningWarmupFrames = LISTENING_WARMUP_FRAMES,
    injectionAckTimeoutMs = 10000, resumeState = null,
    transport = 'ws', RTCPeerConnectionImpl = globalThis.RTCPeerConnection } = {}) {
    super();
    if (!url) throw new Error('url is required');
    if (!WebSocketImpl) throw new Error('WebSocket is required');
    if (transport !== 'ws' && transport !== 'webrtc') {
      throw new TypeError('transport must be "ws" or "webrtc"');
    }
    if (transport === 'webrtc' && needsSdkAec()) {
      // WebKit's echo cancellation is the SDK's own AEC3 canceller, and its far-end reference
      // comes from the WS player's scheduled chunks — assistant audio over webrtc bypasses that
      // player, which would leave Safari/iOS with NO echo cancellation at all (barge-in and ASR
      // both break against speaker bleed). So webrtc falls back to ws here.
      //
      // This is PERMANENT on WebKit, not pending work. An earlier note here called a
      // remote-track far-end tap a tracked TODO; measured 2026-08-18, that tap does not exist
      // to be written. A loopback peer connection carrying a 440 Hz tone, attached to an
      // <audio> element exactly as this SDK does, read back through createMediaStreamSource
      // gives peak amplitude 0.00000 on BOTH Safari 26.6 and Chrome (CriOS 151) on iOS 26 —
      // the engine, not the browser app, since iOS forces every browser onto WebKit. The track
      // arrives; Web Audio gets silence. Anyone revisiting this should re-run that probe before
      // writing code, not after.
      console.warn('[dialt] webrtc transport is not yet supported on WebKit - using ws');
      transport = 'ws';
    }
    this.url = toWebSocketUrl(url);
    this.transport = transport;
    this._RTCPeerConnectionImpl = RTCPeerConnectionImpl;
    this.sessionId = sessionId;
    // Server-minted logical session identifier; see docs/glossary.md (Session UUID).
    this.sessionUuid = null;
    this.player = player || new StreamingPlayer();
    this.apiKey = apiKey || null;
    this._mode = Object.freeze(validatedMode(mode));
    // Optional stable user identifier (e.g. a persistent anonymous id) — recorded server-side so
    // captures can be grouped per user across sessions. Never used for auth.
    this.user = user || null;
    // IANA timezone of this browser (Intl API): lets the server anchor "what time is it" and
    // search locale to the USER's clock instead of guessing. Omitted -> server treats as unknown.
    this.timezone = timezone || null;
    this._echoCancellerFactory = echoCancellerFactory;
    this.WebSocketImpl = WebSocketImpl;
    // Remote deploys drop sockets (wifi handoff, sleep, transient loss) far more than localhost.
    // Auto-reconnect with backoff keeps the mic alive across a blip; the server-issued resume token
    // preserves conversation and deferred jobs during its bounded reconnect window.
    this.autoReconnect = autoReconnect;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    if (!Number.isFinite(captureStartupTimeoutMs) || captureStartupTimeoutMs <= 0) {
      throw new RangeError('captureStartupTimeoutMs must be a positive finite number');
    }
    this.captureStartupTimeoutMs = captureStartupTimeoutMs;
    if (!Number.isFinite(captureSignalTimeoutMs) || captureSignalTimeoutMs <= 0) {
      throw new RangeError('captureSignalTimeoutMs must be a positive finite number');
    }
    this.captureSignalTimeoutMs = captureSignalTimeoutMs;
    if (!Number.isFinite(injectionAckTimeoutMs) || injectionAckTimeoutMs <= 0) {
      throw new RangeError('injectionAckTimeoutMs must be a positive finite number');
    }
    this.injectionAckTimeoutMs = injectionAckTimeoutMs;
    this.ws = null;
    this.opened = null;
    this.audioQueue = Promise.resolve();
    this._responding = false;   // between `turn` and `done`/`interrupted`/`canceled`
    this._pendingInjections = new Map(); // message_id -> authoritative broker ack promise
    this._injectionSeq = 0;
    // Exactly one atomic handoff may wait for the broker at a time. Operation IDs correlate this
    // live request only; they do not make an uncertain transport loss safe to retry.
    this._pendingHandoff = null; // { operationId, resolve, reject, timer, request }
    this._handoffSeq = 0;
    this._narrationStates = new Map();   // job_id -> last known tool_job_narration state
    this._narrationWaiters = new Map();  // job_id -> [{ states, resolve, reject, timer }]
    this._interactionStates = new Map(); // interaction_id -> last known narration state
    // interaction_id -> FIFO [{ resolve, reject, timer }]: the server answers every update in
    // order, so per-id queues keep concurrent duplicate updates (the documented
    // first-close-wins flow) from cross-wiring or dropping each other's acks.
    this._pendingInteractionUpdates = new Map();
    this._live = false;         // true only while a socket is open AND past `ready`
    this._lifecycleGeneration = 0;
    this._resetting = null;
    this._closedByUser = false; // set by close() so a clean shutdown doesn't trigger reconnect
    this._resumeToken = resumeTokenFromState(resumeState);
    // Latest server token (possibly imported above); sent on the next continuation attempt.
    this._noGreeting = false;
    this._listeningFired = false;
    this._listeningFrames = 0;
    this.listeningWarmupFrames = Math.max(1, listeningWarmupFrames | 0);
    this._micGeneration = 0;   // invalidates every async stage when stop/restart supersedes it
    this._mic = null;          // SDK-owned capture (startMic); apps with custom capture never set it
    this._aec = null;          // SDK-side AEC3, only on WebKit (see startMic)
    this._captureHealth = null; // whether SDK-owned capture is live; drives listening/recovering
    this._micStarting = null;  // in-flight/settled startMic() promise (idempotence + stop race)
    this._micDesired = false;
    this._micOptions = null;
    this._pendingMicCaptures = new Set();
    this._inputDeviceId = inputDeviceId || null;
    this._activeInputDeviceId = null;
    this._knownInputDevices = null;
    this._deviceChangeListening = false;
    this._deviceRestart = null;
    this._handleDeviceChangeBound = () => this._handleDeviceChange().catch(() => {});
    this._uplinkSeq = [0, 0];
    this._audioFrontend = null;  // actual SDK-owned mic/AEC path, persisted across reconnects
    this._audioFrontendFallback = false;
    this._audioFrontendFallbackError = null;  // why the WASM AEC3 engine failed to init, if it did
    // webrtc-transport-only state (see _openOnceWebRtc): the peer connection, its "control" data
    // channel (the send-a-control-frame primitive's destination instead of `this.ws`), the mic's
    // re-injection feeder (src/webrtc.js), and the hidden <audio> element assistant audio plays
    // through. None of these are touched when transport === 'ws'.
    this._rtcSession = null;
    this._channel = null;
    this._trackFeeder = null;
    this._micSender = null;           // the pc's outbound-audio RTCRtpSender (see startMic below)
    this._directMicTrackEngaged = false;  // true once startMic() swapped the raw device track in
    this._remoteAudioEl = null;
  }

  _setCaptureState(state, detail = {}) {
    this._dispatch({ type: state, state, ...detail });
  }

  // Capture-health transitions become lifecycle events once startMic() has installed the capture.
  // Before that, startMic() itself reports warming_up/recovering and replays a healthy state.
  _onCaptureHealth(health, state, detail) {
    if (!health.installed || health !== this._captureHealth) return;
    if (state === 'healthy') {
      this._listeningFired = true;
      this._setCaptureState('listening', {
        device_id: this._activeInputDeviceId, recovered: health.recovered, ...detail,
      });
      health.recovered = true;   // any later listening follows an interruption
    } else if (state === 'interrupted') {
      this._setCaptureState('recovering', { ...detail, device_id: this._activeInputDeviceId });
    }
  }

  _dispatchConnectTiming(transport, marks) {
    this._dispatch({ type: 'connect_timing', transport, total_ms: marks.ready, marks });
  }

  async _acquireHealthyMic(options, isCurrent = () => true) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!isCurrent()) throw new CaptureAbortedError();
      const capture = new MicCapture(options);
      this._pendingMicCaptures.add(capture);
      try {
        await capture.start({ firstFrameTimeoutMs: this.captureStartupTimeoutMs });
        capture.recovered = attempt > 1;
        return capture;
      } catch (error) {
        await capture.stop().catch(() => {});
        // stopMic() may win while a stalled capture is being torn down. Do not reopen the
        // device after cancellation merely to have the stale-generation path close it again.
        if (!isCurrent()) throw new CaptureAbortedError();
        if (error?.code === 'capture_stalled' && attempt === 1) {
          this._setCaptureState('recovering', {
            code: 'capture_stalled', attempt, next_attempt: attempt + 1,
          });
          continue;
        }
        if (error?.code === 'capture_stalled') error.retryable = false;
        throw error;
      } finally {
        this._pendingMicCaptures.delete(capture);
      }
    }

    throw new CaptureStalledError();
  }
  // The default mic path: owns getUserMedia under the locked AEC-only front-end spec (AEC on,
  // NS+AGC OFF — browser defaults enable both, measurably hurting ASR) and picks the AEC engine
  // per platform. Desktop Chrome/Firefox keep their native per-stream canceller; WebKit (all iOS
  // browsers + Mac Safari, where platform AEC is Apple VPIO with an ASR-harmful NS welded in)
  // captures fully raw and cancels with the SDK's AEC3-in-WASM fed the player's far-end tap.
  // Frames flow straight into pushMicFrame (which stays public for apps with custom capture).
  // Resolves {sdkAec, aecFallback} for UI messaging: sdkAec = the WASM canceller is active;
  // aecFallback = WebKit but the WASM engine failed to load, so the platform canceller (VPIO —
  // degraded but better than echo) is in effect. Idempotent while started; stopMic() re-arms.
  // sdkAec: 'auto' (default) = WASM canceller only where the platform can't deliver
  // AEC-only (WebKit/iOS, see needsSdkAec); true = force the SDK canceller everywhere
  // (desktop rollout of the ONE tuned AEC — gate on run_frontend.py before flipping
  // any default); false = force platform AEC.
  startMic({ workletUrl, sdkAec: sdkAecMode = 'auto', deviceId = this._inputDeviceId } = {}) {
    if (this._mode.modality === 'text') {
      throw new Error('microphone capture is unavailable in text mode');
    }
    if (deviceId != null && (typeof deviceId !== 'string' || !deviceId)) {
      throw new TypeError('deviceId must be a non-empty string or null');
    }
    if (this._micStarting) return this._micStarting;
    this._micDesired = true;
    this._inputDeviceId = deviceId || null;
    this._micOptions = { workletUrl, sdkAec: sdkAecMode, deviceId: this._inputDeviceId };
    this._setCaptureState('warming_up', { attempt: 1, device_id: this._inputDeviceId });
    const generation = ++this._micGeneration;
    this._watchDeviceChanges();
    this.getInputDevices().then((devices) => { this._knownInputDevices = devices; }).catch(() => {});
    const starting = (async () => {
      const webkit = needsSdkAec();
      let sdkAec = sdkAecMode === 'auto' ? webkit : !!sdkAecMode;
      let aecFallback = false;
      let aecFallbackError = null;
      let aec = null;
      if (sdkAec) {
        aec = this._echoCancellerFactory();
        try {
          await aec.init();
          aec.attachPlayer(this.player);
        } catch (err) {
          aec.close();
          aec = null;
          sdkAec = false;
          aecFallback = true;
          // Previously swallowed entirely, so a WASM AEC3 failure was undiagnosable after the
          // fact (2026-08-20: a real WebKit user's fallback sessions self-barged on nearly every
          // turn and we had no idea why). Reported to the server via _sendAudioFrontendStatus.
          // A WASM module's dynamic import()/instantiation can reject with a non-Error value
          // across some bundler/browser combos, so this doesn't just trust err.name/err.message
          // to be strings, and doesn't treat a legitimate empty err.message as "missing".
          aecFallbackError = {
            name: typeof err?.name === 'string' && err.name ? err.name : 'Error',
            message: _describeThrown(err),
          };
          console.warn('[voice-loop] SDK AEC3 init failed, falling back to platform AEC', err);
        }
      }
      // Captured on the instance as soon as it's known, not deferred to the success tail
      // below — a subsequent platform-AEC mic-acquisition failure (the catch around
      // _acquireHealthyMic further down) still needs to report this diagnostic even though
      // startMic() itself is about to throw; see the explicit resend there.
      this._audioFrontendFallback = aecFallback;
      this._audioFrontendFallbackError = aecFallbackError;
      if (this._micGeneration !== generation) {
        aec?.close();
        return { sdkAec, aecFallback, aecFallbackError, stopped: true };
      }
      // A second WebKit capture mutates device-wide processing and stripped AEC in production.
      // Raw assist there is valid only when this single raw capture feeds both WASM and raw uplink.
      let mic = null;
      // `listening` waits for proof that capture is live, not just for the first frame. The
      // SDK-AEC capture is raw, so it must also show signal (see capture-health.js).
      const health = new CaptureHealth({
        requireSignal: sdkAec,
        signalTimeoutMs: this.captureSignalTimeoutMs,
        onChange: (state, detail) => this._onCaptureHealth(health, state, detail),
      });
      health.start();
      this._captureHealth?.stop();
      this._captureHealth = health;
      try {
        mic = await this._acquireHealthyMic({
          processing: !sdkAec,   // platform AEC unless the SDK is cancelling
          workletUrl, deviceId: this._inputDeviceId,
          onClockStall: (stallMs) => this._dispatch({
            type: 'capture_stall', stall_ms: Math.round(stallMs),
          }),
          onFrame: (frame, captureMs) => {
            health.frame(frame);
            this.pushMicFrame(aec ? aec.processCapture(frame) : frame, { captureMs });
          },
        }, () => this._micGeneration === generation && this._micDesired);
      } catch (err) {
        health.stop();
        aec?.close();
        await mic?.stop().catch(() => {});
        if (this._micGeneration !== generation) {
          return { sdkAec, aecFallback, aecFallbackError, stopped: true };
        }
        this._micDesired = false;
        this._unwatchDeviceChanges();
        // A WASM AEC3 failure followed by a correlated platform-AEC acquisition failure is
        // exactly the messiest real-world case the diagnostic above exists for — report it
        // even though startMic() is about to throw and the caller never sees a resolved info
        // object at all.
        if (aecFallbackError) {
          this._audioFrontend = sdkAec ? 'sdk-aec3' : 'platform-aec';
          this._sendAudioFrontendStatus();
        }
        this._setCaptureState('failed', {
          code: err?.code || 'capture_failed', error: err,
        });
        throw err;
      }
      if (this._micGeneration !== generation) {
        health.stop();
        aec?.close();
        await Promise.allSettled([mic.stop()]);
        return { sdkAec, aecFallback, aecFallbackError, stopped: true };
      }
      this._mic = mic;
      this._aec = aec;
      this._audioFrontend = sdkAec ? 'sdk-aec3' : 'platform-aec';
      const activeTrack = mic.stream?.getAudioTracks?.()[0] || mic.stream?.getTracks?.()[0];
      this._activeInputDeviceId = activeTrack?.getSettings?.().deviceId || this._inputDeviceId;
      // The normal webrtc path: swap the getUserMedia track straight into the RTCPeerConnection's
      // sender instead of leaving the JS TrackFeeder re-injection in the loop. webrtc only ever
      // runs on non-WebKit platforms (WebKit forces ws — see needsSdkAec() above this class), so
      // `!sdkAec` here means native platform echo cancellation already produced this exact track's
      // audio — it's the SAME processed audio the feeder would otherwise have re-encoded, with zero
      // extra JS hops/queueing/latency. replaceTrack() needs no renegotiation (the sender/m-line
      // were already established by the initial offer in _openOnceWebRtc). Only the SDK's own AEC3
      // canceller (sdkAec, WebKit-only in practice) or a custom-capture caller (no startMic() at
      // all) still needs the feeder — see _uplinkFrame.
      if (this.transport === 'webrtc' && !sdkAec && this._micSender) {
        const rawTrack = mic.stream?.getAudioTracks?.()[0];
        if (rawTrack) await this._engageDirectMicTrack(rawTrack, generation);
      }
      // stopMic/device switching may have won while replaceTrack was pending. Restore the feeder
      // before releasing the now-stale capture so the sender never retains an ended device track.
      if (this._micGeneration !== generation) {
        health.stop();
        this._directMicTrackEngaged = false;
        aec?.close();
        await Promise.allSettled([
          this._micSender?.replaceTrack(this._trackFeeder?.track || null),
          mic.stop(),
        ]);
        return { sdkAec, aecFallback, aecFallbackError, stopped: true };
      }
      this._sendAudioFrontendStatus();
      health.installed = true;
      health.recovered = !!mic.recovered;
      if (health.state === 'healthy') this._onCaptureHealth(health, health.state, health.detail);
      return { sdkAec, aecFallback, aecFallbackError, deviceId: this._activeInputDeviceId };
    })();
    this._micStarting = starting;
    starting.catch(() => { if (this._micStarting === starting) this._micStarting = null; });
    return starting;
  }

  // Safari requires audio playback to be unlocked from the user's gesture. Call this before any
  // async connect / mic-permission wait so later streamed assistant audio can actually play.
  // Over webrtc the StreamingPlayer is unused (see _attachRemoteAudio) — the hidden <audio> element
  // is the only playback surface, so do not allocate a silent AudioContext for that transport.
  // Nudge an existing element too (for example after a reconnect established a new remote track).
  unlockAudio() {
    const contextUnlock = this.transport === 'ws' ? this.player?.ensureContext?.() : null;
    return Promise.all([
      contextUnlock,
      this._remoteAudioEl?.play?.().catch(() => {}),
    ].filter(Boolean));
  }

  // Release the SDK-owned mic + AEC (no-op if startMic was never used). Safe to call repeatedly;
  // does not touch the socket, so a session can drop the mic and still receive/play audio.
  async stopMic() {
    this._micDesired = false;
    this._unwatchDeviceChanges();
    await this._releaseMic();
  }

  async _releaseMic() {
    const starting = this._micStarting;
    this._micGeneration += 1;
    this._micStarting = null;
    const pendingCaptures = [...this._pendingMicCaptures];
    const mic = this._mic;
    this._mic = null;
    this._audioFrontend = null;
    this._audioFrontendFallback = false;
    this._audioFrontendFallbackError = null;
    this._activeInputDeviceId = null;
    this._sendAudioFrontendStatus();
    this._aec?.close();
    this._aec = null;
    this._captureHealth?.stop();
    this._captureHealth = null;
    // Hand the sender back to the feeder BEFORE the capture's own track is stopped below, so the
    // peer connection never ends up pointing at an ended track (and any later pushMicFrame() from
    // a custom-capture caller has somewhere to go again).
    let handoff = Promise.resolve();
    if (this._directMicTrackEngaged && this._micSender) {
      this._directMicTrackEngaged = false;
      handoff = this._micSender.replaceTrack(this._trackFeeder?.track || null).catch(() => {});
    }
    await handoff;
    await Promise.allSettled([
      mic?.stop(), ...pendingCaptures.map((capture) => capture.stop()),
    ]);
    // getUserMedia is not abortable. Await the invalidated start so stopMic is a true barrier:
    // any late grant is released by the stale-generation path before this method resolves.
    if (starting) await starting.catch(() => {});
  }

  get inputDeviceId() { return this._inputDeviceId; }

  async getInputDevices() {
    const enumerate = navigator.mediaDevices?.enumerateDevices;
    if (typeof enumerate !== 'function') return [];
    const devices = await enumerate.call(navigator.mediaDevices);
    return devices.filter((device) => device.kind === 'audioinput');
  }

  async setInputDevice(deviceId) {
    if (deviceId != null && (typeof deviceId !== 'string' || !deviceId)) {
      throw new TypeError('deviceId must be a non-empty string or null');
    }
    const normalized = deviceId || null;
    if (normalized === this._inputDeviceId && this._activeInputDeviceId) {
      return { deviceId: this._activeInputDeviceId };
    }
    const previousDeviceId = this._inputDeviceId;
    this._inputDeviceId = normalized;
    this._dispatch({
      type: 'input_device_changed', device_id: normalized, previous_device_id: previousDeviceId,
    });
    if (!this._micDesired) return { deviceId: normalized };
    return this._restartMic('manual_device_switch');
  }

  _watchDeviceChanges() {
    const mediaDevices = navigator.mediaDevices;
    if (this._deviceChangeListening || !mediaDevices?.addEventListener) return;
    mediaDevices.addEventListener('devicechange', this._handleDeviceChangeBound);
    this._deviceChangeListening = true;
  }

  _unwatchDeviceChanges() {
    if (!this._deviceChangeListening) return;
    navigator.mediaDevices?.removeEventListener?.('devicechange', this._handleDeviceChangeBound);
    this._deviceChangeListening = false;
  }

  _defaultInput(devices) {
    return devices.find((device) => device.deviceId === 'default') || devices[0] || null;
  }

  async _handleDeviceChange() {
    const previous = this._knownInputDevices;
    const devices = await this.getInputDevices();
    this._knownInputDevices = devices;
    this._dispatch({
      type: 'devices_changed', devices, device_id: this._inputDeviceId,
      active_device_id: this._activeInputDeviceId,
    });
    if (!this._micDesired || !previous) return;
    // Browsers redact the inventory until capture is granted: no labels, empty ids. startMic()
    // snapshots it before getUserMedia resolves, and WebKit then fires devicechange as the real
    // inventory appears. That reveal is not a device change; restarting on it released and
    // reopened the microphone on every fresh Safari page load (PR #1309 Mac test).
    if (previous.every((device) => !device.label)) return;

    const explicitStillAvailable = !this._inputDeviceId
      || devices.some((device) => device.deviceId === this._inputDeviceId);
    const activeStillAvailable = !this._activeInputDeviceId
      || this._activeInputDeviceId === 'default'
      || devices.some((device) => device.deviceId === this._activeInputDeviceId);
    const oldDefault = this._defaultInput(previous);
    const newDefault = this._defaultInput(devices);
    const defaultChanged = !this._inputDeviceId && (
      oldDefault?.deviceId !== newDefault?.deviceId
      || oldDefault?.groupId !== newDefault?.groupId
      || oldDefault?.label !== newDefault?.label
    );
    if (explicitStillAvailable && activeStillAvailable && !defaultChanged) return;

    if (!explicitStillAvailable) {
      const unavailableDeviceId = this._inputDeviceId;
      this._inputDeviceId = null;
      this._dispatch({
        type: 'input_device_changed', device_id: null,
        previous_device_id: unavailableDeviceId, reason: 'unavailable',
      });
    }
    await this._restartMic('devicechange');
  }

  _restartMic(reason) {
    if (!this._micDesired) return Promise.resolve(null);
    if (this._deviceRestart) return this._deviceRestart;
    const restarting = (async () => {
      let info = null;
      do {
        const releasingDeviceId = this._inputDeviceId;
        this._setCaptureState('recovering', { code: reason, device_id: releasingDeviceId });
        await this._releaseMic();
        if (!this._micDesired) return null;
        // Selection is authoritative and may have changed while release awaited a pending start.
        const targetDeviceId = this._inputDeviceId;
        const options = { ...(this._micOptions || {}), deviceId: targetDeviceId };
        info = await this.startMic(options);
        // Converge on a newer selection made while this reacquisition was in flight.
        if (targetDeviceId === this._inputDeviceId) return info;
      } while (this._micDesired);
      return info;
    })();
    this._deviceRestart = restarting;
    restarting.finally(() => {
      if (this._deviceRestart === restarting) this._deviceRestart = null;
    }).catch(() => {});
    return restarting;
  }

  /** Temporarily gate live microphone tracks without reopening the device. This is a transport
   *  safety primitive for explicit half-duplex integrations; normal full-duplex clients leave it
   *  enabled and rely on AEC. */
  setMicEnabled(enabled) {
    const active = !!enabled;
    for (const capture of [this._mic]) {
      const stream = capture?.stream;
      const tracks = stream?.getAudioTracks?.() || stream?.getTracks?.() || [];
      for (const track of tracks) track.enabled = active;
    }
    // webrtc: the outbound track is the feeder's synthetic MediaStreamTrack, not the capture's own
    // getUserMedia track (see src/webrtc.js) — mute it directly so custom-capture apps (which call
    // pushMicFrame() without startMic() and so have no capture track above) still get silence.
    this._trackFeeder?.setMuted(!active);
  }

  connect(options = {}) {
    if (Object.hasOwn(options, 'temperature')) throw new TypeError('unexpected connect option: temperature');
    const { noGreeting = false } = options;
    if (this.opened) return this.opened;
    if (typeof noGreeting !== 'boolean') throw new TypeError('noGreeting must be a boolean');
    this._closedByUser = false;
    this._noGreeting = noGreeting;
    const opening = this.transport === 'webrtc' ? this._openOnceWebRtc() : this._openOnce();
    this.opened = opening;
    // Initial connect failed (not a live drop, so no reconnect) — clear so a later connect() retries.
    // `_openOnce` never touches `this.opened` itself, so this and `_scheduleReconnect` are its sole
    // owners; that's what keeps a multi-attempt reconnect from leaving `opened` null while live.
    opening.catch((err) => {
      if (this.opened !== opening) return;
      this.opened = null;
      if (err?.code === 'resume_failed' && this._resumeToken) {
        this._setResumeToken(null);
        this.sessionUuid = null;
        this._dispatch({ type: 'resume_failed', error: err });
      }
    });
    return this.opened;
  }

  /** Return the current opaque, JSON-serializable continuation state, or null before `ready` and
   *  after the session ends. Persist it only in storage appropriate for a short-lived credential
   *  (normally sessionStorage), then pass it back as `resumeState` after a page reload. */
  exportResumeState() {
    return this._resumeToken ? { version: 1, resumeToken: this._resumeToken } : null;
  }

  /** Install state previously returned by exportResumeState(). Import is deliberately restricted
   *  to a client that has not started connecting: replacing a live session's continuation token
   *  would make the next automatic reconnect resume unrelated context. */
  importResumeState(state) {
    if (this.opened || this._live || this.ws) {
      throw new Error('resume state can only be imported before connect()');
    }
    this._setResumeToken(resumeTokenFromState(state));
  }

  _setResumeToken(token) {
    const normalized = typeof token === 'string' && token ? token : null;
    if (normalized === this._resumeToken) return;
    this._resumeToken = normalized;
    this._dispatch({ type: 'resume_state', state: this.exportResumeState() });
  }

  // Shared start-frame construction (mode/greeting) for both transports.
  _buildStartFrame() {
    let mode = validatedMode(this._mode);
    if (mode.kind === 'dialt') {
      if (this._noGreeting) mode.greeting = false;
    }
    mode = validatedMode(mode);
    const textModality = mode.kind === 'dialt' && mode.modality === 'text';
    // Voice is the established wire default. Keep it internally for client-side guards, but omit
    // it from the frame so this SDK remains voice-compatible with pre-text Dialt servers.
    if (mode.kind === 'dialt' && mode.modality === 'voice') delete mode.modality;
    const start = {
      type: 'start',
      session_id: this.sessionId,
      mode,
    };
    if (!textModality) {
      start.audio = { sr: SAMPLE_RATE, output_encoding: 'pcm16' };
    } else if (this.transport !== 'ws') {
      throw new TypeError('dialt text modality requires the ws transport');
    }
    if (this.apiKey) start.api_key = this.apiKey;
    if (this._resumeToken) start.resume_token = this._resumeToken;
    const client = {};
    client.capabilities = !textModality && this.transport === 'ws' &&
      typeof this.player?.pause === 'function' && typeof this.player?.resume === 'function'
      ? ['playback_pause_v1'] : [];
    client.audio_frontend = this._audioFrontend || 'unknown';
    if (this.user) client.user = this.user;
    if (this.timezone) client.timezone = this.timezone;
    if (Object.keys(client).length) start.client = client;
    if (this.transport === 'ws' && start.audio) {
      start.audio.uplink_format = UPLINK_FORMAT_TAGGED;
      client.capabilities.push('capture_clock_v1');
    }
    return start;
  }

  // One connection attempt. Resolves on `ready`; rejects if the socket fails or closes before ready.
  // If an already-live socket later drops (and the user didn't close it), kicks off auto-reconnect.
  // Owns only its own promise — never mutates `this.opened` (see connect()/_scheduleReconnect).
  _openOnce() {
    const start = this._buildStartFrame();
    // Validate and serialize before opening a network resource. A circular/custom tool schema must
    // fail locally without leaking a connecting WebSocket.
    const startPayload = JSON.stringify(start);
    const { marks, mark } = connectMarks();
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      let settled = false;
      let liveReady = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          // Don't leak a live socket when connect() rejects (error frame, format mismatch):
          // the server would keep the session open while the app believes connect failed.
          if (ws.readyState === 0 || ws.readyState === 1) {
            try { ws.close(1000, 'client rejected session'); } catch { /* already closing */ }
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      ws.addEventListener('open', () => { mark('ws_open'); ws.send(startPayload); }, { once: true });
      ws.addEventListener('error', () => fail(new Error('Dialt WebSocket failed')), { once: true });
      ws.addEventListener('close', (ev) => {
        const ownsSocket = this.ws === ws;
        if (ownsSocket) {
          this.ws = null;
          this._live = false;
          this._rejectPendingInjections(
            new Error('connection closed before injection acknowledgement'));
          // Connection-scoped: a resumed session supersedes any open interaction (re-raise it
          // with a fresh partial if still needed), so cached states would be stale.
          this._narrationStates.clear();
          this._interactionStates.clear();
        }
        if (!liveReady) {
          if (!settled) fail(new Error('Dialt WebSocket closed before ready'));
          return;
        }
        if (!ownsSocket) return;  // a failed older attempt closed after a newer retry opened
        if (!this._closedByUser && ev.code === 1000) {
          // The server hung up ON PURPOSE (only intentional ends close 1000 — e.g. the idle
          // sign-off's `close(1000, "idle")`). Redialing here would open a fresh session and
          // replay the greeting; stay closed and let the app decide. Abnormal drops (1006 loss,
          // 1011 upstream lost, 1013 drain) still reconnect below.
          this.opened = null;
          this._setResumeToken(null); // an ended session must not resume on a later connect()
          this.sessionUuid = null;
          this._responding = false;   // a reused client must not carry reply/ack state into
          this._dispatch({ type: 'session_end', code: ev.code, reason: ev.reason || '' });
        }
        else if (!this._closedByUser && this.autoReconnect) this._scheduleReconnect();
        else this.opened = null;
      });
      ws.addEventListener('message', async (ev) => {
        if (this.ws !== ws) return;  // ignore queued messages from an obsolete failed attempt
        try {
          const detail = await this._message(ev.data);
          if (this.ws !== ws) return;
          if (!settled && detail?.type === 'ready') {
            // The ready frame states the negotiated downlink format; a mismatch here would
            // otherwise surface as noise in the speakers, so fail the connect loudly instead.
            const fmt = detail.audio;
            if (fmt && (fmt.output_encoding !== 'pcm16' || fmt.output_sr !== SAMPLE_RATE)) {
              fail(new Error(`server negotiated unsupported downlink audio ${JSON.stringify(fmt)}; `
                + `this SDK plays pcm16 at ${SAMPLE_RATE} Hz`));
              return;
            }
            if (typeof detail.resume_token === 'string') this._setResumeToken(detail.resume_token);
            if (typeof detail.session_uuid === 'string') this.sessionUuid = detail.session_uuid;
            mark('ready');
            settled = true;
            liveReady = true;
            this._live = true;
            this._listeningFired = false;   // re-arm: this session emits `listening` after warmup
            this._listeningFrames = 0;
            this._uplinkSeq = [0, 0];
            this._sendAudioFrontendStatus();
            this._dispatchConnectTiming('ws', marks);
            resolve(this);
          } else if (!settled && detail?.type === 'error') {
            fail(brokerError(detail, 'Dialt WebSocket rejected connection'));
          }
        } catch (err) {
          fail(err);
        }
      });
    });
  }

  // The webrtc counterpart of _openOnce(): signaling still rides a plain WebSocket to the same
  // /ws URL (see serving/broker_webrtc.py), but only long enough to exchange the SDP offer/answer —
  // once the "control" data channel is open, every protocol frame this class sends/receives moves
  // through _sendControl()/_message() over the channel instead, unchanged.
  //
  // Reconnect: a dropped/failed peer connection redials by running this method again from
  // scratch (new RTCPeerConnection, offer/answer, control channel) with the current resume_token;
  // there is no ICE restart. _teardownWebRtc() clears the previous attempt first, and every
  // per-attempt callback checks it still owns the connection before mutating client state.
  async _openOnceWebRtc() {
    const generation = this._lifecycleGeneration;
    const start = this._buildStartFrame();
    start.transport = { kind: 'webrtc' };   // no sdp yet — TURN creds must exist before we gather
    this._teardownWebRtc();   // a stale peer connection/feeder from a previous failed attempt

    const startPayload = JSON.stringify(start);
    // WebRTC has several sequential steps _openOnce doesn't (two-step signaling, ICE gathering,
    // feeder setup) that dispatching only a single total would hide; each is marked individually
    // (see connectMarks()) so a slow connect can be attributed to a specific step instead of
    // guessed at.
    const { marks, mark } = connectMarks();
    const ws = new this.WebSocketImpl(this.url);   // signaling only — closed once the answer lands
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      let session = null;
      let feeder = null;
      let channel = null;
      // The signaling socket is deliberately self-closed right after the answer is applied (its
      // job is done — wire contract note #5); that close must NOT be mistaken for the signaling
      // socket dying before an answer ever arrived.
      let signalingDone = false;
      // True once THIS attempt has been superseded or closed. Ownership is judged against
      // this._rtcSession/this._channel (reassigned only by the current attempt); `session` and
      // `channel` are this closure's own copies.
      const staleBeforeReady = () => generation !== this._lifecycleGeneration || this._rtcSession !== session;
      const staleAfterReady = () => this._channel !== channel;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          // Only tear down if this attempt is still current: a newer attempt may already own
          // this._rtcSession/_channel, and tearing that down would kill its live connection.
          if (!staleBeforeReady()) this._teardownWebRtc();
          try { ws.close(); } catch { /* already closing/closed */ }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.addEventListener('open', () => { mark('ws_open'); ws.send(startPayload); }, { once: true });
      ws.addEventListener('error', () => fail(new Error('Dialt signaling WebSocket failed')), { once: true });
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        if (!settled && !signalingDone) fail(new Error('signaling socket closed before webrtc_answer'));
        // Once settled (or once we closed it ourselves post-answer) the signaling socket has done
        // its job — a close here, expected or not, has no bearing on the live call.
      });
      ws.addEventListener('message', async (ev) => {
        if (this.ws !== ws) return;   // ignore queued messages from an obsolete failed attempt
        if (typeof ev.data !== 'string') return;   // signaling only ever carries JSON
        let msg;
        try { msg = JSON.parse(ev.data); } catch (err) { fail(err); return; }
        if (msg.type === 'webrtc_ice') {
          // Step 1 of signaling: build the peer connection WITH the server's (possibly
          // TURN-bearing) ice_servers, gather, then offer — see the module-level wire contract
          // note. Building the RTCPeerConnection any earlier would gather before TURN creds
          // exist, making TURN permanently unusable.
          if (session) return;   // duplicate webrtc_ice — ignore, first one wins
          mark('ice_recv');
          session = new WebRtcSession({
            RTCPeerConnectionImpl: this._RTCPeerConnectionImpl,
            iceServers: Array.isArray(msg.ice_servers) && msg.ice_servers.length
              ? msg.ice_servers : undefined,
          });
          this._rtcSession = session;
          session.onRemoteTrack((stream) => {
            if (!staleBeforeReady()) this._attachRemoteAudio(stream);
          });
          session.onConnectionStateChange((state) => {
            if (staleBeforeReady()) return;   // abandoned peer connection, inert
            if (!settled) {
              if (state === 'failed' || state === 'closed') fail(new Error(`webrtc connection ${state}`));
              return;
            }
            // Post-live: a dead peer connection takes the same reconnect path as a dead data
            // channel. _handleTransportClose no-ops if the channel's 'close' got there first.
            if (staleAfterReady()) return;
            if (state === 'failed' || state === 'closed') {
              this._handleTransportClose(1006, `webrtc connection ${state}`);
            }
          });
          feeder = new TrackFeeder();
          this._trackFeeder = feeder;
          try {
            await feeder.start();
            if (staleBeforeReady()) { feeder.stop(); return; }
            mark('feeder_ready');
            channel = session.createControlChannel();
            // This feeder track is what negotiates the offer's audio m-line (startMic() hasn't
            // necessarily run yet — connect() resolves before the app calls it). Keep the sender
            // so a later startMic() can replaceTrack() the real getUserMedia track in directly,
            // with no renegotiation needed (see startMic()).
            this._micSender = session.addAudioTrack(feeder.track);
            const sdp = await session.createOfferWithGatheredIce();
            if (staleBeforeReady()) return;
            mark('offer_ready');   // includes createOffer/setLocalDescription + ICE gather wait
            ws.send(JSON.stringify({ type: 'webrtc_offer', sdp }));
            mark('offer_sent');
          } catch (err) { fail(err); return; }
          channel.addEventListener('message', async (chEv) => {
            if (settled ? staleAfterReady() : staleBeforeReady()) return;
            let detail;
            try { detail = await this._message(chEv.data); } catch (err) { fail(err); return; }
            if (settled ? staleAfterReady() : staleBeforeReady()) return;
            if (detail?.type === 'bye') {
              // Server-initiated close over the channel — treat exactly like a WS close with
              // that code (wire contract note #5a).
              if (!settled) fail(new Error(detail.reason || 'webrtc session closed'));
              else this._handleTransportClose(detail.code, detail.reason);
              return;
            }
            if (!settled && detail?.type === 'ready') {
              if (typeof detail.resume_token === 'string') this._setResumeToken(detail.resume_token);
              if (typeof detail.session_uuid === 'string') this.sessionUuid = detail.session_uuid;
              mark('ready');
              settled = true;
              this._channel = channel;
              this._live = true;
              this._listeningFired = false;
              this._listeningFrames = 0;
              this._uplinkSeq = [0, 0];
              this._sendAudioFrontendStatus();
              this._dispatchConnectTiming('webrtc', marks);
              // Re-engage the SAME running capture track on the fresh sender (no new
              // getUserMedia). Fire-and-forget: _engageDirectMicTrack's generation guard keeps
              // this safe if stopMic()/a device switch/close wins the race.
              if (this._micDesired && !this._aec && this._mic) {
                const rawTrack = this._mic.stream?.getAudioTracks?.()[0];
                if (rawTrack) this._engageDirectMicTrack(rawTrack, this._micGeneration).catch(() => {});
              }
              resolve(this);
            } else if (!settled && detail?.type === 'error') {
              fail(brokerError(detail, 'Dialt webrtc session rejected'));
            }
          });
          channel.addEventListener('close', () => {
            if (!settled) { fail(new Error('control channel closed before ready')); return; }
            if (staleAfterReady()) return;   // a newer connection already replaced this one
            this._handleTransportClose(1006, '');
          });
        } else if (msg.type === 'webrtc_answer') {
          if (!session) { fail(new Error('webrtc_answer before webrtc_ice')); return; }
          mark('answer_recv');
          try {
            await session.applyAnswer(msg.sdp);
          } catch (err) { fail(err); return; }
          mark('answer_applied');
          signalingDone = true;
          try { ws.close(1000); } catch { /* noop */ }   // signaling's job is done
        } else if (msg.type === 'error') {
          fail(brokerError(msg, 'Dialt webrtc connect rejected'));
        }
      });
    });
  }

  // Mirrors the WS close handler for a post-`ready` channel/PC teardown: 1000 is the terminal
  // session_end path; anything else redials via _scheduleReconnect() when autoReconnect is on.
  _handleTransportClose(code, reason) {
    if (!this._live) return;   // already handled (e.g. 'bye' then the channel's own 'close' event)
    this._live = false;
    this._channel = null;
    this._rejectPendingInjections(
      new Error('connection closed before injection acknowledgement'));
    // Connection-scoped, same as the WS close handler: a resumed session supersedes any open
    // interaction, so cached states would be stale.
    this._narrationStates.clear();
    this._interactionStates.clear();
    if (!this._closedByUser && code === 1000) {
      // Only an intentional server end closes 1000 (mirrors the WS idle sign-off) — surface it the
      // same way so app code doesn't need transport-specific handling. Redialing here would open a
      // fresh session and replay the greeting; stay closed and let the app decide.
      this.opened = null;
      this._responding = false;
      this._setResumeToken(null); // an ended session must not resume on a later connect()
      this.sessionUuid = null;
      this._dispatch({ type: 'session_end', code, reason: reason || '' });
      this._teardownWebRtc();
      return;
    }
    this._teardownWebRtc();
    if (!this._closedByUser && this.autoReconnect) this._scheduleReconnect();
    else this.opened = null;
  }

  // Assistant audio over webrtc arrives as a remote Opus track, not binary WS frames — StreamingPlayer
  // is unused here. Attach it to a hidden <audio> element instead; unlockAudio() also nudges this
  // element's play() for browsers that gate autoplay on a user gesture.
  _attachRemoteAudio(stream) {
    if (typeof document === 'undefined') return;   // non-browser test environment
    if (!this._remoteAudioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      el.style.display = 'none';
      (document.body || document.documentElement)?.appendChild(el);
      this._remoteAudioEl = el;
    }
    this._remoteAudioEl.srcObject = stream;
    this._remoteAudioEl.play?.().catch(() => {});   // best-effort; unlockAudio() retries post-gesture
  }

  _teardownWebRtc() {
    this._channel = null;
    const session = this._rtcSession;
    const feeder = this._trackFeeder;
    this._rtcSession = null;
    this._trackFeeder = null;
    this._micSender = null;
    this._directMicTrackEngaged = false;
    session?.close();
    feeder?.stop().catch(() => {});
    if (this._remoteAudioEl) {
      try { this._remoteAudioEl.pause?.(); } catch { /* noop */ }
      this._remoteAudioEl.srcObject = null;
      this._remoteAudioEl.remove?.();
      this._remoteAudioEl = null;
    }
  }

  // Swap a live capture track straight into the current webrtc sender, bypassing TrackFeeder
  // re-injection (see startMic()). Used by startMic() and by a reconnect re-engaging the SAME
  // running capture. `generation` freezes _micGeneration at call time: a stopMic()/device
  // switch/close winning the race must revert the sender to the feeder.
  async _engageDirectMicTrack(rawTrack, generation) {
    const sender = this._micSender;
    const lifecycle = this._lifecycleGeneration;
    const feederTrack = this._trackFeeder?.track || null;
    if (!sender) return;
    try {
      await sender.replaceTrack(rawTrack);
    } catch (err) {
      console.warn('[voice-loop] webrtc direct mic track swap failed; staying on the feeder', err);
      return;
    }
    if (sender !== this._micSender || lifecycle !== this._lifecycleGeneration) return;
    if (this._micGeneration === generation) {
      this._directMicTrackEngaged = true;
    } else {
      await sender.replaceTrack(feederTrack).catch(() => {});
    }
  }

  // A live connection dropped unexpectedly: reconnect with exponential backoff. `this.opened`
  // tracks the whole chain (not each attempt) so in-flight callers await the live connection and
  // never spawn a duplicate; cleared only on terminal give-up. Emits `reconnecting` then
  // `reconnected` (or terminal `error`). Redials through the client's own transport.
  _scheduleReconnect() {
    const generation = this._lifecycleGeneration;
    this._live = false;
    this._responding = false;
    this._playbackHold = null;
    this.player?.clear?.();
    this._dispatch({ type: 'reconnecting' });
    const openOnce = () => (this.transport === 'webrtc' ? this._openOnceWebRtc() : this._openOnce());
    let attempt = 0;
    const attemptOnce = () => {
      if (this._closedByUser || generation !== this._lifecycleGeneration) {
        return Promise.reject(new Error('connection superseded'));
      }
      attempt += 1;
      return openOnce().then((self) => {
        if (generation !== this._lifecycleGeneration) return self;
        if (this._closedByUser) {
          if (this.transport === 'webrtc') { this._teardownWebRtc(); this._live = false; }
          else { try { this.ws?.close(1000); } catch { /* noop */ } }
          return self;
        }
        this._dispatch({ type: 'reconnected' });
        return self;
      }).catch((err) => {
        if (this._closedByUser || generation !== this._lifecycleGeneration) throw err;
        if (err?.code === 'resume_failed') {
          this._setResumeToken(null);
          this.sessionUuid = null;
          this._dispatch({ type: 'resume_failed', error: err });
          throw err;
        }
        if (attempt >= this.maxReconnectAttempts) {
          this._dispatch({ type: 'error', detail: 'reconnect failed', error: err });
          throw err;
        }
        const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** (attempt - 1));
        return new Promise((res) => setTimeout(res, delay)).then(attemptOnce);
      });
    };
    const chain = attemptOnce();
    this.opened = chain;
    // On terminal give-up (or user-close), drop the rejected chain so a later connect() can retry.
    chain.then(null, () => { if (this.opened === chain) this.opened = null; });
  }

  _dispatch(event) {
    this.dispatchEvent(new CustomEvent(event.type, { detail: event }));
    this.dispatchEvent(new CustomEvent('event', { detail: event }));
  }

  // The one primitive every caller uses to send protocol JSON, so index.js has exactly one place
  // that knows the wire differs by transport: over 'ws' it's ws.send(); over 'webrtc' every frame
  // that would have gone over the socket instead rides the "control" RTCDataChannel byte-for-byte
  // (see serving/broker_webrtc.py's module docstring). Returns whether the frame reached a live
  // transport; controls are usually best-effort, while injectContext uses this as a delivery gate.
  _sendControl(obj) {
    if (this.transport === 'webrtc') {
      if (this._channel?.readyState === 'open') {
        this._channel.send(JSON.stringify(obj));
        return true;
      }
    } else if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // Deliberately NOT sendClientError() (see below): that path opens a fresh short-lived
  // socket for out-of-band failures (some predate any session), which is the wrong shape
  // for a diagnostic that's tightly correlated with THIS session's already-live audio_frontend
  // status and needs no extra connection to report.
  _sendAudioFrontendStatus() {
    const err = this._audioFrontendFallbackError;
    this._sendControl({
      type: 'client_event', event: 'audio_frontend',
      frontend: this._audioFrontend || 'unknown',
      fallback: this._audioFrontendFallback,
      ...(err ? { error_name: err.name, error_message: err.message } : {}),
    });
  }

  _uplink(frame, channel, captureMs) {
    const sequence = this._uplinkSeq[channel] >>> 0;
    this._uplinkSeq[channel] = (sequence + 1) >>> 0;
    return encodeTaggedPcm16(frame, { channel, sequence, captureMs });
  }

  // Push one mic frame onto the wire: WS binary frame, or (webrtc) into the TrackFeeder that backs
  // the outbound RTCPeerConnection audio track. the tagged capture clock is WS-only (see the
  // constructor), so webrtc always takes the plain branch here.
  // Once startMic() has swapped the raw getUserMedia track directly into the peer connection (see
  // startMic()), the outbound audio no longer depends on this re-injection at all — pushing these
  // frames into the feeder too would just be wasted work, since its output track is no longer the
  // one actually wired to the sender. Only a custom-capture caller (pushMicFrame()/appendAudio()
  // without startMic()) or the SDK's own AEC3 canceller path still needs the feeder engaged.
  _uplinkFrame(frame, captureMs) {
    if (this.transport === 'webrtc') {
      if (!this._directMicTrackEngaged) this._trackFeeder?.push(frame);
      return;
    }
    this.ws.send(this._uplink(frame, UPLINK_CHANNEL_PROCESSED, captureMs));
  }

  async appendAudio(frame, options = {}) {
    if (Object.hasOwn(options, 'temperature')) throw new TypeError('unexpected audio option: temperature');
    const { captureMs = captureClockMs() } = options;
    if (this._mode.modality === 'text') {
      throw new Error('audio input is unavailable in text mode');
    }
    await this.connect();
    if (!this._live) return;   // dropped mid-flight — skip this realtime frame
    this._uplinkFrame(frame, captureMs);
  }

  // Upload one capture frame. The server owns turn detection and barge-in.
  pushMicFrame(frame, options = {}) {
    if (Object.hasOwn(options, 'temperature')) throw new TypeError('unexpected audio option: temperature');
    const { captureMs = captureClockMs() } = options;
    if (this._mode.modality === 'text') {
      throw new Error('audio input is unavailable in text mode');
    }
    // Not connected (initial connect still pending, or mid-reconnect) — drop the frame rather than
    // buffer it. Buffered mic audio would flush as a stale burst into the fresh session on reconnect.
    if (!this._live) return;
    // Caller-owned capture has no startMic() promise, so retain its established warmup signal.
    if (!this._micDesired && !this._listeningFired) {
      this._listeningFrames += 1;
      if (this._listeningFrames >= this.listeningWarmupFrames) {
        this._listeningFired = true;
        this._dispatch({ type: 'listening', state: 'listening', custom_capture: true });
      }
    }
    // The live capture path sends synchronously.
    this._uplinkFrame(frame, captureMs);
  }

  get mode() { return this._mode; }

  get responding() { return this._responding; }

  /** End this conversation and connect a fresh one, retaining configuration and mic capture.
   *  sessionId is a client correlation value, not the server-issued sessionUuid. Replace it
   *  together with its session-scoped apiKey when your application mints a fresh credential. */
  reset({ sessionId = this.sessionId, apiKey = this.apiKey } = {}) {
    if (this._resetting) return this._resetting;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return Promise.reject(new TypeError('sessionId must be a non-empty string'));
    }
    if (apiKey != null && typeof apiKey !== 'string') {
      return Promise.reject(new TypeError('apiKey must be a string'));
    }
    const ws = this.ws;
    const closed = !ws || ws.readyState === 3 ? Promise.resolve() : new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    this._closeConnection({ preserveMic: true });
    this.sessionId = sessionId;
    this.apiKey = apiKey;
    const generation = this._lifecycleGeneration;
    const noGreeting = this._noGreeting;
    const resetting = closed.then(async () => {
      for (let attempt = 0; ; attempt += 1) {
        if (generation !== this._lifecycleGeneration) throw new Error('reset cancelled');
        try { return await this.connect({ noGreeting }); }
        catch (err) {
          if (!['too_many_sessions', 'server_busy'].includes(err?.code) || attempt >= 4) throw err;
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    });
    this._resetting = resetting;
    resetting.finally(() => {
      if (this._resetting === resetting) this._resetting = null;
    }).catch(() => {});
    return resetting;
  }

  /** Ask the server for a graceful sign-off: a
   *  host-enforced time limit (e.g. the playground's 3-minute mic cap) wants the model to wrap
   *  up in persona instead of the connection just dropping. Fire-and-forget, like
   *  never cuts a reply already in flight; the server's close(1000, "idle")
   *  arrives as the existing `session_end` event once the sign-off finishes. */
  requestWrapUp(reason = 'time_limit') {
    this._sendControl({ type: 'wrap_up', reason: String(reason).slice(0, 40) });
  }

  /** Add a typed user message or silent host context to the conversation, optionally asking the
   *  model to reply immediately. Resolves with the broker's authoritative acceptance/rejection. */
  injectContext(text, { role = 'context', reply = false, messageId } = {}) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (!text.trim() || [...text].length > 2000) {
      throw new RangeError('text must contain 1 to 2000 characters');
    }
    if (role !== 'user' && role !== 'context') {
      throw new TypeError('role must be "user" or "context"');
    }
    if (typeof reply !== 'boolean') throw new TypeError('reply must be a boolean');
    if (messageId === undefined) {
      messageId = globalThis.crypto?.randomUUID?.()
        || `${this.sessionId}-message-${++this._injectionSeq}`;
    }
    if (typeof messageId !== 'string') throw new TypeError('messageId must be a string');
    if (!messageId.trim() || [...messageId].length > 128) {
      throw new RangeError('messageId must contain 1 to 128 characters');
    }
    if (this._pendingInjections.has(messageId)) {
      throw new Error(`an injection with messageId ${messageId} is already pending`);
    }
    let resolveAck;
    let rejectAck;
    const acknowledgement = new Promise((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    // Keep ignored promises from becoming unhandled while preserving rejection for callers that
    // await the returned promise. Older integrations legitimately treated this method as void.
    acknowledgement.catch(() => {});
    const timer = setTimeout(() => {
      const pending = this._pendingInjections.get(messageId);
      if (!pending) return;
      this._pendingInjections.delete(messageId);
      pending.reject(new Error(`injection acknowledgement timed out for ${messageId}`));
    }, this.injectionAckTimeoutMs);
    this._pendingInjections.set(messageId, { resolve: resolveAck, reject: rejectAck, timer });
    const sent = this._sendControl(
      { type: 'inject_context', text, role, reply, message_id: messageId });
    if (!sent) {
      this._pendingInjections.delete(messageId);
      clearTimeout(timer);
      rejectAck(new Error('cannot inject context without a live connection'));
    }
    return acknowledgement;
  }

  /** Atomically replace the active agent after the broker applies the handoff. Resolves only on
   *  the final correlated `handoff_ack` (`status: "applied"` or `"rejected"`); a same-id
   *  `queued` acknowledgement is informational and leaves this promise pending. `operationId`
   *  is generated when omitted and is correlation only, never a retry token. Do not send another
   *  mode-changing setter until this promise settles: the SDK rejects those setters while a
   *  handoff is pending so a late acknowledgement cannot overwrite their replayed mode. */
  handoffAgent({ operationId, instructions, tools, voice, context } = {}, { timeoutMs = 15000 } = {}) {
    if (this._mode.kind !== 'dialt') throw new Error('handoffAgent is available only in Dialt mode');
    if (typeof instructions !== 'string') throw new TypeError('instructions must be a string');
    if (!Array.isArray(tools)) throw new TypeError('tools must be an array');
    if (voice !== undefined && (typeof voice !== 'string' || !voice.trim())) {
      throw new TypeError('voice must be a non-empty string when supplied');
    }
    if (context !== undefined && (typeof context !== 'string' || [...context].length > 2000)) {
      throw new TypeError('context must be a string of at most 2000 characters when supplied');
    }
    if (operationId === undefined) {
      operationId = globalThis.crypto?.randomUUID?.()
        || `${this.sessionId}-handoff-${++this._handoffSeq}`;
    }
    if (typeof operationId !== 'string' || !operationId.trim() || [...operationId].length > 128) {
      throw new RangeError('operationId must contain 1 to 128 characters');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }
    if (this._pendingHandoff) throw new Error('a handoff is already pending');
    let toolSnapshot;
    try {
      // The outbound frame is JSON, so snapshot its exact JSON-safe tool representation now.
      // A later caller mutation must not alter the applied replay mode while this ack is queued.
      toolSnapshot = JSON.parse(JSON.stringify(tools));
    } catch {
      throw new TypeError('tools must be JSON-serializable');
    }
    const request = { operationId, instructions, tools: toolSnapshot, voice, context };
    let resolveAck;
    let rejectAck;
    const acknowledgement = new Promise((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    acknowledgement.catch(() => {});
    const pending = { operationId, request, resolve: resolveAck, reject: rejectAck, timer: null };
    pending.timer = setTimeout(() => {
      if (this._pendingHandoff !== pending) return;
      this._pendingHandoff = null;
      pending.reject(new Error(`handoff acknowledgement timed out for ${operationId}`));
    }, timeoutMs);
    this._pendingHandoff = pending;
    const frame = { type: 'handoff_agent', operation_id: operationId, instructions,
      tools: request.tools };
    if (voice !== undefined) frame.voice = voice;
    if (context !== undefined) frame.context = context;
    if (!this._sendControl(frame)) {
      this._pendingHandoff = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('cannot hand off agent without a live connection'));
    }
    return acknowledgement;
  }

  /** Send a typed user turn and ask the model to reply. This is the text-chat equivalent of a
   *  final spoken turn and emits the same `asr` transcript event from the server.
   *
   *  Text sessions commit an `input_text` turn and return whether it was written to the live
   *  connection. Voice sessions keep the pre-0.20 behaviour unchanged: the turn is a user-role
   *  context injection (`injectContext(text, { role: 'user', reply: true, messageId })`) and the
   *  acknowledgement promise is returned. */
  sendText(text, { messageId } = {}) {
    if (this._mode.modality !== 'text') {
      return this.injectContext(text, { role: 'user', reply: true, messageId });
    }
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    if (!text.trim() || [...text].length > 20000) {
      throw new RangeError('text must contain 1 to 20000 characters');
    }
    return this._sendControl({ type: 'input_text', text });
  }

  /** Resolve a `tool_call` with a terminal outcome. Send `outcome` and `verified` whenever the
   *  host can establish them:
   *  - `{ outcome: 'succeeded', verified: true }` lets the assistant confirm the action ("you're
   *    booked for Tuesday"). Send it when the host holds proof, e.g. a booking confirmation ID.
   *  - `{ outcome: 'unknown' }` (the default) makes the assistant say it cannot confirm the
   *    action; it suits queued or fire-and-forget work.
   *  - `{ outcome: 'failed' }` makes the assistant say the action did not go through.
   *  `verified: true` is valid only with `succeeded`. A timeout is unknown even if the operation
   *  may have happened externally. Keep content compact: the server enforces
   *  its configured UTF-8 JSON byte ceiling and replaces oversized content with a bounded
   *  truncation marker and preview. Listen for calls via `client.addEventListener('tool_call', …)`;
   *  the content itself may be produced anywhere (e.g. relayed from your backend). */
  sendToolResult(id, content, { outcome = 'unknown', verified = false } = {}) {
    const outcomes = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'unknown']);
    if (!outcomes.has(outcome)) throw new TypeError('invalid tool result outcome');
    if (typeof verified !== 'boolean') throw new TypeError('verified must be a boolean');
    if (verified && outcome !== 'succeeded') {
      throw new TypeError('verified may be true only when outcome is "succeeded"');
    }
    return this._sendControl({ type: 'tool_result', id, content, outcome, verified });
  }

  /** Submit an external decision for an exact pending action. Returns whether the transport
   *  accepted the frame, not whether approval was accepted. Listen for `permission_resolution`
   *  for the broker acknowledgement, then handle the released `tool_call` normally. */
  resolveToolPermission(id, decision) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new TypeError('id must be a non-empty string');
    }
    if (decision !== 'approve' && decision !== 'decline') {
      throw new TypeError('decision must be approve or decline');
    }
    return this._sendControl({ type: 'resolve_tool_permission', id, decision });
  }

  /** Detach an eligible tool call from the current voice turn. The host keeps running the job and
   *  may address later progress, cancellation, and the one terminal result by id or handle. */
  sendToolDeferred(id, { handle, statusLabel } = {}) {
    const frame = { type: 'tool_deferred', id, handle };
    if (statusLabel) frame.status_label = statusLabel;
    return this._sendControl(frame);
  }

  /** Report human-readable progress on an in-flight tool call (docs/client-tool-protocol.md §3):
   *  appends to the brain's context so the next turn can speak to it; never resolves the call. */
  sendToolProgress(id, note) {
    return this._sendControl({ type: 'tool_progress', id, note });
  }

  /** Deliver a structured segment of an in-flight call's eventual answer
   *  (docs/client-tool-protocol.md §3a): capped like a result envelope, and `reply: true` asks
   *  the broker to proactively narrate it now. `interaction: { id, prompt, options, resolver }` marks this
   *  partial as needing a user decision rather than a routine milestone: unlike `reply: true`
   *  alone, it is never silently dropped when the floor is busy — it falls back to the same job
   *  queue tool completions use, preempting them, and gets a far more persistent delivery retry.
   *  Track its lifecycle with `narrationState`/`waitForNarrationState`. Never resolves the call —
   *  the terminal sendToolResult is still required exactly once. */
  sendToolPartialResult(id, content, { reply = false, interaction } = {}) {
    return this._sendControl({
      type: 'tool_partial_result', id, content,
      ...(reply ? { reply: true } : {}),
      ...(interaction ? { interaction } : {}),
    });
  }

  /** Last known `tool_job_narration` state ("queued"/"started"/"superseded"/"cancelled"/"failed")
   *  for `jobId`, or undefined if no narration ack has arrived for it yet. */
  narrationState(jobId) {
    return this._narrationStates.get(jobId);
  }

  /** Resolve once `jobId`'s tool_job_narration state reaches one of `states`, or reject on
   *  `timeoutMs`. Unlike injectContext's one-shot ack, a queued interaction's state evolves
   *  (queued -> started -> superseded/cancelled), so this is a repeatable wait keyed by jobId
   *  rather than a single resolve-once promise. */
  waitForNarrationState(jobId, states, { timeoutMs = 30000 } = {}) {
    const wanted = new Set(states);
    const current = this._narrationStates.get(jobId);
    if (wanted.has(current)) return Promise.resolve(current);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this._narrationWaiters.get(jobId);
        if (!waiters) return;
        const remaining = waiters.filter((w) => w.resolve !== resolve);
        if (remaining.length) this._narrationWaiters.set(jobId, remaining);
        else this._narrationWaiters.delete(jobId);
        reject(new Error(`narration state wait timed out for ${jobId}`));
      }, timeoutMs);
      const waiters = this._narrationWaiters.get(jobId) || [];
      waiters.push({ states: wanted, resolve, reject, timer });
      this._narrationWaiters.set(jobId, waiters);
    });
  }

  /** Last known narration state for a stable interaction id (host-chosen `interaction.id`, or
   *  the broker-derived id echoed in tool_job_narration's `interaction_ids`), or undefined. */
  interactionState(interactionId) {
    return this._interactionStates.get(interactionId);
  }

  /** Close an open interaction without completing its parent call
   *  (docs/client-tool-protocol.md §3a): the decision was `resolved` out-of-band, `cancelled`,
   *  or `superseded` by newer intent. Queued or actively-speaking narration for it stops and the
   *  model is told not to act on it. Resolves with the server's deterministic
   *  `tool_interaction_update_ack` (`applied: false` carries a stable `reason` for
   *  late/duplicate/unknown updates); rejects on timeout or a dead connection. */
  sendToolInteractionUpdate(id, interactionId, state, { note, timeoutMs = 10000 } = {}) {
    const states = new Set(['resolved', 'cancelled', 'superseded']);
    if (!states.has(state)) throw new TypeError('invalid interaction update state');
    if (typeof interactionId !== 'string' || !interactionId.trim()) {
      throw new TypeError('interactionId must be a non-empty string');
    }
    // The server normalizes ids by stripping whitespace and echoes the STRIPPED form in the
    // ack — key and send the same form, or a padded id's applied ack surfaces as a timeout.
    interactionId = interactionId.trim();
    let pending;
    const acknowledgement = new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: null, state };
      pending.timer = setTimeout(() => {
        this._removePendingInteractionUpdate(interactionId, pending);
        reject(new Error(`interaction update ack timed out for ${interactionId}`));
      }, timeoutMs);
    });
    const queue = this._pendingInteractionUpdates.get(interactionId) || [];
    queue.push(pending);
    this._pendingInteractionUpdates.set(interactionId, queue);
    const frame = { type: 'tool_interaction_update', id, interaction_id: interactionId, state };
    if (note) frame.note = note;
    if (!this._sendControl(frame)) {
      this._removePendingInteractionUpdate(interactionId, pending);
      clearTimeout(pending.timer);
      pending.reject(new Error('cannot update an interaction without a live connection'));
    }
    return acknowledgement;
  }

  _removePendingInteractionUpdate(interactionId, pending) {
    const queue = this._pendingInteractionUpdates.get(interactionId);
    if (!queue) return;
    const remaining = queue.filter((entry) => entry !== pending);
    if (remaining.length) this._pendingInteractionUpdates.set(interactionId, remaining);
    else this._pendingInteractionUpdates.delete(interactionId);
  }

  /** Cancel an in-flight tool call. */
  sendToolCancel(id) {
    return this._sendControl({ type: 'tool_cancel', id });
  }

  /** Restrict (or free) tool use mid-session — the tool-selection vocabulary:
   *  `"auto"` | `"none"` | `"required"` | `{allowed: [names]}` | `{tool: name}`. Applies from
   *  the next reply; `required`/`allowed`/`tool` constrain the first planning round of each
   *  caller turn, `none` withholds declared client tools (broker-managed protocol tools stay
   *  available). `oneShot: true` reverts to the previous choice after the next caller or
   *  explicitly host-requested reply consumes it; autonomous jobs do not consume it. An invalid
   *  value is rejected by the server with `invalid_tool_choice` and
   *  changes nothing; a mid-session `setTools` resets tool_choice to `"auto"`. */
  setToolChoice(toolChoice, { oneShot = false } = {}) {
    this._assertNoPendingHandoff();
    const validated = validatedToolChoice(toolChoice);
    if (!oneShot && this._mode.kind === 'dialt'
        && Array.isArray(this._mode.tools) && this._mode.tools.length) {
      // Durable restrictions fold into the replayed mode (like setVoice) so an auto-reconnect
      // re-applies them; a one-shot is turn-scoped and deliberately does not survive. A mode
      // with no constructor tools cannot carry one (a reconnect would have no tools either) --
      // the server's resume stash covers that case.
      this._mode = Object.freeze(validatedMode({ ...this._mode, tool_choice: validated }));
    }
    const frame = { type: 'set_tool_choice', tool_choice: validated };
    if (oneShot) frame.one_shot = true;
    return this._sendControl(frame);
  }

  /** Replace the client tool manifest mid-session (same shape as `mode.tools`), for an agent
   *  whose capabilities change by call phase: an intake persona that declares only a hand-off
   *  tool, then the specialist's tools once the hand-off lands. Applies from the next reply.
   *  The session's managed tools ride every swap, and the server resets `tool_choice` to
   *  `"auto"` (re-apply it after). The server rejects a bad manifest with `invalid_tools` and
   *  keeps the previous one. Folds into the replayed mode so an auto-reconnect keeps the swap.
   *  Dialt mode only. */
  setTools(tools) {
    this._assertNoPendingHandoff();
    if (!Array.isArray(tools)) throw new TypeError('tools must be an array');
    if (this._mode.kind !== 'dialt') return false;
    const { tool_choice: _dropped, ...rest } = this._mode;
    this._mode = Object.freeze(validatedMode({ ...rest, tools: [...tools] }));
    return this._sendControl({ type: 'set_tools', tools: [...tools] });
  }

  /** Replace the session instructions (`mode.instructions`) mid-session, from the next reply
   *  on; the platform persona above them is untouched. `newSpeaker: true` declares that a
   *  different agent takes the call from here: the server folds everything said so far into a
   *  transcript the new agent holds, so it never reads the previous agent's lines as its own.
   *  Send it between replies (after `done`); with `newSpeaker` the server refuses it while a
   *  reply is in flight (`instructions_busy`, retryable). Pair with `setTools()` and
   *  `setVoice()` for a same-session hand-off between agents. Folds into the replayed mode so
   *  an auto-reconnect resumes as the current speaker. Dialt mode only. */
  setInstructions(instructions, { newSpeaker = false } = {}) {
    this._assertNoPendingHandoff();
    if (typeof instructions !== 'string') throw new TypeError('instructions must be a string');
    if (this._mode.kind !== 'dialt') return false;
    this._mode = Object.freeze(validatedMode({ ...this._mode, instructions }));
    const frame = { type: 'set_instructions', instructions };
    if (newSpeaker) frame.new_speaker = true;
    return this._sendControl(frame);
  }

  /** Switch character voice mid-session. Applies from the next reply; Dialt mode only. */
  setVoice(voice) {
    this._assertNoPendingHandoff();
    // The server confirms the selected voice before reconnects replay it.
    if (this._mode.kind !== 'dialt') return;
    validatedMode({ ...this._mode, voice });
    this._sendControl({ type: 'set_voice', voice });
  }

  close() {
    this._closeConnection();
  }

  _closeConnection({ preserveMic = false } = {}) {
    this._lifecycleGeneration += 1;
    this._closedByUser = true;   // stop any reconnect loop and prevent reconnect on the close event
    this._live = false;
    this._setResumeToken(null); // an intentional reuse starts a new conversation
    this.sessionUuid = null;
    this._rejectPendingInjections(new Error('connection closed before injection acknowledgement'));

    this._responding = false;
    this._narrationStates.clear();
    this._interactionStates.clear();
    this.opened = null;
    const ws = this.ws;
    this.ws = null;
    if (!preserveMic) this.stopMic();
    this._playbackHold = null;
    if (preserveMic) this.player?.clear?.();
    else this.player?.stop?.();
    if (this.transport === 'webrtc') this._teardownWebRtc();
    try { ws?.close(1000); } catch { /* closing a CONNECTING socket is allowed and harmless */ }
  }

  /** Close cleanly and wait for the WebSocket close handshake, so callers can safely send
   *  follow-up controls that depend on server-side session finalization. */
  async closeAndWait(timeoutMs = 5000) {
    const ws = this.ws;
    if (!ws || ws.readyState === 3) {
      this.close();
      return;
    }
    const closed = new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    this.close();
    await closed;
  }

  _rejectPendingInjections(error) {
    for (const pending of this._pendingInjections.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pendingInjections.clear();
    if (this._pendingHandoff) {
      clearTimeout(this._pendingHandoff.timer);
      this._pendingHandoff.reject(new Error('connection closed before handoff acknowledgement'));
      this._pendingHandoff = null;
    }
    for (const waiters of this._narrationWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this._narrationWaiters.clear();
    for (const queue of this._pendingInteractionUpdates.values()) {
      for (const pending of queue) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
    this._pendingInteractionUpdates.clear();
  }

  _assertNoPendingHandoff() {
    if (this._pendingHandoff) {
      throw new Error('await the pending handoffAgent acknowledgement before changing session mode');
    }
  }

  _applyHandoffAck(pending) {
    const { instructions, tools, voice } = pending.request;
    const { tool_choice: _dropped, ...mode } = this._mode;
    this._mode = Object.freeze(validatedMode({ ...mode, instructions, tools: [...tools],
      ...(voice === undefined ? {} : { voice }) }));
  }

  _applyNarrationAck(event) {
    const interactionIds = Array.isArray(event.interaction_ids) ? event.interaction_ids : [];
    for (const interactionId of interactionIds) {
      this._interactionStates.set(interactionId, event.state);
    }
    const jobIds = Array.isArray(event.job_ids) ? event.job_ids : [];
    for (const jobId of jobIds) {
      this._narrationStates.set(jobId, event.state);
      const waiters = this._narrationWaiters.get(jobId);
      if (!waiters) continue;
      const remaining = [];
      for (const waiter of waiters) {
        if (waiter.states.has(event.state)) {
          clearTimeout(waiter.timer);
          waiter.resolve(event.state);
        } else {
          remaining.push(waiter);
        }
      }
      if (remaining.length) this._narrationWaiters.set(jobId, remaining);
      else this._narrationWaiters.delete(jobId);
    }
  }

  // Drive playback state off each server event, before re-dispatching it.
  _applyReflex(event) {
    const webrtc = this.transport === 'webrtc';
    switch (event.type) {
      case 'turn':
        if (this._playbackHold) this.player?.clear?.();
        this._playbackHold = null;
        this._playbackTurnId = event.turn_id;
        this._responding = true;
        if (!webrtc) this.player?.markReplyStart?.();
        if (webrtc) {
          // No per-chunk binary audio frames arrive over webrtc (assistant audio is a remote RTP
          // track — see _attachRemoteAudio), so app.js's `case "audio": if (client.responding && ...)
          // setState(SPEAKING)` would never fire. Rather than reinvent per-chunk detection (the
          // remote track already started/will start playing immediately), synthesize the one
          // 'audio' event apps actually key off of, right when a reply — and therefore audio — is
          // known to start. `samples` is null: there is no decoded PCM to hand a custom consumer.
          this._dispatch({ type: 'audio', sr: SAMPLE_RATE, samples: null, synthetic: true });
        }
        break;
      case 'playback_pause': {
        if (webrtc || !event.hold_id || event.turn_id !== this._playbackTurnId ||
            typeof this.player?.pause !== 'function') break;
        if (this._playbackHold && this._playbackHold.hold_id !== event.hold_id) break;
        const hold = this._playbackHold ?? event;
        this._playbackHold = hold;
        const socket = this.ws;
        this.audioQueue = this.audioQueue.catch(() => {}).then(() => {
          if (this._playbackHold !== hold || this.ws !== socket) return;
          if (!this.player.pause(hold.hold_id)) return;
          const retained = Math.round(this.player.pendingMs?.() ?? 0);
          const report = { type: 'client_event', event: 'playback_paused',
            hold_id: hold.hold_id, turn_id: hold.turn_id,
            remaining_ms: Math.round(this.player.deviceLatencyMs?.() ?? 0), retained_ms: retained };
          if (retained > 3000) {
            report.error = 'buffer_limit';
            hold.bufferError = true;
            // Retain the bounded tail until interrupted reports its discarded duration.
          }
          if (socket?.readyState === 1) socket.send(JSON.stringify(report));
        });
        break;
      }
      case 'playback_resume': {
        if (webrtc) break;
        const hold = this._playbackHold;
        if (!hold || hold.hold_id !== event.hold_id || hold.turn_id !== event.turn_id) break;
        this.audioQueue = this.audioQueue.catch(() => {}).then(() => {
          if (this._playbackHold !== hold) return;
          this.player?.resume?.(hold.hold_id);
          this._playbackHold = null;
        });
        break;
      }
      case 'canceled':
        this._playbackHold = null;    // eager speculation retracted: clear the mistaken audio
        // Over webrtc the server owns playout and already stopped sending on its own retraction —
        // there is no local queue for this client to clear.
        if (!webrtc) this.player?.clear?.();
        this._responding = false;
        break;
      case 'interrupted': // barged — stop the reply (fade-clear if the server asks, else drain).
        if (this._playbackHold) event = { ...event, clear: true };
        this._playbackHold = null;
        this._responding = false;
        // Over webrtc the server measures and reports its own discarded audio on a hard-clear barge
        // (see broker_webrtc.py's WebRtcTransport.send_json) and there is no local player queue to
        // drain/fade — the wire contract explicitly forbids the client sending playback_stopped here
        // (note #5b), so webrtc takes none of the WS path's measurement/report below.
        if (webrtc) break;
        // Report the stop so the server can timestamp actual silence at the speaker
        // (barge_detected -> playback_stopped = the stop half of barge latency) and, on a
        // clear, re-truncate its committed text by discarded_ms (audio the user never heard);
        // barge_seq is echoed so a slow report can't be applied to a later barge. Chained on
        // audioQueue so in-flight enqueues (dropped by the _responding recheck) settle first.
        this.audioQueue = this.audioQueue.catch(() => {}).then(() => {
          const pending = this.player?.pendingMs?.() ?? 0;
          const device = this.player?.deviceLatencyMs?.() ?? 0;
          let remaining = pending + device;
          let discarded = 0;
          if (event.clear) {
            const held = this.player?.holdId != null;
            this.player?.clear?.(BARGE_CLEAR_FADE_S);
            const fadeMs = held ? 0 : BARGE_CLEAR_FADE_S * 1000;
            discarded = Math.max(0, pending - fadeMs);
            remaining = Math.min(pending, fadeMs) + device;
          }
          if (this.ws?.readyState === 1) {
            const report = { type: 'client_event', event: 'playback_stopped',
                             remaining_ms: Math.round(remaining),
                             discarded_ms: Math.round(discarded) };
            if (typeof event.barge_seq === 'number') report.barge_seq = event.barge_seq;
            this.ws.send(JSON.stringify(report));
          }
        });
        break;
      case 'done':
        this._responding = false;
        // Playback-health report: did this reply's audio starve at the speaker? Sent every
        // reply (zeroes included) so a smooth session is distinguishable from a silent gap in
        // telemetry. WS only: over webrtc the browser owns a jitter buffer we cannot observe.
        if (!webrtc && this.player?.takePlaybackStats) {
          const stats = this.player.takePlaybackStats();
          if (this.ws?.readyState === 1) {
            const report = { type: 'client_event', event: 'playback_report', ...stats };
            if (event.turn_id) report.turn_id = event.turn_id;
            this.ws.send(JSON.stringify(report));
          }
        }
        break;
      case 'working':
        // Dialt is blocking on a tool result with nothing audible (true) / that wait ended
        // (false). The thinking sound keys off this; apps can show a "working" state from it.
        break;
      default:
        break;
    }
  }

  async _message(data) {
    const generation = this._lifecycleGeneration;
    if (typeof data === 'string') {
      const event = JSON.parse(data);
      if (event.type === 'voice' && this._mode.kind === 'dialt'
          && typeof event.voice === 'string' && event.voice.trim()) {
        this._mode = Object.freeze(validatedMode({ ...this._mode, voice: event.voice }));
      }
      if (event.type === 'inject_context_ack' && typeof event.message_id === 'string') {
        const pending = this._pendingInjections.get(event.message_id);
        if (pending) {
          this._pendingInjections.delete(event.message_id);
          clearTimeout(pending.timer);
          pending.resolve(event);
        }
      }
      if (event.type === 'handoff_ack' && typeof event.operation_id === 'string') {
        const pending = this._pendingHandoff;
        if (pending && pending.operationId === event.operation_id
            && (event.status === 'applied' || event.status === 'rejected')) {
          this._pendingHandoff = null;
          clearTimeout(pending.timer);
          if (event.status === 'applied') this._applyHandoffAck(pending);
          pending.resolve(event);
        }
      }
      if (event.type === 'tool_job_narration') this._applyNarrationAck(event);
      if (event.type === 'tool_interaction_update_ack'
          && typeof event.interaction_id === 'string') {
        const queue = this._pendingInteractionUpdates.get(event.interaction_id);
        if (queue && queue.length) {
          // The oldest pending whose REQUESTED state matches the ack's echo: the server
          // always echoes the requested state, so every live caller's ack state-matches. A
          // client-side timeout removes its queue entry but not the server's eventual answer
          // -- that orphaned, unmatched ack is dropped rather than handed to the next caller.
          const index = queue.findIndex((entry) => entry.state === event.state);
          if (index !== -1) {
            const [pending] = queue.splice(index, 1);
            if (!queue.length) this._pendingInteractionUpdates.delete(event.interaction_id);
            clearTimeout(pending.timer);
            pending.resolve(event);
          }
        }
      }
      this._applyReflex(event);
      this.dispatchEvent(new CustomEvent(event.type, { detail: event }));
      this.dispatchEvent(new CustomEvent('event', { detail: event }));
      return event;
    }
    const samples = await binaryToFloat32(data);
    if (generation !== this._lifecycleGeneration) return null;
    const detail = { type: 'audio', sr: SAMPLE_RATE, samples };
    this.dispatchEvent(new CustomEvent('audio', { detail }));
    this.dispatchEvent(new CustomEvent('event', { detail }));
    if (this._responding) {
      this.audioQueue = this.audioQueue
        .catch(() => {})
        // Re-check responding AFTER the await: a `canceled` can land (and clear the player) while
        // this enqueue is in flight; without the recheck the discarded tail would resurrect playback.
        .then(async () => {
          if (!this._responding || generation !== this._lifecycleGeneration) return;
          await this.player?.enqueue?.(samples);
          const hold = this._playbackHold;
          const retained = Math.round(this.player?.pendingMs?.() ?? 0);
          if (hold && retained > 3000 && !hold.bufferError) {
            hold.bufferError = true;
            this._sendControl({ type: 'client_event', event: 'playback_paused',
              hold_id: hold.hold_id, turn_id: hold.turn_id,
              retained_ms: retained, remaining_ms: Math.round(this.player?.deviceLatencyMs?.() ?? 0),
              error: 'buffer_limit' });
          }
        })
        .catch((err) => {
          this.dispatchEvent(new CustomEvent('error', { detail: { type: 'error', error: err } }));
        });
      await this.audioQueue;
    }
    return detail;
  }
}
