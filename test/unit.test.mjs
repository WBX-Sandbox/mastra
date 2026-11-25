// Unit tests against a local mock of the WBX API (no network, no API key).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { Workspace } from "@mastra/core/workspace";

import { readFileSync } from "node:fs";

import { VERSION, WBXSandbox, WBXSandboxConfigError, keyCombo, mapState, shellQuote, wbxSandboxProvider } from "../dist/index.js";

const SB = "sb_n01_0123456789abcdef";

function info(extra = {}) {
  return { id: SB, template: "base", state: "running", vcpu: 1, mem_mb: 512, created_at: "2026-11-24T20:00:00Z", expires_at: "2026-11-24T21:00:00Z", name: "proj", ...extra };
}

/** Mock WBX API. `handlers[key]` overrides "METHOD /path". Returns { url, calls, close, state }. */
async function mockApi(overrides = {}) {
  const calls = [];
  const state = { existing: false, procs: new Map(), snapshots: [{ id: "snap_old", name: "cp", template: "base", created_at: "2026-11-20T10:00:00Z" }], nextPid: 100 };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, "http://x");
    let json;
    try {
      json = raw.length ? JSON.parse(raw.toString()) : undefined;
    } catch {
      json = undefined;
    }
    const c = { method: req.method, path: u.pathname, query: u.searchParams, headers: req.headers, json, raw };
    calls.push(c);
    const send = (code, obj, h = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...h });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    const key = `${c.method} ${c.path}`;
    if (overrides[key]) return overrides[key](c, res, send, state);
    const base = `/v1/sandboxes/${SB}`;
    switch (true) {
      case key === "POST /v1/sandboxes":
        return send(201, info({ name: json.name, template: json.template ?? "base" }), state.existing ? { "X-WBX-Existing": "1" } : {});
      case key === "GET /v1/sandboxes":
        return send(200, state.list ?? []);
      case key === `GET ${base}`:
        return send(200, info());
      case key === `DELETE ${base}`:
        return send(204);
      case key === `POST ${base}/sleep`:
        return send(200, info({ state: "sleeping" }));
      case key === `POST ${base}/exec`:
        return send(200, { exit_code: json.cmd.includes("fail") ? 3 : 0, stdout: `ran: ${json.cmd}`, stderr: "", duration_ms: 12, timed_out: json.cmd.includes("slow") });
      case key === `POST ${base}/exec/stream`: {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({ type: "start", pid: 7 }) + "\n");
        res.write(JSON.stringify({ type: "stdout", data: "a" }) + "\n");
        res.write(JSON.stringify({ type: "stderr", data: "e" }) + "\n");
        res.write(JSON.stringify({ type: "stdout", data: "b" }) + "\n");
        return res.end(JSON.stringify({ type: "exit", exit_code: 0, duration_ms: 5, timed_out: false }) + "\n");
      }
      case key === `PUT ${base}/files`:
        return send(200, { path: c.query.get("path"), size: raw.length });
      case key === `GET ${base}/url`:
        return send(200, { sandbox_id: SB, port: Number(c.query.get("port")), host: "h", url: "https://h/", url_with_token: "https://h/?wbx_token=t", token: "t" });
      case key === `POST ${base}/process`: {
        const pid = state.nextPid++;
        state.procs.set(pid, { cmd: json.cmd, running: true, exit: null });
        return send(200, { pid });
      }
      case key === `POST ${base}/snapshots`:
        state.snapshots.push({ id: "snap_new", name: json.name, template: "base", created_at: "2026-11-24T21:00:00Z" });
        return send(201, state.snapshots.at(-1));
      case key === "GET /v1/snapshots":
        return send(200, state.snapshots);
      case key.startsWith("DELETE /v1/snapshots/"):
        state.snapshots = state.snapshots.filter((s) => s.id !== c.path.split("/").pop());
        return send(204);
      case key === `POST ${base}/computer/actions`:
        return send(200, { ok: true, results: json.actions.map((a) => ({ type: a.type, ok: true })) });
      case key === `GET ${base}/computer/status`:
        return send(200, { available: true, display: ":0", width: 1280, height: 800, controller: "agent", controller_until: null, viewers: 0 });
      case key === `GET ${base}/computer/screenshot`:
        res.writeHead(200, { "Content-Type": "image/png", "X-WBX-Screen-Width": "1280", "X-WBX-Screen-Height": "800" });
        return res.end(Buffer.from([0x89, 0x50]));
    }
    const m = c.path.match(/\/process\/(\d+)(\/\w+)?$/);
    if (m) {
      const pid = Number(m[1]);
      const p = state.procs.get(pid);
      if (!p) return send(404, { error: "no such process" });
      if (m[2] === "/stream") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({ type: "start", pid, truncated: false }) + "\n");
        res.write(JSON.stringify({ type: "stdout", data: `out:${p.cmd}\n` }) + "\n");
        if (p.cmd.startsWith("server")) {
          p.res = res; // stays open until killed
          return;
        }
        p.running = false;
        p.exit = p.cmd.includes("bad") ? 2 : 0;
        return res.end(JSON.stringify({ type: "exit", exit_code: p.exit }) + "\n");
      }
      if (m[2] === "/stdin") {
        p.stdin = (p.stdin ?? "") + (json.data ?? "");
        return send(200, {});
      }
      if (c.method === "DELETE") {
        p.running = false;
        p.exit = 137;
        if (p.res) p.res.end(JSON.stringify({ type: "exit", exit_code: -1 }) + "\n");
        return send(204);
      }
      return send(200, { pid, cmd: p.cmd, tag: "mastra", pty: false, running: p.running, exit_code: p.exit, started_ms: 0 });
    }
    send(404, { error: `not mocked: ${key}` });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    state,
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

