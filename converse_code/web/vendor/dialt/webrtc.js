// WebRTC transport support for DialtClient - see serving/broker_webrtc.py's module docstring
// for the full wire contract this mirrors. Two independent pieces live here:
//
//   TrackFeeder  — turns mic frames (whatever startMic()/pushMicFrame() would otherwise ws.send()
//                  as PCM16) into a real outbound MediaStreamTrack, by re-injecting them through an
//                  AudioWorkletNode into a MediaStreamAudioDestinationNode. RTCPeerConnection.
//                  addTrack() needs a live MediaStreamTrack before the offer/ICE-gather/answer
//                  exchange even happens - and that exchange has to complete before DialtClient
//                  knows whether the app will call startMic() at all (connect() resolves first) —
//                  so this feeder's track is always what negotiates the offer's audio m-line.
//                  Once startMic() runs (the normal path: no forced SDK-side AEC), DialtClient
//                  replaceTrack()s the sender straight onto the real getUserMedia device track —
//                  zero added JS hops/latency, no renegotiation needed — and this feeder goes idle.
//                  It stays the ACTIVE uplink only for callers with no MicCapture at all (custom
//                  capture via pushMicFrame()/appendAudio()) or for the rare case startMic() is
//                  forced onto the SDK's own AEC3 canceller (sdkAec:true), where re-injecting the
//                  already-canceled frames is required — handing the raw device track over in that
//                  case would ship uncancelled audio instead.
//
//   WebRtcSession — the client's half of the peer-connection lifecycle: creates the "control" data
//                   channel and the mic track, builds an offer, waits for ICE gathering to
//                   complete (trickle ICE is NOT used — ADR: simpler signaling, one signaling
//                   round-trip, acceptable latency for a single-hop broker-terminated call), and
//                   later applies the server's answer.
//
// Both are deliberately dumb/mockable: DialtClient owns all protocol semantics (start frame,
// ready/bye handling, reconnection policy); this module only knows WebRTC plumbing.

import { addWorkletModule, defaultWorkletModuleUrls } from './worklet-url.js';

const STUN_URL = 'stun:stun.l.google.com:19302';

// The SDK's mic pipeline always produces 16 kHz Float32 frames (see mic-worklet.js) — the feeder's
// AudioContext is created at this same rate so the injection worklet needs no resampling.
const SOURCE_RATE = 16000;

export class TrackFeeder {
  constructor({ workletUrl } = {}) {
    const [defaultWorkletUrl, fallbackWorkletUrl] = defaultWorkletModuleUrls(
      // Keep the primary URL literal here so ordinary bundlers emit the worklet asset.
      new URL('./track-feeder-worklet.js', import.meta.url),
      'track-feeder-worklet.js',
      import.meta.url,
    );
    this.workletUrl = workletUrl || defaultWorkletUrl;
    this.fallbackWorkletUrl = workletUrl ? null : fallbackWorkletUrl;
    this.context = null;
    this.worklet = null;
    this.destination = null;
  }

