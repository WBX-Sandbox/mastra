# @wbx-sandbox/mastra

[WBX Sandbox](https://sandbox.wbx.cz) provider for [Mastra](https://mastra.ai) workspaces. Your agent gets
its own isolated Linux computer – a Firecracker microVM in Europe where it is root – to run commands,
write files, start servers and open them at a public HTTPS address.

- **Sleeps instead of disappearing.** When the workspace stops, the sandbox falls asleep with its files;
  the next `start()` with the same `id` wakes it in seconds.
- **Background processes** with live output, stdin and kill.
- **Public HTTPS URLs** for ports (`sandbox.networking.getPortUrl(port)`).
- **Checkpoints**: `snapshot()` saves the disk; new sandboxes start from it.
- **Network control**: full internet, an allowlist of domains, or no network; IPv4, IPv6 or both.
- **Desktop control** (template `desktop`): screenshots, mouse and keyboard for computer-use agents.

## Install

```sh
npm install @wbx-sandbox/mastra @mastra/core
```

Requires Node.js 22.13 or newer and `@mastra/core` 1.80 or newer (1.x). Create an API key at
[sandbox.wbx.cz](https://sandbox.wbx.cz) and set it as `WBXSANDBOX_API_KEY`.

## Usage

```ts
import { Agent } from '@mastra/core/agent'
import { Workspace } from '@mastra/core/workspace'
import { WBXSandbox } from '@wbx-sandbox/mastra'

const workspace = new Workspace({
  sandbox: new WBXSandbox({ id: 'my-project', template: 'code-interpreter' }), // key from WBXSANDBOX_API_KEY
})

export const agent = new Agent({
  id: 'code-agent',
  name: 'Code Agent',
  instructions: 'You write and run code in your sandbox.',
  model: 'openai/gpt-5-mini',
  workspace,
})
```

The agent gets Mastra's workspace tools (run a command, background processes, files) and they run in the
sandbox. You can also use the sandbox directly:

```ts
const sandbox = new WBXSandbox({ id: 'my-project' })
await sandbox.start()
const r = await sandbox.executeCommand('python3', ['-c', 'print(6 * 7)'])
console.log(r.stdout) // 42

const server = await sandbox.processes.spawn('python3 -m http.server 8000')
console.log(await sandbox.networking.getPortUrl(8000)) // https://8000-….box.wbxbox.net/?wbx_token=…
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `id` | random `mastra-…` | Sandbox name (lower-case letters, digits, `.`, `_`, `-`). The same `id` reconnects to the same sandbox. |
| `sandboxId` | – | Attach to an existing sandbox by its ID (`sb_…`). |
| `apiKey` | `WBXSANDBOX_API_KEY` | API key. |
| `baseURL` | `https://sandbox.wbx.cz` | API address (`WBXSANDBOX_URL`). |
| `template` | `base` | `base`, `mini`, `node`, `go`, `rust`, `ubuntu`, `code-interpreter`, `browser`, `fullstack`, `desktop` |
| `computeClass` | your default | `economy`, `balanced`, `performance`, `memory`. |
| `network` | full internet | `{ mode: 'allowlist', allow: ['pypi.org'] }`, `{ mode: 'none' }`, `ip: 'dual'` for IPv6. |
| `lifetimeSeconds` | `3600` | After this the sandbox falls asleep (files kept). |
| `idleTimeoutSeconds` | – | Sleep after this many seconds without commands. |
| `keepDays` | plan default | How long a sleeping sandbox keeps its files. |
| `timeout` | `300000` | Default command timeout in ms. |
| `env` | – | Runtime environment for every command (`setEnv()` changes it). |
| `workingDirectory` | `/home/user` | Default directory of commands. |
| `onStopBehavior` | `sleep` | `stop()` puts the sandbox to sleep; `keep` leaves it running. |
| `checkpointName` | – | `snapshot()` saves a snapshot with this name; a new sandbox starts from the newest one. |
| `seedCheckpointName` | – | Snapshot for a brand-new sandbox when `checkpointName` has none yet. |
| `computer` | on for `desktop` | Desktop control tools. |
| `instructions` | built in | Text (or function of the defaults) given to the agent about the sandbox. |

## Lifecycle

| Mastra | WBX Sandbox |
|---|---|
| `start()` | Gets or creates the sandbox named `id` (a sleeping one wakes up). Reports `created` or `connected`. |
| `stop()` | Kills background processes started by this instance and puts the sandbox to sleep. |
| `destroy()` | Deletes the sandbox with its files. |
| `snapshot()` | With `checkpointName`: saves the disk (the older snapshot of that name is deleted). |
| `clone()` | A new, independent sandbox with the same configuration (no I/O until it starts). |

## Public URLs

`getPortUrl(port)` returns the address with an access token. A browser keeps the token as a cookie; a
script sends it as the `X-WBX-Token` header. The app must listen on `0.0.0.0`.

## Desktop

With the `desktop` template the workspace gets Mastra's computer tools (screenshot, click, type, scroll,
keys). The desktop is available to paying customers. The WBX API does not report the mouse position, so
`getCursorPosition()` returns the last position this provider moved the mouse to.

## Not supported yet

Mounting S3 / GCS filesystems into the sandbox.

## MastraEditor

```ts
import { MastraEditor } from '@mastra/editor'
import { wbxSandboxProvider } from '@wbx-sandbox/mastra'

const editor = new MastraEditor({ sandboxes: [wbxSandboxProvider] })
```

## Examples

[`examples/`](examples): an agent that fixes failing tests, and one that turns a CSV into a chart.

## Links

- Documentation: https://sandbox.wbx.cz/docs/integrations/mastra
- TypeScript SDK used underneath: [`wbxsandbox`](https://www.npmjs.com/package/wbxsandbox)
- Pricing: https://sandbox.wbx.cz/pricing

## License

MIT
