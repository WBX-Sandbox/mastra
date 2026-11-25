// Runs both examples against real WBX sandboxes with a scripted model (no model API key needed):
// the model issues the commands an LLM would, the sandbox does the real work. Needs WBXSANDBOX_API_KEY.
import assert from "node:assert/strict";
import { test } from "node:test";

import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";

import { run as runChart } from "../examples/csv-chart.mjs";
import { run as runFix } from "../examples/fix-tests.mjs";

const skip = !process.env.WBXSANDBOX_API_KEY && "WBXSANDBOX_API_KEY is not set";
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

/** A model that runs the given commands one by one, then answers with `final(lastOutput)`. */
function scripted(commands, final) {
  let n = 0;
  const lastOut = (prompt) => {
    const m = prompt.findLast((x) => x.role === "tool");
    const o = m?.content.findLast((p) => p.type === "tool-result")?.output;
    return o ? (typeof o.value === "string" ? o.value : JSON.stringify(o.value)) : "";
  };
  const step = ({ prompt }) => {
    const i = n++;
    if (i < commands.length) {
      return {
        content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND, input: JSON.stringify({ command: commands[i] }) }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
      };
    }
    return { content: [{ type: "text", text: final(lastOut(prompt)) }], finishReason: { unified: "stop", raw: "stop" } };
  };
  return new MockLanguageModelV3({
    doGenerate: async (o) => ({ ...step(o), usage, warnings: [] }),
    doStream: async (o) => {
      const r = step(o);
      const chunks = [{ type: "stream-start", warnings: [] }];
      for (const c of r.content) {
        if (c.type === "text") chunks.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: c.text }, { type: "text-end", id: "t" });
        else chunks.push(c);
      }
      chunks.push({ type: "finish", finishReason: r.finishReason, usage });
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
}

test("example fix-tests: the bug is fixed in the sandbox", { skip, timeout: 300_000 }, async () => {
  const model = scripted(
    ["python3 -m unittest -v 2>&1 | tail -5", "sed -i 's/(len(values) + 1)/len(values)/' calc.py && cat calc.py", "python3 -m unittest -v 2>&1 | tail -3"],
    (out) => `Fixed the off-by-one in average(). Tests now: ${out.trim().split("\n").pop()}`,
  );
  const { answer, testsPass } = await runFix(model, { id: `mtest-fix-${Date.now().toString(36)}` });
  assert.equal(testsPass, true, answer);
  assert.match(answer, /OK/);
});

test("example csv-chart: a PNG chart comes back", { skip, timeout: 420_000 }, async () => {
  const py = [
    "python3 - <<'EOF'",
    "import csv",
    "import matplotlib",
    "matplotlib.use('Agg')",
    "import matplotlib.pyplot as plt",
    "rows = list(csv.DictReader(open('/home/user/visitors.csv')))",
    "plt.plot([r['month'] for r in rows], [int(r['visitors']) for r in rows], marker='o')",
    "plt.savefig('/home/user/chart.png')",
    "best = max(rows, key=lambda r: int(r['visitors']))",
    "print('best', best['month'])",
    "EOF",
  ].join("\n");
  const model = scripted(
    [`python3 -c 'import matplotlib' 2>/dev/null || pip install -q matplotlib 2>&1 | tail -2`, py],
    (out) => `The chart is saved; the ${out.match(/best (\w+)/)?.[1] ?? "?"} month had the most visitors.`,
  );
  const { answer, png } = await runChart(model, { id: `mtest-chart-${Date.now().toString(36)}` });
  assert.ok(png, answer);
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.match(answer, /Jun month/);
});