const opts = (api, extra = {}) => ({ apiKey: "wbx_test", baseURL: api.url, ...extra });

test("configuration: id rules, timeout, missing API key", () => {
  assert.throws(() => new WBXSandbox({ id: "Bad Name" }), WBXSandboxConfigError);
  assert.throws(() => new WBXSandbox({ id: "x".repeat(64) }), WBXSandboxConfigError);
  assert.throws(() => new WBXSandbox({ timeout: 0 }), WBXSandboxConfigError);
  assert.match(new WBXSandbox().id, /^mastra-[a-z0-9]+-[a-z0-9]+$/);
  const saved = process.env.WBXSANDBOX_API_KEY;
  delete process.env.WBXSANDBOX_API_KEY;
  try {
    assert.throws(() => new WBXSandbox({ id: "p" }).client, /missing API key/);
  } finally {
    if (saved !== undefined) process.env.WBXSANDBOX_API_KEY = saved;
  }
  const s = new WBXSandbox({ id: "p", apiKey: "k" });
  assert.equal(s.provider, "wbx");
  assert.equal(s.computer, undefined);
  assert.equal(s.supportsCheckpoints, false);
  assert.ok(new WBXSandbox({ template: "desktop", apiKey: "k" }).computer);
  assert.equal(new WBXSandbox({ checkpointName: "cp", apiKey: "k" }).supportsCheckpoints, true);
});

test("helpers: shell quoting, key names, state mapping", () => {
  assert.equal(shellQuote("a.txt"), "a.txt");
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
  assert.equal(shellQuote(""), "''");
  assert.equal(keyCombo("Enter"), "Return");
  assert.equal(keyCombo(["ctrl", "s"]), "ctrl+s");
  assert.equal(keyCombo(["Meta", "ArrowUp"]), "super+Up");
  assert.equal(keyCombo("+"), "plus");
  assert.throws(() => keyCombo("ü"), /unsupported key/);
  assert.equal(mapState("sleeping"), "stopped");
  assert.equal(mapState("running"), "running");
});

