// Example: an agent fixes a failing test in a small Python project inside a WBX sandbox.
//
//   export WBXSANDBOX_API_KEY=...      # https://sandbox.wbx.cz
//   export OPENAI_API_KEY=...          # or another provider supported by Mastra
//   MODEL=openai/gpt-5-mini node examples/fix-tests.mjs
import { Agent } from "@mastra/core/agent";
import { Workspace } from "@mastra/core/workspace";
import { WBXSandbox } from "@wbx-sandbox/mastra";

const PROJECT = {
  "/home/user/project/calc.py": "def average(values):\n    return sum(values) / (len(values) + 1)\n",
  "/home/user/project/test_calc.py":
    "import unittest\nfrom calc import average\n\n\nclass TestAverage(unittest.TestCase):\n    def test_average(self):\n        self.assertEqual(average([2, 4, 6]), 4)\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
};

/** Runs the example with the given Mastra model; returns { answer, testsPass }. */
export async function run(model, { id = `fix-tests-${Date.now().toString(36)}`, keep = false } = {}) {
  const sandbox = new WBXSandbox({ id, template: "base", workingDirectory: "/home/user/project", lifetimeSeconds: 900 });
  const workspace = new Workspace({ sandbox });
  try {
    await workspace.init();
    await sandbox.writeFiles(Object.entries(PROJECT).map(([path, content]) => ({ path, content })));
    const agent = new Agent({
      id: "fixer",
      name: "Test fixer",
      instructions: "You fix bugs. Run the tests with `python3 -m unittest -v`, fix the code (not the tests), run the tests again.",
      model,
      workspace,
    });
    const res = await agent.generate("The tests in /home/user/project fail. Find the bug and fix it.", { maxSteps: 10 });
    const check = await sandbox.executeCommand("python3 -m unittest -q");
    return { answer: res.text, testsPass: check.exitCode === 0 };
  } finally {
    if (!keep) await workspace.destroy().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { answer, testsPass } = await run(process.env.MODEL ?? "openai/gpt-5-mini");
  console.log(answer);
  console.log(testsPass ? "\n✔ tests pass in the sandbox" : "\n✘ tests still fail");
  process.exitCode = testsPass ? 0 : 1;
}
