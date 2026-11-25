/**
 * WBX Sandbox provider for Mastra workspaces.
 *
 * Every sandbox is a Firecracker microVM in WBX Sandbox, reached through the official
 * `wbxsandbox` SDK. The Mastra sandbox `id` is the WBX sandbox *name*, so `start()` with the
 * same id reconnects to the same machine (waking it from sleep, files kept) instead of
 * creating a new one.
 */

import {
  MastraSandbox,
  SandboxNotReadyError,
  type CommandResult as MastraCommandResult,
  type ExecuteCommandOptions,
  type MastraSandboxOptions,
  type ProviderStatus,
  type SandboxCloneOptions,
  type SandboxFileInput,
  type SandboxInfo,
  type SandboxNetworking,
  type SandboxStartResult,
  type WriteFilesOptions,
} from "@mastra/core/workspace";
import { NotFoundError, WBX, type Sandbox, type SandboxCreateParams } from "wbxsandbox";

import { WBXComputer } from "./computer.js";
import { WBXProcessManager } from "./process-manager.js";
import { VERSION } from "./version.js";

const LOG_PREFIX = "[WBXSandbox]";

/** Names of WBX sandboxes (the Mastra `id`): lower-case letters, digits, `.`, `_`, `-`. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** Default lifetime of the WBX sandbox (seconds) – it falls asleep after it, files are kept. */
const DEFAULT_LIFETIME_S = 3600;

/** What happens to the WBX sandbox when Mastra stops the workspace sandbox. */
export type StopBehavior = "sleep" | "keep";

/** Network access of the sandbox. */
export interface WBXNetworkOptions {
  /** `full` internet (default), `allowlist` (only `allow`) or `none`. */
  mode?: "full" | "allowlist" | "none";
  /** Domains or addresses reachable in `allowlist` mode, e.g. `["pypi.org", "registry.npmjs.org"]`. */
  allow?: string[];
  /** Destinations that stay blocked. */
  block?: string[];
  /** IP version: `ipv4` (default), `dual` (IPv4 + own public IPv6) or `ipv6`. */
  ip?: "ipv4" | "dual" | "ipv6";
}

/** Options of {@link WBXSandbox}. */
export interface WBXSandboxOptions extends Omit<MastraSandboxOptions, "processes"> {
  /**
   * Logical id, used as the WBX sandbox name: lower-case letters, digits, `.`, `_` and `-`
   * (up to 63 characters). `start()` with the same id reconnects to the same sandbox.
   * Default: a random `mastra-…` name.
   */
  id?: string;
  /** Attach to an existing WBX sandbox by its ID (`sb_…`) instead of creating one. */
  sandboxId?: string;
  /** API key. Default: the `WBXSANDBOX_API_KEY` environment variable. */
  apiKey?: string;
  /** API address. Default: `WBXSANDBOX_URL`, else `https://sandbox.wbx.cz`. */
  baseURL?: string;
  /** A configured `WBX` client (takes precedence over `apiKey` / `baseURL`). */
  client?: WBX;
  /** Template, e.g. `base`, `node`, `code-interpreter`, `browser` or `desktop` (default `base`). */
  template?: string;
  /** Compute class (`economy`, `balanced`, `performance`, `memory`). Default: your account's default. */
  computeClass?: string;
  /** Network access. Default: full internet. */
  network?: WBXNetworkOptions;
  /**
   * Lifetime of the sandbox in seconds (default 3600). At the end the sandbox falls asleep –
   * files are kept and the next command wakes it.
   */
  lifetimeSeconds?: number;
  /** Put the sandbox to sleep after this many seconds without commands. */
  idleTimeoutSeconds?: number;
  /** How many days a sleeping sandbox keeps its files (within your plan's limit). */
  keepDays?: number;
  /** Metadata stored with the sandbox (`mastra_id` is added). */
  metadata?: Record<string, string>;
  /** Environment variables set when the sandbox is created (in addition to the runtime overlay `env`). */
  createEnv?: Record<string, string>;
  /** Default timeout of foreground commands in milliseconds (default 300 000). */
  timeout?: number;
  /** What `stop()` does with the WBX sandbox: `sleep` (default – files kept, no running cost) or `keep` it running. */
  onStopBehavior?: StopBehavior;
  /**
   * Named checkpoint: `snapshot()` saves the disk as a WBX snapshot with this name, and a
   * sandbox that does not exist yet starts from the newest snapshot with this name.
   */
  checkpointName?: string;
  /** Snapshot name used to seed a new sandbox when `checkpointName` has no snapshot yet. */
  seedCheckpointName?: string;
  /** Desktop control (computer-use tools). Default: on for the `desktop` template. */
  computer?: boolean;
  /** Override the instructions given to the agent (a string, or a function of the defaults). */
  instructions?: string | ((opts: { defaultInstructions: string }) => string);
}

