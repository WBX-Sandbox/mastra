/**
 * Background processes for Mastra workspace tools, backed by WBX background processes:
 * a process keeps running in the VM, its output (last 1 MB per stream) is streamed back,
 * stdin and signals go through the API.
 */

import { ProcessHandle, SandboxProcessManager, type ProcessInfo, type SpawnProcessOptions } from "@mastra/core/workspace";

import type { WBXSandbox } from "./sandbox.js";

/** Exit code reported for processes ended by `kill()` or a timeout (like SIGKILL). */
const KILLED_EXIT_CODE = 137;

export class WBXProcessHandle extends ProcessHandle {
  readonly pid: string;
  #sandbox: WBXSandbox;
  #wbxPid: number;
  #exitCode: number | undefined;
  #killed = false;
  #timedOut = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #done: Promise<void>;
  #abort = new AbortController();
  #start = Date.now();
  #error: unknown;

  constructor(sandbox: WBXSandbox, wbxPid: number, command: string, options: SpawnProcessOptions, timeout?: number) {
    super(options);
    this.#sandbox = sandbox;
    this.#wbxPid = wbxPid;
    this.pid = String(wbxPid);
    this.command = command;
    this.#done = this.#follow();
    if (timeout !== undefined && timeout > 0) {
      this.#timer = setTimeout(() => {
        this.#timedOut = true;
        void this.kill();
      }, timeout);
    }
  }

  /** The PID inside the sandbox. */
  get wbxPid(): number {
    return this.#wbxPid;
  }

  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  async #follow(): Promise<void> {
    const procs = this.#sandbox.wbx.processes;
    let attempts = 0;
    for (;;) {
      try {
        // replay from the start only on the first connection; later ones continue live
        for await (const ev of procs.stream(this.#wbxPid, { signal: this.#abort.signal, replay: attempts === 0 })) {
          if (ev.type === "stdout" || ev.type === "pty") this.emitStdout(ev.data);
          else if (ev.type === "stderr") this.emitStderr(ev.data);
          else if (ev.type === "exit") {
            this.#finish(ev.exit_code);
            return;
          }
        }
      } catch (e) {
        if (this.#exitCode !== undefined) return;
        if (this.#abort.signal.aborted && this.#killed) {
          this.#finish(KILLED_EXIT_CODE);
          return;
        }
        this.#error = e;
      }
      // the stream ended without an exit (time limit of one stream, network): check and reconnect
      try {
        const info = await procs.get(this.#wbxPid);
        if (!info.running) {
          this.#finish(info.exit_code ?? (this.#killed ? KILLED_EXIT_CODE : 1));
          return;
        }
      } catch {
        if (++attempts > 5) {
          this.#finish(this.#killed ? KILLED_EXIT_CODE : 1);
          return;
        }
      }
      attempts++;
      await new Promise((r) => setTimeout(r, Math.min(5000, 250 * attempts)));
    }
  }

  #finish(code: number) {
    if (this.#exitCode !== undefined) return;
    clearTimeout(this.#timer);
    this.#exitCode = this.#killed ? KILLED_EXIT_CODE : code;
  }

  override async wait(options: { onStdout?: (d: string) => void; onStderr?: (d: string) => void; abortSignal?: AbortSignal } = {}) {
    if (options.abortSignal) {
      const onAbort = () => void this.kill();
      if (options.abortSignal.aborted) onAbort();
      else options.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    await this.#done;
    const exitCode = this.#exitCode ?? 1;
    let stderr = this.stderr;
    if (exitCode !== 0 && !stderr && this.#error && !this.#killed) stderr = String((this.#error as Error)?.message ?? this.#error);
    return {
      command: this.command,
      success: exitCode === 0,
      exitCode,
      stdout: this.stdout,
      stderr,
      executionTimeMs: Date.now() - this.#start,
      ...(this.stdoutTruncated && { stdoutTruncated: true }),
      ...(this.stderrTruncated && { stderrTruncated: true }),
      ...(this.#killed && { killed: true }),
      ...(this.#timedOut && { timedOut: true }),
    };
  }

  async kill(): Promise<boolean> {
    if (this.#exitCode !== undefined || this.#killed) return false;
    this.#killed = true;
    clearTimeout(this.#timer);
    try {
      await this.#sandbox.wbx.processes.kill(this.#wbxPid);
    } catch {
      // already gone
    }
    // the output stream ends with the exit event; stop waiting for it after a moment
    setTimeout(() => this.#abort.abort(), 3000).unref?.();
    return true;
  }

  async sendStdin(data: string): Promise<void> {
    if (this.#exitCode !== undefined) throw new Error(`process ${this.pid} has exited`);
    await this.#sandbox.wbx.processes.sendStdin(this.#wbxPid, data);
  }

  override async closeStdin(): Promise<void> {
    if (this.#exitCode !== undefined) return;
    await this.#sandbox.wbx.processes.sendStdin(this.#wbxPid, "", { eof: true });
  }
}

export class WBXProcessManager extends SandboxProcessManager<WBXSandbox> {
  override async spawn(command: string, options: SpawnProcessOptions = {}): Promise<ProcessHandle> {
    await this.sandbox.ensureRunning();
    const env: Record<string, string> = {};
    for (const src of [this.env, this.sandbox.getEnv(), options.env]) {
      for (const [k, v] of Object.entries(src ?? {})) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
    const cwd = options.cwd ?? this.sandbox.workingDirectory;
    const { pid } = await this.sandbox.wbx.processes.start(command, {
      ...(cwd && { cwd }),
      ...(Object.keys(env).length > 0 && { env }),
      stdin: options.stdinMode !== "ignore",
      tag: "mastra",
    });
    const handle = new WBXProcessHandle(this.sandbox, pid, command, options, options.timeout);
    this._tracked.set(handle.pid, handle);
    return handle;
  }

  /** Processes started through this instance (and still known to the sandbox). */
  override async list(): Promise<ProcessInfo[]> {
    return [...this._tracked.values()].map((h) => ({
      pid: h.pid,
      command: h.command,
      running: h.exitCode === undefined,
      ...(h.exitCode !== undefined && { exitCode: h.exitCode }),
    }));
  }

  /** Kills every running process started through this instance. Does not start the sandbox. */
  async killAll(): Promise<void> {
    const running = [...this._tracked.values()].filter((h) => h.exitCode === undefined);
    await Promise.all(running.map((h) => this.kill(h.pid)));
  }
}
