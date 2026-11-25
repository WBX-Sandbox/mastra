# Examples

Both examples need a WBX Sandbox API key and a model key for Mastra:

```sh
npm install @wbx-sandbox/mastra @mastra/core
export WBXSANDBOX_API_KEY=...        # https://sandbox.wbx.cz
export OPENAI_API_KEY=...            # or another provider Mastra supports; pick it with MODEL
```

| Example | What the agent does |
|---|---|
| `fix-tests.mjs` | Runs the tests of a small Python project in the sandbox, fixes the bug, runs them again. |
| `csv-chart.mjs` | Reads a CSV, installs matplotlib if needed (network limited to PyPI), saves a chart; the PNG is downloaded as `chart.png`. |

```sh
MODEL=openai/gpt-5-mini node examples/fix-tests.mjs
MODEL=anthropic/claude-sonnet-4-6 node examples/csv-chart.mjs
```

Each example deletes its sandbox at the end. `test/examples.live.test.mjs` runs both with a scripted
model, so they are checked against real sandboxes without a model key.