/** Error of the provider configuration or of an unsupported feature. */
export class WBXSandboxConfigError extends Error {
  override readonly name = "WBXSandboxConfigError";
}

function randomId(): string {
  return `mastra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Shell-quotes one argument for `/bin/sh`. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Maps a WBX sandbox state to a Mastra provider status (for `getInfo().metadata`). */
export function mapState(state: string | undefined): ProviderStatus {
  switch (state) {
    case "running":
    case "starting":
    case "resuming":
    case "waking":
      return "running";
    case "paused":
    case "pausing":
    case "falling_asleep":
    case "sleeping":
    case "archiving":
    case "archived":
      return "stopped";
    default:
      return "running";
  }
}

/**
 * A Mastra workspace sandbox running in WBX Sandbox.
 *
 * ```ts
 * import { Workspace } from '@mastra/core/workspace'
 * import { WBXSandbox } from '@wbx-sandbox/mastra'
 *
 * const workspace = new Workspace({ sandbox: new WBXSandbox({ id: 'my-project' }) })
 * ```
 */
export class WBXSandbox extends MastraSandbox {
  readonly id: string;
  readonly name = "WBXSandbox";
  readonly provider = "wbx";
  status: ProviderStatus = "pending";

  declare readonly processes: WBXProcessManager;
  override readonly networking: SandboxNetworking;
  declare readonly computer?: WBXComputer;

  /** @internal */ readonly _options: WBXSandboxOptions;
  #client: WBX | undefined;
  #sandbox: Sandbox | null = null;
  #sandboxId: string | undefined;
  #createdAt: Date | null = null;
  #outcome: SandboxStartResult["outcome"] | undefined;

  constructor(options: WBXSandboxOptions = {}) {
    super({ ...options, name: "WBXSandbox", processes: new WBXProcessManager() });
    const id = options.id ?? randomId();
    if (!NAME_RE.test(id)) {
      throw new WBXSandboxConfigError(
        `${LOG_PREFIX} invalid id "${id}": use lower-case letters, digits, ".", "_" and "-" (up to 63 characters, starting with a letter or digit)`,
      );
    }
    if (options.checkpointName !== undefined && !NAME_RE.test(options.checkpointName)) {
      throw new WBXSandboxConfigError(`${LOG_PREFIX} invalid checkpointName "${options.checkpointName}"`);
    }
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
      throw new WBXSandboxConfigError(`${LOG_PREFIX} timeout must be a positive number of milliseconds`);
    }
    this.id = id;
    this._options = { ...options };
    this.#client = options.client;
    this.#sandboxId = options.sandboxId;
    this.defaultCommandTimeout = options.timeout ?? 300_000;
    this.networking = { getPortUrl: (port) => this.#portUrl(port) };
    const wantComputer = options.computer ?? options.template === "desktop";
    if (wantComputer) (this as { computer?: WBXComputer }).computer = new WBXComputer(this);
    // real checkpoints = WBX disk snapshots, only with a checkpointName
    (this as { supportsCheckpoints: boolean }).supportsCheckpoints = options.checkpointName !== undefined;
  }

  /** The WBX API client (created on first use). */
  get client(): WBX {
    if (!this.#client) {
      const apiKey = this._options.apiKey ?? process.env.WBXSANDBOX_API_KEY;
      if (!apiKey) {
        throw new WBXSandboxConfigError(`${LOG_PREFIX} missing API key: pass \`apiKey\` or set WBXSANDBOX_API_KEY`);
      }
      this.#client = new WBX({
        apiKey,
        baseURL: this._options.baseURL,
        headers: { "User-Agent": `wbxsandbox-mastra/${VERSION}` },
      });
    }
    return this.#client;
  }

  /** The underlying WBX `Sandbox` (SDK object). Throws before `start()`. */
  get wbx(): Sandbox {
    if (!this.#sandbox) throw new SandboxNotReadyError(this.id);
    return this.#sandbox;
  }

  /** The WBX sandbox ID (`sb_…`) once started – pass it as `sandboxId` to reattach. */
  get sandboxId(): string | undefined {
    return this.#sandbox?.id ?? this.#sandboxId;
  }

  /** Default foreground command timeout in milliseconds. */
  get defaultTimeout(): number | undefined {
    return this.defaultCommandTimeout;
  }


  #createParams(): SandboxCreateParams {
    const o = this._options;
    const net = o.network;
    return {
      template: o.template ?? "base",
      name: this.id,
      timeoutSeconds: o.lifetimeSeconds ?? DEFAULT_LIFETIME_S,
      onTimeout: "pause",
      idleTimeoutSeconds: o.idleTimeoutSeconds,
      keepDays: o.keepDays,
      computeClass: o.computeClass,
      metadata: { ...o.metadata, mastra_id: this.id },
      env: o.createEnv,
      network: net ? { mode: net.mode, allow: net.allow, block: net.block, ip: net.ip } : undefined,
    };
  }

  /**
   * Gets or creates the WBX sandbox named `id` (a sleeping one is woken by its first command).
   * With `sandboxId` it attaches to that sandbox; with `checkpointName` a new sandbox starts
   * from the newest snapshot of that name.
   */
  override async start(): Promise<SandboxStartResult> {
    if (this.#sandbox) return { outcome: "connected" };
    const client = this.client;
    if (this.#sandboxId) {
      this.#sandbox = await client.sandboxes.get(this.#sandboxId);
      this.#outcome = "connected";
    } else {
      const params = this.#createParams();
      // with checkpoints: an existing sandbox of this name wins over seeding from a snapshot
      const checkpoints = this._options.checkpointName !== undefined || this._options.seedCheckpointName !== undefined;
      const existing = checkpoints ? (await client.sandboxes.list()).find((s) => s.name === this.id) : undefined;
      if (existing) {
        this.#sandbox = existing;
        this.#outcome = "connected";
      } else {
        const seed = checkpoints ? await this.#seedSnapshot() : undefined;
        // create with a name returns the existing sandbox of that name (x-wbx-existing)
        const sb = seed ? await seed.createSandbox(withoutTemplate(params)) : await client.sandboxes.create(params);
        this.#sandbox = sb;
        this.#outcome = sb.existing ? "connected" : "created";
      }
    }
    const sb = this.#sandbox;
    if (sb.state === "archived" || sb.state === "sleeping") {
      // wake it now, so the first tool call does not wait
      await sb.commands.run("true", { timeoutMs: 60_000 }).catch(() => undefined);
      await sb.refresh().catch(() => undefined);
    }
    this.#createdAt = new Date(sb.info.created_at);
    if (!this.workingDirectory) this.setWorkingDirectory("/home/user");
    this.logger.debug(`${LOG_PREFIX} sandbox ready`, { id: this.id, sandboxId: sb.id, outcome: this.#outcome });
    return { outcome: this.#outcome ?? "connected" };
  }

  async #seedSnapshot() {
    const names = [this._options.checkpointName, this._options.seedCheckpointName].filter((n): n is string => !!n);
    if (names.length === 0) return undefined;
    const all = await this.client.snapshots.list();
    for (const n of names) {
      const found = all
        .filter((s) => s.name === n)
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Stops using the sandbox: kills background processes started through this instance and,
   * by default, puts the WBX sandbox to sleep (files kept, no running cost). The next
   * `start()` with the same id wakes it.
   */
  override async stop(): Promise<void> {
    await this.#killTracked();
    const sb = this.#sandbox;
    this.#sandbox = null;
    if (sb) this.#sandboxId = sb.id; // next start() / destroy() finds the same sandbox
    if (sb && (this._options.onStopBehavior ?? "sleep") === "sleep") {
      try {
        await sb.sleep();
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
  }

  /** Deletes the WBX sandbox with its files. A sandbox that no longer exists counts as destroyed. */
  override async destroy(): Promise<void> {
    await this.#killTracked();
    const id = this.#sandbox?.id ?? this.#sandboxId ?? (await this.#findByName())?.id;
    this.#sandbox = null;
    this.#sandboxId = undefined;
    if (id) await this.client.sandboxes.kill(id);
  }

  async #findByName() {
    try {
      return (await this.client.sandboxes.list()).find((s) => s.name === this.id);
    } catch {
      return undefined;
    }
  }

  async #killTracked() {
    await this.processes.killAll().catch((error: unknown) => {
      this.logger.warn(`${LOG_PREFIX} failed to kill background processes`, { error });
    });
  }

  /**
   * Saves the disk as a WBX snapshot named `checkpointName` (the previous snapshot of that name
   * is deleted afterwards). Without `checkpointName` it does nothing.
   */
  override async snapshot(): Promise<void> {
    const name = this._options.checkpointName;
    if (!name) return;
    await this.ensureRunning();
    const before = (await this.client.snapshots.list()).filter((s) => s.name === name);
    await this.wbx.snapshot({ name });
    for (const old of before) await old.delete().catch(() => undefined);
  }

  /**
   * Runs a shell command and waits for it (`/bin/sh -c`). Output is streamed to `onStdout` /
   * `onStderr` when given. A non-zero exit code is a normal result.
   */
  override async executeCommand(command: string, args: string[] = [], options: ExecuteCommandOptions = {}): Promise<MastraCommandResult> {
    await this.ensureRunning();
    const full = args.length ? `${command} ${args.map(shellQuote).join(" ")}` : command;
    const timeout = options.timeout ?? this.defaultCommandTimeout ?? 300_000;
    const env = mergeEnv(this.getEnv(), options.env);
    const start = Date.now();
    const signal = options.abortSignal;
    try {
      const r = await this.wbx.commands.run(full, {
        timeoutMs: timeout,
        cwd: options.cwd ?? this.workingDirectory,
        env: Object.keys(env).length ? env : undefined,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        signal,
      });
      return {
        command,
        args,
        success: r.exitCode === 0 && !r.timedOut,
        exitCode: r.timedOut ? 124 : r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        executionTimeMs: r.durationMs || Date.now() - start,
        ...(r.timedOut && { timedOut: true }),
        ...(r.truncated && { stdoutTruncated: true }),
      };
    } catch (e) {
      if (signal?.aborted) {
        return { command, args, success: false, exitCode: 130, stdout: "", stderr: "aborted", executionTimeMs: Date.now() - start, killed: true };
      }
      throw e;
    }
  }

  /** Writes files into the sandbox (missing directories are created). */
  override async writeFiles(files: SandboxFileInput[], options: WriteFilesOptions = {}): Promise<void> {
    await this.ensureRunning();
    for (const f of files) {
      if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error("aborted");
      if (f.mode !== undefined && (!Number.isInteger(f.mode) || f.mode < 1 || f.mode > 0o777)) {
        throw new WBXSandboxConfigError(`${LOG_PREFIX} invalid mode for ${f.path}`);
      }
      const data = typeof f.content === "string" ? f.content : new Uint8Array(f.content);
      await this.wbx.files.write(f.path, data, { signal: options.abortSignal });
      if (f.mode !== undefined) {
        await this.wbx.commands.run(`chmod ${f.mode.toString(8)} ${shellQuote(f.path)}`, { timeoutMs: 30_000 });
      }
    }
  }

  /** Public HTTPS address of a port (with the access token; the app must listen on 0.0.0.0). */
  async #portUrl(port: number): Promise<string | null> {
    if (!this.#sandbox) return null;
    try {
      return (await this.#sandbox.getUrl(port)).url_with_token;
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  /** A new, independent sandbox with this configuration (no I/O until its `start()`). */
  clone(options: SandboxCloneOptions = {}): WBXSandbox {
    const o = this._options;
    return new WBXSandbox({
      ...o,
      client: this.#client ?? o.client,
      id: options.id,
      sandboxId: options.sandboxId,
      env: options.env ?? (this.getEnv() as Record<string, string>),
      workingDirectory: options.workingDirectory ?? this.workingDirectory,
      idleTimeoutSeconds: options.idleTimeoutMinutes !== undefined ? options.idleTimeoutMinutes * 60 : o.idleTimeoutSeconds,
      checkpointName: options.checkpointName ?? o.checkpointName,
      seedCheckpointName: options.seedCheckpointName ?? o.seedCheckpointName,
    });
  }

  override async getInfo(): Promise<SandboxInfo> {
    const sb = this.#sandbox;
    const j = sb?.info;
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this.#createdAt ?? new Date(),
      ...(j?.expires_at && { timeoutAt: new Date(j.expires_at) }),
      ...(j && { resources: { memoryMB: j.mem_mb, cpuCores: j.vcpu, ...(j.disk_bytes ? { diskMB: Math.round(j.disk_bytes / 1048576) } : {}) } }),
      metadata: {
        ...(sb && { sandboxId: sb.id, state: sb.state, template: sb.template }),
        ...(j?.compute_class && { computeClass: j.compute_class }),
        ...(j?.network && { network: j.network }),
        ...(sb?.ipv6 && { ipv6: sb.ipv6 }),
      },
    };
  }

  override getInstructions(): string {
    const def = this.#defaultInstructions();
    const o = this._options.instructions;
    if (typeof o === "string") return o;
    if (typeof o === "function") return o({ defaultInstructions: def });
    return def;
  }

  #defaultInstructions(): string {
    const o = this._options;
    const parts = [
      `WBX Sandbox: an isolated Linux microVM (template ${o.template ?? "base"}) where you are root.`,
      `Commands run in ${this.workingDirectory ?? "/home/user"} by default; files on disk persist while the sandbox sleeps.`,
    ];
    const mode = o.network?.mode ?? "full";
    if (mode === "none") parts.push("There is no network access.");
    else if (mode === "allowlist") parts.push(`Network access only to: ${(o.network?.allow ?? []).join(", ") || "nothing"}.`);
    else parts.push("It has internet access.");
    parts.push("A web app listening on 0.0.0.0 can get a public HTTPS address.");
    if (this.computer) parts.push("It has a graphical desktop you can see and control with the computer tools.");
    return parts.join(" ");
  }
}

function withoutTemplate(p: SandboxCreateParams) {
  const { template: _t, fromSnapshot: _f, ...rest } = p;
  return rest;
}

function mergeEnv(...envs: Array<Record<string, string | undefined> | NodeJS.ProcessEnv | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of envs) {
    if (!e) continue;
    for (const [k, v] of Object.entries(e)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
  }
  return out;
}

export { mergeEnv as _mergeEnv };
