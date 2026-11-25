# Changelog

## [0.1.0] – 2026-11-25

First release: WBX Sandbox as a Mastra workspace sandbox.

- `WBXSandbox`: get-or-create by `id` (the sandbox name), attach by `sandboxId`, sleep on `stop()` with files
  kept, delete on `destroy()`.
- Commands with streamed output, timeouts, env overlay, working directory, abort.
- Background processes (`processes.spawn`, output, stdin, kill) on WBX background processes.
- `writeFiles` (with file modes), public HTTPS port URLs (`networking.getPortUrl`).
- Checkpoints on WBX disk snapshots (`checkpointName`, `seedCheckpointName`), `clone()`.
- Desktop control for the `desktop` template (Mastra computer tools).
- `wbxSandboxProvider` for MastraEditor.
