// Example: an agent turns a CSV file into a chart inside a WBX sandbox; the PNG is downloaded.
//
//   export WBXSANDBOX_API_KEY=...      # https://sandbox.wbx.cz
//   export OPENAI_API_KEY=...          # or another provider supported by Mastra
//   MODEL=openai/gpt-5-mini node examples/csv-chart.mjs     # writes chart.png
import { writeFile } from "node:fs/promises";

import { Agent } from "@mastra/core/agent";
import { Workspace } from "@mastra/core/workspace";
import { WBXSandbox } from "@wbx-sandbox/mastra";

const CSV = "month,visitors\nJan,1200\nFeb,1350\nMar,1610\nApr,1580\nMay,1920\nJun,2240\n";

/** Runs the example with the given Mastra model; returns { answer, png } (png = chart bytes or null). */
export async function run(model, { id = `csv-chart-${Date.now().toString(36)}`, out } = {}) {
  const sandbox = new WBXSandbox({ id, template: "code-interpreter", lifetimeSeconds: 900, network: { mode: "allowlist", allow: ["pypi.org", "files.pythonhosted.org"] } });
  const workspace = new Workspace({ sandbox });
  try {
    await workspace.init();
    await sandbox.writeFiles([{ path: "/home/user/visitors.csv", content: CSV }]);
    const agent = new Agent({
      id: "analyst",
      name: "Data analyst",
      instructions: "You analyse data with Python in your sandbox. Install packages with pip when you need them.",
      model,
      workspace,
    });
    const res = await agent.generate(
      "Make a line chart of /home/user/visitors.csv and save it as /home/user/chart.png. Then tell me the month with the most visitors.",
      { maxSteps: 10 },
    );
    let png = null;
    try {
      png = await sandbox.wbx.files.read("/home/user/chart.png");
      if (out) await writeFile(out, png);
    } catch {
      png = null;
    }
    return { answer: res.text, png };
  } finally {
    await workspace.destroy().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { answer, png } = await run(process.env.MODEL ?? "openai/gpt-5-mini", { out: "chart.png" });
  console.log(answer);
  console.log(png ? `\n✔ chart.png saved (${png.length} bytes)` : "\n✘ no chart was made");
  process.exitCode = png ? 0 : 1;
}
