// Browser check for the PM board. Driven by scripts/verify.sh (sets PM_URL).
import { launch } from "../../.claude/scripts/browser.mjs";

const BASE = process.env.PM_URL || "http://127.0.0.1:4500/";
const { browser, page, errors } = await launch();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");
  const cards = await page.$$eval(".card", (els) => els.length);
  if (cards < 2) fail(`expected >=2 project cards, got ${cards}`);

  await page.locator(".card", { hasText: "hub" }).first().click();
  await page.waitForSelector(".block");
  const heads = await page.$$eval(".block-head h2", (e) =>
    e.map((x) => x.textContent.toLowerCase()),
  );
  if (!heads.includes("backlog")) fail(`no Backlog block: ${heads}`);
  if (!heads.includes("sessions")) fail(`no Sessions block: ${heads}`);
  const before = await page.$$eval(".tg .task", (e) => e.length);

  await page.fill(".addrow input", "verify probe task");
  await page.click(".addrow button");
  await page.waitForFunction(
    (n) => document.querySelectorAll(".tg .task").length > n,
    before,
    { timeout: 4000 },
  );

  const n = await page.evaluate(
    (u) =>
      fetch(u)
        .then((r) => r.json())
        .then((d) => d.backlog.tasks.length),
    new URL("/api/projects/hub", BASE).href,
  );
  if (n <= before) fail(`task not persisted (api tasks=${n}, before=${before})`);

  // Continuous tab renders (fixture has config.json but no src/ — decision errors, blocks still draw)
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");
  await page.locator(".bar-actions .link", { hasText: "Continuous" }).click();
  await page.waitForSelector(".block-head h2");
  const cheads = await page.$$eval(".block-head h2", (e) =>
    e.map((x) => x.textContent.toLowerCase()),
  );
  for (const want of ["runner", "budget", "config"])
    if (!cheads.includes(want)) fail(`Continuous: no ${want} block: ${cheads}`);

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  if (!process.exitCode) console.log("browser check OK");
} finally {
  await browser.close();
}
