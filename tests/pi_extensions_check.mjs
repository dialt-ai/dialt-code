import bridgeExtension from "../converse_code/pi_bridge.ts";

class FakeSocket {
  static OPEN = 1;
  static latest = null;
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.listeners = new Map();
    this.frames = [];
    FakeSocket.latest = this;
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  emit(name, value = {}) { this.listeners.get(name)?.(value); }
  send(value) { this.frames.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}

globalThis.WebSocket = FakeSocket;
process.env.CONVERSE_CODE_PI_BRIDGE_URL = "ws://127.0.0.1:1234/pi?t=test";

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    tools: new Map(),
    userMessages: [],
    on(name, callback) { handlers.set(name, callback); },
    registerTool(tool) { this.tools.set(tool.name, tool); },
    async setModel(model) {
      this.selectedModel = model;
      return true;
    },
    sendUserMessage(message, options) {
      this.userMessages.push({message, options});
      handlers.get("input")?.({text: message, source: "extension", streamingBehavior: options?.deliverAs});
    },
  };
}

const pi = fakePi();
let idle = true;
const statuses = [];
const context = {
  isIdle: () => idle,
  abort: () => { context.aborted = true; },
  shutdown: () => { context.shutDown = true; },
  model: {provider: "openai-codex", id: "gpt-5.6-terra", name: "GPT-5.6 Terra"},
  scopedModels: [],
  modelRegistry: {
    getAvailable: () => [
      {provider: "openai-codex", id: "gpt-5.6-terra", name: "GPT-5.6 Terra"},
      {provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol"},
    ],
  },
  ui: {setStatus: (_id, text) => statuses.push(text)},
};
bridgeExtension(pi);
const modelTool = pi.tools.get("pi_session_model");
if (!modelTool) throw new Error("Pi cannot inspect or change its own session model");
const modelState = await modelTool.execute("model-1", {}, undefined, undefined, context);
if (modelState.details.current !== "openai-codex/gpt-5.6-terra") {
  throw new Error("Pi model tool did not report the authoritative current model");
}
if (!modelState.details.available.includes("openai-codex/gpt-5.6-sol")) {
  throw new Error("Pi model tool did not report available models");
}
const changedModel = await modelTool.execute(
  "model-2", {provider: "openai-codex", model: "gpt-5.6-sol"}, undefined, undefined, context,
);
if (changedModel.isError || pi.selectedModel?.id !== "gpt-5.6-sol") {
  throw new Error("Pi model tool did not change the host session model semantically");
}
pi.handlers.get("session_start")({}, context);
const socket = FakeSocket.latest;
socket.emit("open");
socket.emit("message", {data: JSON.stringify({id: "bad", type: "prompt", message: 42})});
if (pi.userMessages.length !== 0) throw new Error("malformed prompt entered the Pi domain");
const malformed = socket.frames.find((frame) => frame.id === "bad");
if (malformed?.success !== false) throw new Error("malformed prompt was not rejected");
socket.emit("message", {data: JSON.stringify({id: "p1", type: "prompt", message: "Fix it"})});
idle = false;
socket.emit("message", {data: JSON.stringify({id: "s1", type: "steer", message: "Also test"})});
pi.handlers.get("agent_start")({type: "agent_start"});
pi.handlers.get("tool_execution_start")({
  type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: {path: "app.py"},
});
pi.handlers.get("message_end")({type: "message_end", message: {role: "assistant", content: "Done"}});
pi.handlers.get("agent_settled")({type: "agent_settled"});

if (pi.userMessages.length !== 2) throw new Error("bridge did not inject both user messages");
if (pi.userMessages[0].message !== "Fix it" || pi.userMessages[0].options !== undefined) {
  throw new Error("idle prompt was not injected as a normal visible-TUI user turn");
}
if (pi.userMessages[1].options?.deliverAs !== "steer") throw new Error("steer was not semantic");
const types = socket.frames.map((frame) => frame.type);
for (const expected of ["bridge_ready", "response", "agent_start", "tool_execution_start", "message_end", "agent_settled"]) {
  if (!types.includes(expected)) throw new Error(`missing extension frame: ${expected}`);
}
const ownedInputs = socket.frames.filter((frame) => frame.type === "input_seen");
if (ownedInputs.length !== 2 || ownedInputs.some((frame) => frame.owner !== "bridge")) {
  throw new Error("bridge inputs were not explicitly owned");
}
if (ownedInputs[0].commandId !== "p1" || ownedInputs[1].commandId !== "s1") {
  throw new Error("bridge input ownership was not command-correlated");
}
if (!statuses.includes("Dialt voice: connected")) throw new Error("visible status was not set");

const approval = pi.handlers.get("tool_call")({
  toolCallId: "tool-approval-1", toolName: "bash", input: {command: "uv run pytest -q"},
}, context);
await new Promise((resolve) => setTimeout(resolve, 1));
const request = socket.frames.find((frame) => frame.type === "approval_request");
if (!request || !request.summary.includes("uv run pytest -q")) {
  throw new Error("semantic approval request omitted the command");
}
if (typeof context.ui.select === "function") {
  throw new Error("approval must not open a terminal selection menu");
}
socket.emit("message", {data: JSON.stringify({
  id: "a1", type: "approval_response", approvalId: request.approvalId, decision: "block",
})});
const decision = await approval;
if (decision?.block !== true) throw new Error("remote block did not block the tool");

socket.emit("message", {data: JSON.stringify({id: "x1", type: "shutdown"})});
await new Promise((resolve) => setTimeout(resolve, 1));
if (context.shutDown !== true) throw new Error("shutdown was not semantic");

const disconnectedPi = fakePi();
const disconnectedContext = {
  isIdle: () => false,
  abort: () => {},
  shutdown: () => {},
  ui: {setStatus: () => {}},
};
bridgeExtension(disconnectedPi);
disconnectedPi.handlers.get("session_start")({}, disconnectedContext);
const disconnectedSocket = FakeSocket.latest;
disconnectedSocket.emit("open");
const disconnectedApproval = disconnectedPi.handlers.get("tool_call")({
  toolCallId: "tool-approval-2", toolName: "edit", input: {path: "app.py"},
}, disconnectedContext);
await new Promise((resolve) => setTimeout(resolve, 1));
disconnectedSocket.emit("close");
const disconnectedDecision = await disconnectedApproval;
if (disconnectedDecision?.block !== true || !disconnectedDecision.reason.includes("disconnected")) {
  throw new Error("bridge loss did not fail the pending approval closed");
}
disconnectedPi.handlers.get("session_shutdown")();

console.log("Pi extension contract: passed");
