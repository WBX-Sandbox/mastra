// Live tests against the real WBX Sandbox API. Needs WBXSANDBOX_API_KEY (never stored in the repo).
// Every sandbox and snapshot created here is deleted at the end, also after a failure.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { Workspace } from "@mastra/core/workspace";
import { WBX } from "wbxsandbox";

import { WBXSandbox } from "../dist/index.js";

const KEY = process.env.WBXSANDBOX_API_KEY;
const skip = !KEY && "WBXSANDBOX_API_KEY is not set";
const RUN = `mtest-${Date.now().toString(36)}`;
const created = [];
const wbx = KEY ? new WBX({ apiKey: KEY }) : undefined;

function sandbox(extra = {}, t) {
  const s = new WBXSandbox({ lifetimeSeconds: 900, ...extra });
  created.push(s);
  // delete right after the test – the test account has a small concurrent-sandbox limit
  t?.after(() => s._destroy().catch(() => undefined));
  return s;
}

after(async () => {
  if (!wbx) return;
  for (const s of created) await s._destroy().catch(() => undefined);
  // safety net: anything named after this run
  for (const sb of await wbx.sandboxes.list().catch(() => [])) if (sb.name?.startsWith(RUN)) await sb.kill().catch(() => undefined);
  for (const sn of await wbx.snapshots.list().catch(() => [])) if (sn.name?.startsWith(RUN)) await sn.delete().catch(() => undefined);
});

test("commands, streaming, env, cwd, files, timeout", { skip, timeout: 240_000 }, async (t) => {
  const sb = sandbox({ id: `${RUN}-a`, env: { GREETING: "ahoj" } }, t);
  assert.equal((await sb._start()).outcome, "created");
  const r = await sb.executeCommand("echo $GREETING from $(pwd); uname -s");
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /ahoj from \/home\/user\nLinux/);
  const chunks = [];
  const s = await sb.executeCommand("for i in 1 2 3; do echo line$i; sleep 0.3; done", [], { onStdout: (d) => chunks.push(d) });
  assert.equal(s.stdout, "line1\nline2\nline3\n");
  assert.ok(chunks.length >= 2, `streamed in ${chunks.length} chunk(s)`);
  const q = await sb.executeCommand("printf '%s|'", ["it's", "two words", "$HOME"]);
  assert.equal(q.stdout, "it's|two words|$HOME|");
  const bad = await sb.executeCommand("exit 7");
  assert.equal(bad.success, false);
  assert.equal(bad.exitCode, 7);
  const slow = await sb.executeCommand("sleep 10", [], { timeout: 1500 });
  assert.equal(slow.timedOut, true);
  await sb.writeFiles([{ path: "/home/user/data/in.txt", content: "příliš žluťoučký\n" }, { path: "/home/user/run.sh", content: "#!/bin/sh\necho script ok\n", mode: 0o755 }]);
  assert.equal((await sb.executeCommand("cat data/in.txt && ./run.sh")).stdout, "příliš žluťoučký\nscript ok\n");
  const tmp = await sb.executeCommand("pwd", [], { cwd: "/tmp" });
  assert.equal(tmp.stdout.trim(), "/tmp");
});

test("network: none and allowlist", { skip, timeout: 240_000 }, async (t) => {
  const none = sandbox({ id: `${RUN}-n`, network: { mode: "none" } }, t);
  const r = await none.executeCommand("curl -sS -m 5 https://pypi.org/simple/ -o /dev/null -w '%{http_code}'");
  assert.notEqual(r.stdout, "200");
  const allow = sandbox({ id: `${RUN}-w`, network: { mode: "allowlist", allow: ["pypi.org"] } }, t);
  const ok = await allow.executeCommand("curl -sS -m 10 https://pypi.org/simple/ -o /dev/null -w '%{http_code}'");
  assert.equal(ok.stdout, "200", ok.stderr);
  const blocked = await allow.executeCommand("curl -sS -m 5 https://example.com -o /dev/null -w '%{http_code}'");
  assert.notEqual(blocked.stdout, "200");
  assert.match(allow.getInstructions(), /only to: pypi.org/);
});

test("background process, stdin, public port URL, kill", { skip, timeout: 240_000 }, async (t) => {
  const sb = sandbox({ id: `${RUN}-p` }, t);
  await sb._start();
  await sb.writeFiles([{ path: "/home/user/site/index.html", content: "<h1>hello from mastra</h1>" }]);
  const srv = await sb.processes.spawn("python3 -m http.server 8080 --bind 0.0.0.0", { cwd: "/home/user/site" });
  await new Promise((r) => setTimeout(r, 2000));
  const url = await sb.networking.getPortUrl(8080);
  assert.match(url, /^https:\/\/8080-/);
  // a browser keeps the token as a cookie; a script sends it as a header
  const u = new URL(url);
  const page = await fetch(u.origin + "/", { headers: { "X-WBX-Token": u.searchParams.get("wbx_token") } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /hello from mastra/);
  assert.equal((await sb.processes.list()).find((p) => p.pid === srv.pid)?.running, true);
  assert.equal(await srv.kill(), true);
  const done = await srv.wait();
  assert.equal(done.killed, true);

  const cat = await sb.processes.spawn("read line; echo got:$line");
  await cat.sendStdin("ping\n");
  const out = await cat.wait();
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /got:ping/);
});

test("sleep on stop keeps files; a new instance with the same id reconnects", { skip, timeout: 300_000 }, async (t) => {
  const id = `${RUN}-s`;
  const a = sandbox({ id }, t);
  await a._start();
  await a.executeCommand("echo kept > /home/user/state.txt");
  await a._stop();
  const sbId = a.sandboxId;
  const st = await wbx.sandboxes.get(sbId);
  assert.ok(["sleeping", "falling_asleep"].includes(st.state), st.state);
  const b = sandbox({ id }, t);
  assert.equal((await b._start()).outcome, "connected");
  assert.equal(b.sandboxId, sbId);
  assert.equal((await b.executeCommand("cat /home/user/state.txt")).stdout, "kept\n");
});

test("checkpoints: snapshot, then a new sandbox starts from it", { skip, timeout: 420_000 }, async (t) => {
  const cp = `${RUN}-cp`;
  const a = sandbox({ id: `${RUN}-c1`, checkpointName: cp }, t);
  await a._start();
  await a.executeCommand("echo from-checkpoint > /home/user/seed.txt && sync");
  await a.snapshot();
  const snaps = (await wbx.snapshots.list()).filter((s) => s.name === cp);
  assert.equal(snaps.length, 1);
  const b = sandbox({ id: `${RUN}-c2`, checkpointName: cp }, t);
  assert.equal((await b._start()).outcome, "created");
  assert.equal((await b.executeCommand("cat /home/user/seed.txt")).stdout, "from-checkpoint\n");
  await b.snapshot(); // replaces the older snapshot of that name
  assert.equal((await wbx.snapshots.list()).filter((s) => s.name === cp).length, 1);
});

test("Mastra workspace tools run in the sandbox", { skip, timeout: 240_000 }, async (t) => {
  const ws = new Workspace({ sandbox: sandbox({ id: `${RUN}-ws` }, t) });
  await ws.init();
  const r = await ws.sandbox.executeCommand("python3 -c 'print(sum(range(10)))'");
  assert.equal(r.stdout.trim(), "45");
  const info = await ws.sandbox.getInfo();
  assert.equal(info.provider, "wbx");
  assert.ok(info.metadata.sandboxId);
  await ws.destroy();
});