test("start creates the named sandbox, then reconnects; commands, env, cwd, args", async (t) => {
  const api = await mockApi();
  t.after(api.close);
  const sb = new WBXSandbox(opts(api, { id: "proj", template: "node", network: { mode: "allowlist", allow: ["registry.npmjs.org"] }, env: { A: "1" }, computeClass: "economy" }));
  assert.deepEqual(await sb.start(), { outcome: "created" });
  assert.equal(sb.status, "running");
  const create = api.calls.find((c) => c.method === "POST" && c.path === "/v1/sandboxes").json;
  assert.equal(create.name, "proj");
  assert.equal(create.template, "node");
  assert.equal(create.on_timeout, "pause");
  assert.equal(create.compute_class, "economy");
  assert.deepEqual(create.network, { mode: "allowlist", allow: ["registry.npmjs.org"] });
  assert.equal(create.metadata.mastra_id, "proj");
  assert.equal(sb.sandboxId, SB);
  assert.equal(sb.workingDirectory, "/home/user");

  const r = await sb.executeCommand("echo", ["hi there", "x"], { env: { B: "2" } });
  assert.equal(r.success, true);
  assert.equal(r.exitCode, 0);
  const exec = api.calls.findLast((c) => c.path.endsWith("/exec")).json;
  assert.equal(exec.cmd, "echo 'hi there' x");
  assert.deepEqual(exec.env, { A: "1", B: "2" });
  assert.equal(exec.cwd, "/home/user");
  assert.equal(exec.timeout_ms, 300000);

  const f = await sb.executeCommand("fail");
  assert.equal(f.success, false);
  assert.equal(f.exitCode, 3);
  const slow = await sb.executeCommand("slow", [], { timeout: 1000 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.exitCode, 124);

  // streaming
  const out = [];
  const err = [];
  const s = await sb.executeCommand("x", [], { onStdout: (d) => out.push(d), onStderr: (d) => err.push(d) });
  assert.equal(s.stdout, "ab");
  assert.equal(s.stderr, "e");
  assert.deepEqual(out, ["a", "b"]);
  assert.deepEqual(err, ["e"]);

  // runtime env overlay
  sb.setEnv((e) => ({ ...e, A: undefined, C: "3" }));
  await sb.executeCommand("env");
  assert.deepEqual(api.calls.findLast((c) => c.path.endsWith("/exec")).json.env, { C: "3" });

  // second instance with the same id: existing sandbox
  api.state.existing = true;
  const again = new WBXSandbox(opts(api, { id: "proj" }));
  assert.deepEqual(await again.start(), { outcome: "connected" });
});

test("files, port URL, info, stop = sleep, destroy = delete", async (t) => {
  const api = await mockApi();
  t.after(api.close);
  const sb = new WBXSandbox(opts(api, { id: "proj" }));
  await sb.writeFiles([{ path: "/home/user/a.txt", content: "hello" }, { path: "/home/user/run.sh", content: Buffer.from("#!/bin/sh"), mode: 0o755 }]);
  const puts = api.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => [c.query.get("path"), c.raw.toString()]), [["/home/user/a.txt", "hello"], ["/home/user/run.sh", "#!/bin/sh"]]);
  assert.equal(api.calls.findLast((c) => c.path.endsWith("/exec")).json.cmd, "chmod 755 /home/user/run.sh");
  await assert.rejects(sb.writeFiles([{ path: "/x", content: "", mode: 0o4755 }]), /invalid mode/);

  assert.equal(await sb.networking.getPortUrl(3000), "https://h/?wbx_token=t");
  const i = await sb.getInfo();
  assert.equal(i.provider, "wbx");
  assert.equal(i.metadata.sandboxId, SB);
  assert.equal(i.resources.memoryMB, 512);
  assert.match(sb.getInstructions(), /isolated Linux microVM/);

  await sb._stop(); // Mastra calls the lifecycle wrappers
  assert.ok(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/sleep")));
  assert.equal(sb.status, "stopped");
  await sb._destroy();
  assert.equal(sb.status, "destroyed");
  assert.ok(api.calls.some((c) => c.method === "DELETE" && c.path === `/v1/sandboxes/${SB}`));

  // keep running on stop
  const k = new WBXSandbox(opts(api, { id: "keep", onStopBehavior: "keep" }));
  await k.start();
  const n = api.calls.filter((c) => c.path.endsWith("/sleep")).length;
  await k._stop();
  assert.equal(api.calls.filter((c) => c.path.endsWith("/sleep")).length, n);
});

