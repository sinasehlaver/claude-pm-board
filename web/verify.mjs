// Browser check for the PM board. Driven by scripts/verify.sh (sets PM_URL).
import { launch } from "../../.claude/scripts/browser.mjs";

const BASE = process.env.PM_URL || "http://127.0.0.1:4500/";
const { browser, page, errors } = await launch();
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};

try {
  // Latest todos is collapsed by default; open it via its persisted flag (not the toggle UI).
  await page.addInitScript(() => localStorage.setItem("pm.latestTodosOpen", "true"));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");
  const cards = await page.$$eval(".card", (els) => els.length);
  if (cards < 2) fail(`expected >=2 project cards, got ${cards}`);

  // Home "Latest todos" panel at phone width: list renders, add works, selection
  // flips the run button label, and nothing overflows horizontally.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector(".lt-row");
  const ltBefore = await page.$$eval(".lt-row", (e) => e.length);
  if (!(await page.textContent(".lt-run-btn")).includes("Run all listed"))
    fail("latest todos: expected 'Run all listed' with nothing selected");
  await page.selectOption(".lt-select", "hub");
  await page.fill(".lt-input", "verify latest probe");
  await page.click(".lt-add .lt-btn");
  await page.waitForFunction((n) => document.querySelectorAll(".lt-row").length > n, ltBefore, { timeout: 4000 });
  const firstTitle = await page.textContent(".lt-row .lt-title");
  if (!firstTitle.includes("verify latest probe")) fail(`latest todos: newest not first (${firstTitle})`);
  await page.locator(".lt-row").first().click();
  if (!(await page.textContent(".lt-run-btn")).includes("Run selected (1)"))
    fail("latest todos: selecting a row should read 'Run selected (1)'");
  // Run must not pop a blocking confirm/alert; feedback is an inline notice instead.
  let dialog = null;
  page.once("dialog", (d) => {
    dialog = d.message();
    d.dismiss();
  });
  await page.click(".lt-run-btn");
  await page.waitForSelector(".lt-notice", { timeout: 4000 }).catch(() => {});
  if (dialog) fail(`latest todos: run opened a blocking dialog: ${dialog}`);
  if (!(await page.$(".lt-notice"))) fail("latest todos: run showed no inline notice");
  await page.locator(".lt-row").first().click(); // re-select for the checks below
  // unattended relay: toggle defaults on + persists; a waiting job shows its resume time
  const toggle = page.locator(".lt-run .relay-toggle input");
  if (!(await toggle.isChecked())) fail("relay: Unattended should default to on");
  await toggle.uncheck();
  if ((await page.evaluate(() => localStorage.getItem("pm.unattended"))) !== "0") fail("relay: toggle not persisted");
  await toggle.check();
  await page.waitForSelector(".relay-row");
  const relayText = await page.textContent(".relay-strip");
  if (!/waiting/.test(relayText) || !/resumes/.test(relayText) || !/2 left/.test(relayText))
    fail(`relay: strip should show a waiting job with resume time (${relayText})`);
  // the panel itself must fit the viewport (other Home chrome is out of scope here)
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll(".lt, .lt *")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
      .map((el) => el.className || el.tagName)
      .slice(0, 5),
  );
  if (overflow.length) fail(`latest todos: overflow at 390px: ${overflow.join(", ")}`);
  if (process.env.PM_SHOT) {
    await page.locator(".lt").scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.PM_SHOT, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

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

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  if (!process.exitCode) console.log("browser check OK");
} finally {
  await browser.close();
}
