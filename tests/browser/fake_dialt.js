const state = globalThis.__fakeDialt = Object.assign({
  clients: [],
  transportLive: true,
}, globalThis.__fakeDialt || {});

export function createSessionId() {
  return "browser-e2e-session";
}

export class DialtClient extends EventTarget {
  constructor(options) {
    super();
    // Mirror the real SDK: 0.48 rejects every mode kind except "dialt".
    if (options.mode?.kind !== "dialt") throw new TypeError("mode.kind must be dialt");
    this.options = options;
    this.sessionId = options.sessionId;
    this.bridgeCalls = [];
    this.toolChoices = [];
    this.stream = null;
    state.clients.push(this);
  }

  async unlockAudio() {}

  async connect() {
    if (state.connectHold) {
      await new Promise((resolve) => { state.releaseConnect = resolve; });
    }
  }

  async startMic() {
    this.emit({type: "warming_up", attempt: 1, device_id: null});
    if (state.startMicError) {
      const error = new Error(state.startMicError);
      this.emit({type: "failed", code: "capture_failed", error});
      throw error;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
    this.emit({type: "listening", device_id: "default", recovered: false});
  }

  stopMic() {
    if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  setMicEnabled(enabled) {
    this.micEnabled = enabled;
  }

  setToolChoice(choice) {
    this.toolChoices.push(choice);
  }

  sendToolResult(id, content, options) {
    if (state.transportLive) this.bridgeCalls.push({action: "tool_result", id, content, options});
    return state.transportLive;
  }
  sendToolDeferred(id, options) {
    if (state.transportLive) this.bridgeCalls.push({action: "tool_deferred", id, options});
    return state.transportLive;
  }
  sendToolPartialResult(id, content, options) {
    if (state.transportLive) {
      this.bridgeCalls.push({action: "tool_partial_result", id, content, options});
    }
    return state.transportLive;
  }
  async sendToolInteractionUpdate(id, interactionId, stateName, options) {
    if (!state.transportLive) throw new Error("transport unavailable");
    this.bridgeCalls.push({
      action: "tool_interaction_update", id, interactionId, state: stateName, options,
    });
    if (state.interactionUpdateHold) {
      await new Promise((resolve) => { state.releaseInteractionUpdate = resolve; });
    }
    return state.interactionUpdateAck || {
      type: "tool_interaction_update_ack", id, interaction_id: interactionId,
      state: stateName, applied: true, reason: null,
    };
  }
  close() { this.closed = true; this.stopMic(); }
  async closeAndWait() { this.close(); }

  emit(detail) {
    this.dispatchEvent(new CustomEvent("event", {detail}));
  }
}
