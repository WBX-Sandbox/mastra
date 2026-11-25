/**
 * `SandboxProvider` for MastraEditor: lets a stored workspace config reference the `wbx`
 * provider.
 */

import type { SandboxProvider } from "@mastra/core/editor";

import { WBXSandbox, type WBXSandboxOptions } from "./sandbox.js";

type Config = Pick<
  WBXSandboxOptions,
  "id" | "apiKey" | "baseURL" | "template" | "computeClass" | "lifetimeSeconds" | "idleTimeoutSeconds" | "timeout" | "workingDirectory" | "network"
> & { env?: Record<string, string> };

export const wbxSandboxProvider: SandboxProvider<Config> = {
  id: "wbx",
  name: "WBX Sandbox",
  description: "Isolated Firecracker microVM in Europe – sleeps with its files kept, public HTTPS ports, desktop",
  configSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Sandbox name; an existing sandbox with this name is reused (lower-case letters, digits, . _ -)" },
      apiKey: { type: "string", description: "WBX Sandbox API key (falls back to WBXSANDBOX_API_KEY)" },
      baseURL: { type: "string", description: "API address (default https://sandbox.wbx.cz)" },
      template: { type: "string", description: "Template, e.g. base, node, code-interpreter, desktop" },
      computeClass: { type: "string", description: "Compute class: economy, balanced, performance or memory" },
      lifetimeSeconds: { type: "number", description: "Lifetime in seconds before the sandbox falls asleep (default 3600)" },
      idleTimeoutSeconds: { type: "number", description: "Sleep after this many seconds without commands" },
      timeout: { type: "number", description: "Default command timeout in ms" },
      workingDirectory: { type: "string", description: "Default working directory (default /home/user)" },
      env: { type: "object", description: "Environment variables", additionalProperties: { type: "string" } },
      network: {
        type: "object",
        description: "Network access",
        properties: {
          mode: { type: "string", enum: ["full", "allowlist", "none"] },
          allow: { type: "array", items: { type: "string" } },
          ip: { type: "string", enum: ["ipv4", "dual", "ipv6"] },
        },
      },
    },
  },
  createSandbox: (config) => new WBXSandbox(config),
};
