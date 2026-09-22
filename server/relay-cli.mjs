// Entry point for an unattended relay job, run in a visible terminal by
// launch.mjs `launchRelay`:  node relay-cli.mjs <path-to-spec.json>
// Exit code 0 = every todo resolved; 1 = failed / stalled / stopped.
import { runRelay } from "./relay.mjs";

const spec = process.argv[2];
if (!spec) {
  console.error("usage: node relay-cli.mjs <spec.json>");
  process.exit(2);
}
const job = await runRelay(spec);
process.exit(job.status === "done" ? 0 : 1);
