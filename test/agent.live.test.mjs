// A Mastra Agent with a WBXSandbox workspace does a real task: the model (scripted, so no
// model API key is needed) writes a script with the workspace tools, runs it in the sandbox
// and reports the result it read from the tool output. Needs WBXSANDBOX_API_KEY.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "@mastra/core/agent";
import { Workspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";

import { WBXSandbox } from "../dist/index.js";

const KEY = process.env.WBXSANDBOX_API_KEY;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** Tool output of the last tool call in the prompt, as text. */
function lastToolOutput(prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== "tool") continue;
    const part = m.content.findLast((p) => p.type === "tool-result");
    const o = part?.output;
    if (!o) continue;
    if (o.type === "text" || o.type === "error-text") return o.value;
    return JSON.stringify(o.value);
  }
  return "";
}

test("agent writes and runs a script in the sandbox", { skip: !KEY && "WBXSANDBOX_API_KEY is not set", timeout: 300_000 }, async () => {
  const sandbox = new WBXSandbox({ id: `mtest-agent-${Date.now().toString(36)}`, lifetimeSeconds: 600 });
  const ws = new Workspace({ sandbox });
  const steps = [];
  /** One model step: a tool call first, then an answer from the tool output. */
  function step({ prompt, tools }) {
    const n = steps.length;
    steps.push({ tools: (tools ?? []).map((t) => t.name) });
    if (n === 0) {
      return {
        content: [{
          type: "tool-call",
          toolCallId: "call_0",
          toolName: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
          input: JSON.stringify({ command: "cat > primes.py <<'EOF'\nprint([n for n in range(2, 30) if all(n % d for d in range(2, n))])\nEOF\npython3 primes.py" }),
        }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
      };
    }
    const out = lastToolOutput(prompt);
    steps[n].seen = out;
    return { content: [{ type: "text", text: `The script printed: ${out.match(/\[[\d, ]+\]/)?.[0] ?? out}` }], finishReason: { unified: "stop", raw: "stop" } };
  }
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => ({ ...step(opts), usage, warnings: [] }),
    doStream: async (opts) => {
      const r = step(opts);
      const chunks = [{ type: "stream-start", warnings: [] }];
      for (const c of r.content) {
        if (c.type === "text") chunks.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: c.text }, { type: "text-end", id: "t" });
        else chunks.push(c);
      }
      chunks.push({ type: "finish", finishReason: r.finishReason, usage });
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
  const agent = new Agent({ id: "code-agent", name: "Code Agent", instructions: "Use the sandbox to run code.", model, workspace: ws });
  try {
    const res = await agent.generate("Write a Python script that lists primes below 30, run it and tell me the output.", { maxSteps: 4 });
    assert.ok(steps[0].tools.includes(WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND), `tools: ${steps[0].tools.join(", ")}`);
    assert.match(steps[1].seen, /\[2, 3, 5, 7, 11, 13, 17, 19, 23, 29\]/);
    assert.match(res.text, /\[2, 3, 5, 7, 11, 13, 17, 19, 23, 29\]/);
    // the file really is in the sandbox
    const r = await sandbox.executeCommand("cat primes.py");
    assert.match(r.stdout, /range\(2, 30\)/);
  } finally {
    await ws.destroy().catch(() => undefined);
    await sandbox._destroy().catch(() => undefined);
  }
});
