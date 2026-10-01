// AudioWorkletProcessor that re-injects mic frames into a real audio graph so they can be captured
// back out via a MediaStreamAudioDestinationNode and handed to RTCPeerConnection.addTrack() as the
// outbound mic track for the webrtc transport. This is what negotiates the offer's audio m-line at
// signaling time, and stays the ACTIVE uplink only for custom-capture callers (no startMic()) or
// the SDK's own AEC3-canceller path — see src/webrtc.js's header for the full rationale; the normal
// startMic() path replaces this feeder's track with the real device track once available, at which
// point the ~PREBUFFER_FRAMES*32ms latency this file adds no longer applies to the live uplink.
// Frames arrive one 512-sample/16 kHz Float32Array at a time via postMessage.
//
// The feeder's AudioContext is created at 16 kHz (src/webrtc.js), matching this source rate exactly,
// so process() is a straight queue-fed passthrough: no resampling here. (An earlier version of this
// file linearly interpolated 16k -> the device's default context rate, typically 48 kHz — a
// low-quality resampler whose artifacts Opus baked into the encoded stream, diagnosed live as
// mid-stream ASR degradation. Chrome/Firefox now resample the outbound track to Opus's 48k
// internally with their own production resampler instead.)
//
// Frames arrive via postMessage from the main thread in bursts (batched with UI/network work),
// not steadily every 32 ms — draining the queue the instant any audio is available reproduces that
// burstiness as mid-word gaps whenever a burst is late. So draining is gated by a small adaptive
// prebuffer: process() emits silence until PREBUFFER_FRAMES have queued, and re-arms that wait
// after any underrun rather than resuming on the very next single frame (which would just re-open
// the same gap on the next burst gap). This trades ~PREBUFFER_FRAMES * 32ms of extra uplink latency
// for gap-free audio.
const PREBUFFER_FRAMES = 3; // 3 * 32 ms/frame = ~96 ms of buffer before (re-)starting playback.
// 512 samples/frame @ 16 kHz = 32 ms/frame, so 250 frames ~= 8 s of buffered mic audio. Caps
// memory if the outbound track ever falls behind (e.g. a stalled encoder) — process() consumes
// oldest-first, so an unbounded queue would otherwise grow forever and the caller would hear
// increasingly stale audio rather than current audio.
const MAX_QUEUE_FRAMES = 250;

class TrackFeederProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];          // pending 16 kHz Float32Array frames, oldest first
    this.offset = 0;          // read position (samples) into queue[0]
    this.muted = false;       // true feeds silence without discarding queued frames
    this.prebuffering = true; // true until PREBUFFER_FRAMES have queued; re-armed on underrun
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'frame') {
        if (this.queue.length >= MAX_QUEUE_FRAMES) this.queue.shift();   // drop oldest, never block
        this.queue.push(msg.frame);
      } else if (msg.type === 'mute') this.muted = !!msg.value;
      else if (msg.type === 'reset') { this.queue = []; this.offset = 0; this.prebuffering = true; }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (this.muted) { output.fill(0); return true; }

    if (this.prebuffering) {
      if (this.queue.length < PREBUFFER_FRAMES) { output.fill(0); return true; }
      this.prebuffering = false;
    }

    for (let i = 0; i < output.length; i += 1) {
      if (this.queue.length === 0) {
        // Underrun: fill the rest of this quantum with silence and wait for a fresh prebuffer
        // rather than draining the very next single frame the instant it arrives — that would just
        // reopen the same gap on the next delivery burst.
        output.fill(0, i);
        this.prebuffering = true;
        return true;
      }
      const frame = this.queue[0];
      output[i] = frame[this.offset];
      this.offset += 1;
      if (this.offset >= frame.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('voice-loop-track-feeder', TrackFeederProcessor);