test("background processes: output, wait, stdin, kill", async (t) => {
  const api = await mockApi();
  t.after(api.close);
  const sb = new WBXSandbox(opts(api, { id: "proj", env: { A: "1" } }));
  const h = await sb.processes.spawn("build", { env: { B: "2" } });
  const start = api.calls.find((c) => c.path.endsWith("/process")).json;
  assert.equal(start.cmd, "build");
  assert.deepEqual(start.env, { A: "1", B: "2" });
  assert.equal(start.stdin, true);
  const r = await h.wait();
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "out:build\n");

  const bad = await sb.processes.spawn("bad thing");
  assert.equal((await bad.wait()).exitCode, 2);

  const srv = await sb.processes.spawn("server --port 3000");
  await srv.sendStdin("hello");
  assert.equal(api.state.procs.get(srv.wbxPid).stdin, "hello");
  assert.equal((await sb.processes.list()).find((p) => p.pid === srv.pid).running, true);
  assert.equal(await srv.kill(), true);
  const k = await srv.wait();
  assert.equal(k.exitCode, 137);
  assert.equal(k.killed, true);
});

test("desktop: actions, keys, screenshot, screen size, cursor", async (t) => {
  const api = await mockApi();
  t.after(api.close);
  const sb = new WBXSandbox(opts(api, { id: "desk", template: "desktop" }));
  const c = sb.computer;
  await c.leftClick(10, 20);
  await c.doubleClick(11, 21);
  await c.rightClick(12, 22);
  await c.drag({ x: 1, y: 2 }, { x: 3, y: 4 });
  await c.scroll("down", 3);
  await c.type("hi");
  await c.press(["ctrl", "s"]);
  const acts = api.calls.filter((x) => x.path.endsWith("/computer/actions")).map((x) => x.json.actions[0]);
  assert.deepEqual(acts, [
    { type: "click", x: 10, y: 20 },
    { type: "click", x: 11, y: 21, count: 2 },
    { type: "click", x: 12, y: 22, button: "right" },
    { type: "drag", x: 1, y: 2, to_x: 3, to_y: 4 },
    { type: "scroll", x: 3, y: 4, dx: 0, dy: 3 },
    { type: "type", text: "hi" },
    { type: "key", keys: "ctrl+s" },
  ]);
  assert.deepEqual(await c.getCursorPosition(), { x: 3, y: 4 });
  const shot = await c.screenshot();
  assert.equal(shot.mediaType, "image/png");
  assert.deepEqual(await c.getScreenSize(), { width: 1280, height: 800 });
});

test("checkpoints: snapshot replaces the named snapshot, a new sandbox starts from it", async (t) => {
  const api = await mockApi({
    "POST /v1/sandboxes": (c, res, send) => send(201, info({ name: c.json.name })),
  });
  t.after(api.close);
  const sb = new WBXSandbox(opts(api, { id: "proj", checkpointName: "cp" }));
  await sb.start();
  assert.equal(api.calls.find((c) => c.method === "POST" && c.path === "/v1/sandboxes").json.from_snapshot, "snap_old");
  await sb.snapshot();
  assert.deepEqual(api.state.snapshots.map((s) => s.id), ["snap_new"]);
  // without a checkpoint name snapshot() does nothing
  const plain = new WBXSandbox(opts(api, { id: "plain" }));
  const n = api.calls.length;
  await plain.snapshot();
  assert.equal(api.calls.length, n);
});

test("clone() and the MastraEditor provider", async () => {
  const sb = new WBXSandbox({ id: "base-one", apiKey: "k", template: "node", checkpointName: "cp" });
  const c = sb.clone({ id: "copy-1", idleTimeoutMinutes: 5 });
  assert.ok(c instanceof WBXSandbox);
  assert.equal(c.id, "copy-1");
  assert.equal(c._options.template, "node");
  assert.equal(c._options.idleTimeoutSeconds, 300);
  assert.equal(c.status, "pending");
  assert.equal(wbxSandboxProvider.id, "wbx");
  const p = wbxSandboxProvider.createSandbox({ id: "ed", apiKey: "k", template: "node" });
  assert.ok(p instanceof WBXSandbox);
  assert.equal(p.id, "ed");
});

test("works as a Mastra Workspace sandbox", async (t) => {
  const api = await mockApi();
  t.after(api.close);
  const ws = new Workspace({ sandbox: new WBXSandbox(opts(api, { id: "ws" })) });
  await ws.init();
  const r = await ws.sandbox.executeCommand("ls");
  assert.equal(r.stdout, "ran: ls");
  await ws.destroy();
  assert.ok(api.calls.some((c) => c.method === "DELETE" && c.path === `/v1/sandboxes/${SB}`));
});

test("VERSION matches package.json", () => {
  assert.equal(VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});
