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
  await page.addInitScript(() => { localStorage.setItem("pm.latestTodosOpen", "true"); if (!sessionStorage.getItem("tourtest")) localStorage.setItem("pm.tour.done", "1"); });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(() => { sessionStorage.setItem("tourtest", "1"); localStorage.removeItem("pm.tour.done"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".tour-card", { timeout: 3000 }).catch(() => fail("tour: did not open on first run"));
  await page.keyboard.press("ArrowRight");
  await page.waitForSelector(".tour-hole", { timeout: 2000 }).catch(() => fail("tour: step 2 has no spotlight"));
  // Walk the whole tour with the arrow keys: it must visit other pages and end back on the board.
  const seen = new Set();
  for (let k = 0; k < 40 && (await page.locator(".tour-card").count()); k++) {
    await page.waitForTimeout(450);
    seen.add(await page.evaluate(() => (document.querySelector(".tour-card h3")?.textContent || "") + "|" + (document.querySelector("button.back") ? "page" : "home")));
    await page.keyboard.press("ArrowRight");
  }
  if (![...seen].some((x) => x.endsWith("|page"))) fail("tour: never opened a project page");
  if (await page.locator(".tour-card").count()) fail("tour: arrows did not reach the end");
  if (await page.locator("button.back").count()) fail("tour: did not return to the board");
  await page.evaluate(() => localStorage.removeItem("pm.tour.done"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".tour-card", { timeout: 3000 });
  await page.keyboard.press("Escape");
  if (await page.locator(".tour-card").count()) fail("tour: Esc did not close");
  if ((await page.evaluate(() => localStorage.getItem("pm.tour.done"))) !== "1") fail("tour: done flag not stored");
  await page.evaluate(() => sessionStorage.removeItem("tourtest"));
  await page.waitForSelector(".card");
  const cards = await page.$$eval(".card", (els) => els.length);
  if (cards < 2) fail(`expected >=2 project cards, got ${cards}`);

  // Projects fold: open by default, hides cards + search/sort/filter, remembered, and the tour reopens it only while it needs it.
  const projHead = page.locator(".projects-head");
  if ((await projHead.getAttribute("aria-expanded")) !== "true") fail("projects fold: not open by default");
  if (!(await page.locator(".projects-fold .find input[type=search]").count())) fail("projects fold: search is not inside it");
  await projHead.click();
  if (await page.locator(".card, .find").count()) fail("projects fold: collapsing left cards or search visible");
  if (!/\(\d+\)/.test(await projHead.innerText())) fail("projects fold: no count in the header");
  await page.evaluate(() => { sessionStorage.setItem("tourtest", "1"); localStorage.removeItem("pm.tour.done"); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".tour-card", { timeout: 3000 });
  for (let k = 0; k < 12 && (await page.locator(".tour-card h3").innerText()) !== "Project cards"; k++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(400);
  if (!(await page.locator(".cards .card").count()) || !(await page.locator(".tour-hole").count())) fail("projects fold: tour did not open it for the cards step");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.evaluate(() => sessionStorage.removeItem("tourtest"));
  if ((await page.locator(".projects-head").getAttribute("aria-expanded")) !== "false") fail("projects fold: tour did not restore the closed state");
  if (await page.locator(".card").count()) fail("projects fold: cards visible after the tour closed it");
  await page.locator(".projects-head").click();
  await page.waitForSelector(".card");
  if ((await page.evaluate(() => localStorage.getItem("pm.projectsOpen"))) !== "1") fail("projects fold: open state not saved");

  // Home "Latest todos" panel at phone width: list renders, add works, selection
  // flips the run button label, and nothing overflows horizontally.
  await page.setViewportSize({ width: 390, height: 844 });
  // Card titles stay on one line at phone width, even with a descriptor at the 40-char limit.
  const titleFit = await page.$$eval(".card-top .title-text", (els) => {
    if (!els[0]) return { count: 0 };
    const was = els[0].textContent;
    els[0].textContent = "insta-reel-advisor/ — " + "x".repeat(40);
    const top = els[0].closest(".card-top");
    const r = { count: els.length, lines: els[0].getClientRects().length, tall: els[0].offsetHeight, over: top.scrollWidth - top.clientWidth, cut: els[0].scrollWidth > els[0].clientWidth };
    els[0].textContent = was;
    return r;
  });
  if (!titleFit.count || titleFit.lines !== 1 || titleFit.tall > 30 || titleFit.over > 0 || !titleFit.cut) fail(`card title wraps or overflows ${JSON.stringify(titleFit)}`);
  await page.waitForSelector(".lt-row");
  const ltBefore = await page.$$eval(".lt-row", (e) => e.length);
  if (!(await page.textContent(".lt-run-btn")).includes("Run all listed"))
    fail("latest todos: expected 'Run all listed' with nothing selected");
  await page.selectOption(".lt-select", "hub");
  await page.fill(".lt-input", "verify latest probe");
  await page.click(".lt-add .lt-btn");
  await page.waitForFunction((n) => document.querySelectorAll(".lt-row").length > n, ltBefore, { timeout: 4000 });
  // file order: Doing stays above, the new todo tops Todo
  const latest = await page.evaluate((u) => fetch(u).then((r) => r.json()), new URL("/api/todos/latest?limit=30", BASE).href);
  const firstTodo = latest.find((t) => t.state === "Todo")?.title;
  if (firstTodo !== "verify latest probe") fail(`latest todos: newest not first in Todo (${firstTodo})`);
  if (!(await page.locator(".lt-row .lt-title", { hasText: "verify latest probe" }).count())) fail("latest todos: new todo not listed");
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
  // Start button on the project page: same control as the card, and it launches (dry run here).
  const pageStart = page.locator(".proj-top .start-btn");
  if (!(await pageStart.count())) fail("project page: no Start button for a project with start.sh");
  else {
    const started = page.waitForResponse((r) => r.url().endsWith("/api/projects/hub/start") && r.request().method() === "POST");
    await pageStart.click();
    if (!(await started).ok()) fail("project page: Start request failed");
    await page.setViewportSize({ width: 390, height: 800 });
    const box = await pageStart.boundingBox();
    if (box.x < 0 || box.x + box.width > 390) fail("project page: Start button leaves a 390px screen");
    if (process.env.PM_SHOT_PROJECT) await page.screenshot({ path: process.env.PM_SHOT_PROJECT + "-390.png" });
    await page.setViewportSize({ width: 1280, height: 800 });
    if (process.env.PM_SHOT_PROJECT) { await page.waitForTimeout(600); await page.screenshot({ path: process.env.PM_SHOT_PROJECT + "-1280.png" }); }
  }
  const heads = await page.$$eval(".block-head h2", (e) =>
    e.map((x) => x.textContent.toLowerCase()),
  );
  if (!heads.includes("backlog")) fail(`no Backlog block: ${heads}`);
  // back from a project: its card is scrolled into view
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goBack();
  await page.waitForSelector('.cards .card[data-slug="hub"]');
  await page.waitForTimeout(900);
  const inView = await page.evaluate(() => {
    const r = document.querySelector('.cards .card[data-slug="hub"]').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  if (!inView) fail("back from project: card not scrolled into view");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".card", { hasText: "hub" }).first().click();
  await page.waitForSelector(".block");
  if (!heads.includes("sessions")) fail(`no Sessions block: ${heads}`);
  const before = await page.$$eval(".tg .task", (e) => e.length);

  // hub's fixture Done item is weeks old, so the Done header offers Compact; clicking it
  // must launch (dryrun) without toggling the section open.
  const doneHead = page.locator(".tg-toggle", { hasText: "Done" });
  const compact = doneHead.locator("button", { hasText: "Compact" });
  if (!(await compact.count())) fail("Done header: no Compact button for an old Done item");
  else {
    const launched = page.waitForResponse((r) => r.url().endsWith("/compact-done"), { timeout: 4000 });
    await compact.click();
    if ((await launched).status() !== 200) fail("Compact: launch route did not answer 200");
    if ((await doneHead.getAttribute("aria-expanded")) !== "false") fail("Compact click toggled the Done section");
  }

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

  // fill: an open todo's "auto" toggle persists to /api/fill, and Home's panel counts it
  const autoBtn = page.locator(".tg .task .auto-btn").first();
  if (!(await autoBtn.count())) fail("fill: open todos show no auto toggle");
  else {
    await autoBtn.click();
    await page.waitForSelector(".tg .task .auto-btn.on", { timeout: 4000 }).catch(() => fail("fill: auto toggle didn't turn on"));
    const queued = await page.evaluate((u) => fetch(u).then((r) => r.json()).then((d) => d.queued), new URL("/api/fill", BASE).href);
    if (queued !== 1) fail(`fill: expected 1 queued auto todo, got ${queued}`);
    // Auto project: every open todo shows auto (locked), the API queues them all; then switch it back off.
    const fillApi = new URL("/api/fill", BASE).href;
    const proj = page.locator(".auto-project input");
    await proj.check();
    await page.waitForFunction(() => [...document.querySelectorAll(".tg .task .auto-btn")].every((b) => b.classList.contains("on") && b.disabled), null, { timeout: 4000 }).catch(() => fail("fill: Auto project didn't lock every todo on"));
    const all = await page.evaluate((u) => fetch(u).then((r) => r.json()), fillApi);
    const open = await page.$$eval(".tg .task .auto-btn", (e) => e.length);
    if (!all.autoProjects?.includes("hub") || all.queued !== open) fail(`fill: auto project should queue all ${open} open todos (queued=${all.queued})`);
    await proj.uncheck();
    await page.waitForFunction(() => document.querySelectorAll(".tg .task .auto-btn.on").length === 1, null, { timeout: 4000 }).catch(() => fail("fill: turning Auto project off should keep only the single marked todo"));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForSelector(".card");
    const panel = await page.locator(".fill-queued").innerText({ timeout: 4000 }).catch((e) => `missing: ${e.message.split("\n")[0]}`);
    if (!/^1 auto todo$/.test(panel)) fail(`fill: Home panel should count the auto todo (${panel}) body=${(await page.innerText("body")).slice(0, 300)}`);
    const cardTag = await page.locator(".card .card-auto.part").innerText({ timeout: 4000 }).catch(() => "missing");
    if (cardTag !== "auto 1") fail(`fill: card with one auto todo should show "auto 1" (${cardTag})`);
    // Home panel: the count opens a list of what's queued; unmarking there drops it, then re-mark for the checks below
    await page.locator(".fill-queued").click();
    const listOff = page.locator(".fill-list .fill-row .auto-btn.on:not(:disabled)");
    await listOff.first().waitFor({ timeout: 4000 }).catch(() => fail("fill: the auto todo list didn't open"));
    if ((await listOff.count()) !== 1) fail(`fill: auto list should show 1 unselectable todo, got ${await listOff.count()}`);
    else {
      const markedTitle = (await page.locator(".fill-list .fill-row-title").innerText()).trim();
      await listOff.click();
      await page.waitForFunction(() => !document.querySelector(".fill-list"), null, { timeout: 4000 }).catch(() => fail("fill: unselecting in the auto list didn't stick"));
      await page.evaluate(([u, title]) => fetch(u, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "hub", title, on: true }) }), [new URL("/api/fill/auto", BASE).href, markedTitle]);
      await page.waitForSelector(".fill-list .fill-row", { timeout: 8000 }).catch(() => fail("fill: re-marked todo didn't return to the list"));
    }
    await page.locator(".fill-queued").click();
    // Home: the marked todo shows auto on in Latest todos, and unmarking it there doesn't tick the row.
    const ltOn = page.locator(".lt-row .auto-btn.on");
    await ltOn.first().waitFor({ timeout: 4000 }).catch(() => {});
    if ((await ltOn.count()) !== 1) fail(`fill: Latest todos should show 1 auto todo, got ${await ltOn.count()}`);
    else {
      await ltOn.click();
      await page.waitForFunction(() => !document.querySelector(".lt-row .auto-btn.on"), null, { timeout: 4000 }).catch(() => fail("fill: unmarking auto on Home didn't stick"));
      if (await page.locator(".lt-row.on").count()) fail("fill: clicking auto on Home also ticked the row");
      if ((await page.evaluate((u) => fetch(u).then((r) => r.json()), fillApi)).queued !== 0) fail("fill: Home unmark should leave 0 queued");
    }
    // Auto project shows an "auto" tag on its Home card
    // Home card "auto" pill turns the whole project auto (and back off) without opening the card
    const cardAuto = page.locator(".card .card-auto[aria-label*=\" hub \"]");
    await cardAuto.click();
    await page.waitForSelector(".card .card-auto.on", { timeout: 4000 }).catch(() => fail("fill: card auto pill didn't turn the project on"));
    if (!new URL(page.url()).pathname.match(/^\/?$/)) fail(`fill: clicking the card auto pill opened the project (${page.url()})`);
    const ap = (await page.evaluate((u) => fetch(u).then((r) => r.json()), fillApi)).autoProjects || [];
    if (ap.join() !== "hub") fail(`fill: card pill should make only hub auto (${ap})`);
    await page.waitForSelector(".lt-row .auto-btn:disabled.on", { timeout: 4000 }).catch(() => fail("fill: Latest todos should lock auto on for an Auto project's todos"));
    await cardAuto.click();
    await page.waitForFunction(() => !document.querySelector(".card .card-auto.on"), null, { timeout: 4000 }).catch(() => fail("fill: card auto pill didn't turn the project back off"));
  }

  // command palette: Ctrl+K opens, typing filters, Enter navigates
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".pal-input", { timeout: 3000 }).catch(() => fail("palette: Ctrl+K did not open it"));
  // wait for focus + the filtered row: on a busy Home (fill, cards) keystrokes typed before focus were lost (~1 in 5 runs)
  await page.waitForFunction(() => document.activeElement?.classList.contains("pal-input"), null, { timeout: 3000 }).catch(() => {});
  await page.keyboard.type("doctor");
  await page.waitForFunction(() => /doctor/i.test(document.querySelector(".pal-row.on")?.innerText || ""), null, { timeout: 3000 }).catch(() => {});
  const palText = await page.evaluate(() => (document.querySelector(".pal-input")?.value || "") + " | " + (document.querySelector(".pal-list")?.innerText?.slice(0, 200) || ""));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.pathname === "/doctor", null, { timeout: 3000 }).catch(() => fail(`palette: Enter did not navigate (${page.url()}) [${palText.replace(/\s+/g, " ")}]`));
  if (await page.$(".pal-input")) fail("palette: should close after running a command");

  // help tooltips: portaled to <body>, fully inside the viewport (never clipped/covered by a panel)
  await page.goto(BASE, { waitUntil: "networkidle" });
  const helps = page.locator(".help-btn");
  for (let i = 0, n = Math.min(await helps.count(), 6); i < n; i++) {
    await helps.nth(i).hover();
    const r = await page.evaluate(() => {
      const t = document.querySelector('[role="tooltip"]');
      if (!t) return null;
      const b = t.getBoundingClientRect();
      return { body: t.parentElement === document.body, ok: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight };
    });
    if (!r) fail(`help ${i}: no tooltip on hover`);
    else if (!r.body || !r.ok) fail(`help ${i}: tooltip not portaled/inside viewport ${JSON.stringify(r)}`);
    await page.mouse.move(0, 0);
  }

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  if (!process.exitCode) console.log("browser check OK");
} finally {
  await browser.close();
}
