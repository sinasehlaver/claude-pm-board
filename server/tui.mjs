// `npm run tui` — keyboard UI for pm, meant to be run over SSH (Termius via Tailscale).
// Reads/writes the same files as the web app through pm's own parsers; opens no port.
import { listProjects } from "./projects.mjs";
import { readBacklog } from "./backlog.mjs";
import { addTask, moveTask } from "./backlog-cli.mjs";
import { listRelayJobs } from "./relay.mjs";
import { readTaskTokens } from "./tokens.mjs";
import { statuslineUsageCached } from "./statusline-usage.mjs";
import { PM_ROOT } from "./paths.mjs";
import { runTodos, stopJob } from "./tui-run.mjs";
import { createApp, parseKeys } from "./tui-core.mjs";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("pm tui needs an interactive terminal (run it over ssh -t, or in Termius)");
  process.exit(1);
}

const app = createApp({
  listProjects,
  readBacklog,
  addTask,
  moveTask,
  runTodos,
  stopJob,
  listJobs: () => listRelayJobs(PM_ROOT),
  tokens: readTaskTokens,
  usage: statuslineUsageCached,
});

const out = process.stdout;
const draw = () => out.write(`\x1b[H\x1b[2J${app.view(out.columns, out.rows).join("\r\n")}`);
const done = () => {
  out.write("\x1b[?25h\x1b[?1049l");
  process.stdin.setRawMode(false);
  process.exit(0);
};

out.write("\x1b[?1049h\x1b[?25l");
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
await app.refresh();
draw();

let chain = Promise.resolve();
process.stdin.on("data", (chunk) => {
  chain = chain.then(async () => {
    for (const k of parseKeys(chunk)) {
      await app.key(k);
      if (app.m.quit) return done();
    }
    draw();
  });
});
out.on("resize", draw);
setInterval(() => {
  if (app.m.mode === "nav") app.refresh().then(draw);
}, 4000);
process.on("SIGTERM", done);
process.on("SIGHUP", done);