  async start() {
    if (this.context) return;
    try {
      // Run the feeder's AudioContext at the mic's native 16 kHz instead of the device's default
      // (typically 48 kHz). Previously the worklet linearly interpolated 16k -> context rate itself
      // — a low-quality resampler whose artifacts Opus then baked into the encoded stream, found
      // live as mid-stream ASR degradation on the dev box. With context rate == source rate the
      // worklet is a straight passthrough, and Chrome/Firefox resample the outbound track to Opus's
      // 48k internally using their own production resampler instead.
      //
      // No runtime fallback here: AudioContext({sampleRate}) is supported by every Chromium and
      // Firefox build this transport ships to, and WebKit never reaches this path at all (webrtc
      // transport falls back to ws on WebKit — see needsSdkAec() in index.js). If a browser ever
      // silently refuses the requested rate, log loudly rather than silently degrading audio.
      this.context = new AudioContext({ sampleRate: SOURCE_RATE });
      if (this.context.sampleRate !== SOURCE_RATE) {
        console.warn(
          `[voice-loop] AudioContext ignored the requested ${SOURCE_RATE} Hz sampleRate ` +
          `(got ${this.context.sampleRate} Hz); mic audio quality will be degraded.`
        );
      }
      await addWorkletModule(
        this.context.audioWorklet, this.workletUrl, this.fallbackWorkletUrl,
      );
      this.worklet = new AudioWorkletNode(this.context, 'voice-loop-track-feeder', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.destination = this.context.createMediaStreamDestination();
      this.worklet.connect(this.destination);
      await this.context.resume();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** The live outbound MediaStreamTrack to hand RTCPeerConnection.addTrack(). */
  get track() {
    return this.destination?.stream?.getAudioTracks?.()[0] || null;
  }

  /** Feed one already-processed 16 kHz Float32 mic frame (same data pushMicFrame would ws.send()).
   *  Deliberately NOT a transferable postMessage: pushMicFrame()'s `frame` argument may be a
   *  buffer a caller (custom capture integrations) still holds a reference to afterward — this
   *  copies (512 samples is cheap) rather than risk silently detaching someone else's array. */
  push(frame) {
    this.worklet?.port.postMessage({ type: 'frame', frame });
  }

  /** setMicEnabled(false) parity: feed silence without tearing the track down. */
  setMuted(muted) {
    this.worklet?.port.postMessage({ type: 'mute', value: !!muted });
  }

  async stop() {
    this.worklet?.disconnect();
    this.worklet = null;
    this.destination = null;
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
  }
}

// Gather-mostly-complete pattern (trickle ICE is not used): resolve once the offer's own ICE
// gathering is done — OR after a bounded wait with whatever candidates exist by then. The bound
// is load-bearing, found live on the dev box: with a TURN server in the config, Chrome can hold
// iceGatheringState off 'complete' for tens of seconds (slow relay allocation, a TURN URL whose
// transport doesn't answer), which starved the server's webrtc_offer timeout and the call never
// connected. Host + srflx + relay candidates all normally land well under this bound, so the SDP
// sent after it is the same one 'complete' would have carried.
const ICE_GATHER_TIMEOUT_MS = 3000;

function waitForIceGathering(pc, timeoutMs = ICE_GATHER_TIMEOUT_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, timeoutMs);
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class WebRtcSession {
  constructor({ RTCPeerConnectionImpl = globalThis.RTCPeerConnection, iceServers } = {}) {
    if (!RTCPeerConnectionImpl) throw new Error('RTCPeerConnection is required for transport: "webrtc"');
    // iceServers comes from the server's webrtc_ice frame (STUN + short-lived TURN creds when
    // coturn is configured) — that's why signaling is two-step: the peer connection must be built
    // WITH these before gathering starts, or TURN could never be used. Default STUN is only the
    // fallback for a server that sent none.
    this.pc = new RTCPeerConnectionImpl({ iceServers: iceServers || [{ urls: [STUN_URL] }] });
  }

  /** Create the client-side "control" data channel the wire contract requires by name. */
  createControlChannel() {
    return this.pc.createDataChannel('control');
  }

  /** Returns the RTCRtpSender so the caller can later replaceTrack() a real capture device's
   *  track in directly (see DialtClient.startMic) without renegotiating. */
  addAudioTrack(track) {
    return this.pc.addTrack(track);
  }

  /** Register a callback for the server's outbound audio track (assistant voice). */
  onRemoteTrack(handler) {
    this.pc.addEventListener('track', (ev) => {
      if (ev.track?.kind && ev.track.kind !== 'audio') return;
      const stream = ev.streams?.[0]
        || (typeof MediaStream !== 'undefined' ? new MediaStream([ev.track]) : null);
      handler(stream, ev.track);
    });
  }

  onConnectionStateChange(handler) {
    this.pc.addEventListener('connectionstatechange', () => handler(this.pc.connectionState));
  }

  /** Create the offer, set it local, wait for ICE gathering to finish, and return the final SDP. */
  async createOfferWithGatheredIce() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIceGathering(this.pc);
    return this.pc.localDescription.sdp;
  }

  async applyAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  close() {
    try { this.pc.close(); } catch { /* already closed */ }
  }
}
