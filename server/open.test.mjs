import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-open-")));
const out = realpathSync(mkdtempSync(join(tmpdir(), "pm-open-out-")));
mkdirSync(join(root, ".claude"), { recursive: true });
mkdirSync(join(root, "hub/reports"), { recursive: true });
writeFileSync(join(root, "hub/reports/R01.pdf"), "%PDF");
writeFileSync(join(root, "hub/run.command"), "echo hi");
writeFileSync(join(out, "secret.pdf"), "%PDF");
symlinkSync(join(out, "secret.pdf"), join(root, "hub/link.pdf"));
symlinkSync(out, join(root, "hub/outdir"));

process.env.PM_ROOT = root;
process.env.PM_LAUNCH_DRYRUN = "1";
const { openFile } = await import("./open.mjs");
const status = (p, slug) => openFile(p, slug).then(() => 200, (e) => e.status);

test("a workspace file opens (dry-run), absolute or relative to PM_ROOT / the slug folder", async () => {
  assert.equal((await openFile(join(root, "hub/reports/R01.pdf"))).path, join(root, "hub/reports/R01.pdf"));
  assert.equal((await openFile("hub/reports/R01.pdf")).dryrun, true);
  assert.equal((await openFile("reports/R01.pdf", "hub")).path, join(root, "hub/reports/R01.pdf"));
});

test("traversal, outside paths, symlinks out, bad types and junk are rejected with 4xx", async () => {
  assert.equal(await status("/etc/passwd"), 400); // no openable extension
  assert.equal(await status(join(out, "secret.pdf")), 403); // absolute, outside
  assert.equal(await status("../../../etc/hosts.txt"), 404); // does not exist under root
  assert.equal(await status(join(root, "..", out.split("/").pop(), "secret.pdf")), 403); // ../ out and back in elsewhere
  assert.equal(await status("hub/link.pdf"), 403); // symlink to a file outside
  assert.equal(await status("hub/outdir/secret.pdf"), 403); // symlinked dir outside
  assert.equal(await status("hub/run.command"), 400); // would execute
  assert.equal(await status("hub/missing.pdf"), 404);
  assert.equal(await status({ a: 1 }), 400);
  assert.equal(await status("hub/R\0.pdf"), 400);
});
