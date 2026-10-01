// Semantic localhost bridge for a normal, visible Pi TUI. This uses Pi's extension API only:
// no terminal scraping, keystroke injection, or hidden RPC process.
export default function (pi) {
  const url = process.env.CONVERSE_CODE_PI_BRIDGE_URL;
  let socket = null;
  let context = null;
  let reconnectTimer = null;
  let allowForSession = false;
  let nextApprovalId = 1;
  const expectedInputs = [];
  const pendingApprovals = new Map();

  pi.registerTool({
    name: "pi_session_model",
    label: "Pi session model",
    description: "Read or change the model hosting this Pi session. Omit provider and model to inspect current and available models; provide both to select an exact available model.",
    promptSnippet: "Inspect or change the model hosting the current Pi session",
    parameters: {
      type: "object",
      properties: {
        provider: {type: "string", description: "Exact provider id from the available models"},
        model: {type: "string", description: "Exact model id from the available models"},
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const availableModels = ctx.modelRegistry.getAvailable();
      const available = availableModels.map((item) => `${item.provider}/${item.id}`);
      const requested = params.provider && params.model
        ? `${params.provider}/${params.model}`
        : null;
      if ((params.provider && !params.model) || (!params.provider && params.model)) {
        return {
          content: [{type: "text", text: JSON.stringify({error: "provider_and_model_required", available})}],
          details: {error: "provider_and_model_required", available},
          isError: true,
        };
      }
      if (requested) {
        const selected = availableModels.find(
          (item) => item.provider === params.provider && item.id === params.model,
        );
        if (!selected) {
          return {
            content: [{type: "text", text: JSON.stringify({error: "model_unavailable", requested, available})}],
            details: {error: "model_unavailable", requested, available},
            isError: true,
          };
        }
        const changed = await pi.setModel(selected);
        if (!changed) {
          return {
            content: [{type: "text", text: JSON.stringify({error: "model_change_rejected", requested})}],
            details: {error: "model_change_rejected", requested},
            isError: true,
          };
        }
      }
      const current = requested || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
      const details = {current, available};
      return {content: [{type: "text", text: JSON.stringify(details)}], details};
    },
  });

  const send = (frame) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const setStatus = (text) => {
    if (context) context.ui.setStatus("converse-code", text);
  };

  const respond = (id, success, error, data = {}) => {
    send({type: "response", id, success, ...data, ...(error ? {error: String(error)} : {})});
  };

  const injectUserMessage = (id, message, options) => {
    const expected = {id, message};
    expectedInputs.push(expected);
    try {
      pi.sendUserMessage(message, options);
    } catch (error) {
      const index = expectedInputs.indexOf(expected);
      if (index >= 0) expectedInputs.splice(index, 1);
      throw error;
    }
  };

  const resolvePendingApprovals = (decision, reason) => {
    for (const [id, pending] of pendingApprovals) {
      clearTimeout(pending.timer);
      pending.resolve({decision, ...(reason ? {reason} : {})});
      pendingApprovals.delete(id);
    }
  };
  const failPendingApprovals = (reason) => resolvePendingApprovals("block", reason);

  const handleCommand = async (frame) => {
    if (!context || typeof frame?.id !== "string" || !frame.id) return;
    try {
      if (frame.type === "prompt") {
        if (typeof frame.message !== "string") throw new Error("a prompt is required");
        const message = frame.message.trim();
        if (!message) throw new Error("a prompt is required");
        if (!context.isIdle()) throw new Error("Pi is already working; steer it instead");
        injectUserMessage(frame.id, message);
      } else if (frame.type === "steer") {
        if (typeof frame.message !== "string") throw new Error("a message is required");
        const message = frame.message.trim();
        if (!message) throw new Error("a message is required");
        if (context.isIdle()) throw new Error("Pi is no longer working on an active turn");
        injectUserMessage(frame.id, message, {deliverAs: "steer"});
      } else if (frame.type === "abort") {
        failPendingApprovals("the coding task was cancelled");
        context.abort();
      } else if (frame.type === "approval_response") {
        if (typeof frame.approvalId !== "string" || !frame.approvalId) {
          throw new Error("approval id is required");
        }
        if (!["allow_once", "allow_session", "block"].includes(frame.decision)) {
          throw new Error("invalid approval decision");
        }
        const pending = pendingApprovals.get(frame.approvalId);
        if (!pending) throw new Error("approval is no longer pending");
        pendingApprovals.delete(frame.approvalId);
        clearTimeout(pending.timer);
        if (frame.decision === "allow_session") {
          allowForSession = true;
          resolvePendingApprovals("allow_session");
        }
        pending.resolve({decision: frame.decision});
      } else if (frame.type === "shutdown") {
        respond(frame.id, true);
        setTimeout(() => context.shutdown(), 0);
        return;
      } else {
        throw new Error(`unsupported bridge command: ${frame.type}`);
      }
      respond(frame.id, true);
    } catch (error) {
      respond(frame.id, false, error?.message || error);
    }
  };

  const connect = () => {
    if (!url || !context) return;
    setStatus("Dialt voice: connecting");
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      setStatus("Dialt voice: connected");
      send({type: "bridge_ready"});
    });
    socket.addEventListener("message", async (event) => {
      try {
        if (typeof event.data !== "string") throw new Error("bridge command must be JSON text");
        await handleCommand(JSON.parse(event.data));
      }
      catch (error) { send({type: "extension_error", error: String(error)}); }
    });
    socket.addEventListener("close", () => {
      failPendingApprovals("the Dialt approval bridge disconnected");
      socket = null;
      if (context) {
        setStatus("Dialt voice: reconnecting");
        reconnectTimer = setTimeout(connect, 500);
      }
    });
    socket.addEventListener("error", () => socket?.close());
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    connect();
  });
  pi.on("input", (event) => {
    const expected = expectedInputs[0];
    if (event.source === "extension" && expected && event.text === expected.message) {
      expectedInputs.shift();
      send({
        type: "input_seen",
        owner: "bridge",
        commandId: expected.id,
      });
      return;
    }
    expectedInputs.length = 0;
    failPendingApprovals("unrelated terminal or extension input interrupted approval");
    send({
      type: "input_seen",
      owner: event.source === "interactive" ? "interactive" : "other",
    });
  });
  pi.on("agent_start", (event) => send({type: event.type}));
  pi.on("tool_execution_start", (event) => send({
    type: event.type,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: event.args,
  }));
  pi.on("tool_call", async (event) => {
    if (allowForSession || !["bash", "edit", "write"].includes(event.toolName)) return;
    if (socket?.readyState !== WebSocket.OPEN) {
      return {block: true, reason: "Blocked because Dialt approval is disconnected."};
    }
    const input = event.input || {};
    const supplied = event.toolName === "bash" ? input.command : (input.path || input.file_path);
    const fallback = event.toolName === "bash" ? "shell command" : "project file";
    const target = typeof supplied === "string" && supplied ? supplied : fallback;
    const summary = target.replace(/\s+/g, " ").slice(0, 180);
    const approvalId = `approval-${nextApprovalId++}`;
    setStatus(`Waiting for approval: ${event.toolName}`);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(approvalId);
        send({type: "approval_expired", approvalId});
        resolve({decision: "block", reason: "approval timed out"});
      }, 300000);
      pendingApprovals.set(approvalId, {resolve, timer});
      send({type: "approval_request", approvalId, toolName: event.toolName, summary});
    });
    setStatus("Dialt voice: connected");
    if (result.decision === "block") {
      const reason = result.reason
        ? `Blocked because ${result.reason}: ${target}`
        : `Blocked by the user: ${target}`;
      return {block: true, reason};
    }
  });
  pi.on("message_end", (event) => send({type: event.type, message: event.message}));
  pi.on("agent_settled", (event) => {
    send({type: event.type});
    expectedInputs.length = 0;
  });
  pi.on("session_shutdown", () => {
    expectedInputs.length = 0;
    failPendingApprovals("the Pi session ended");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    send({type: "session_shutdown"});
    context = null;
    socket?.close();
  });
}
