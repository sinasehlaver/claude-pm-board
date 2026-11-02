// UI audit (run: PM_VERIFY_SCRIPT=audit.mjs npm run verify). Reports layout/a11y problems; screenshots to $AUDIT_OUT.
import { launch } from "../../.claude/scripts/browser.mjs";
import { mkdirSync } from "node:fs";

const BASE = process.env.PM_URL || "http://127.0.0.1:4500/";
const OUT = process.env.AUDIT_OUT || "/private/tmp/claude-501/pm-audit";
mkdirSync(OUT, { recursive: true });
const { browser, page } = await launch();
await page.addInitScript(() => {
  localStorage.setItem("pm.latestTodosOpen", "true");
});

const probe = () => {
  const out = [];
  const vw = innerWidth;
  const sel = (e) => (e.id ? "#" + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""));
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  if (document.documentElement.scrollWidth > vw + 1) out.push(`page-overflow-x: ${document.documentElement.scrollWidth} > ${vw}`);
  for (const e of document.querySelectorAll("body *")) {
    if (!vis(e)) continue;
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    if (r.right > vw + 1 && !e.closest("[style*='overflow']") ) out.push(`offscreen-right: ${sel(e)} right=${Math.round(r.right)}`);
    const clipsX = ["hidden", "clip"].includes(s.overflowX);
    if (clipsX && e.scrollWidth > e.clientWidth + 1 && s.textOverflow !== "ellipsis" && e.children.length === 0 && e.textContent.trim())
      out.push(`silent-text-clip: ${sel(e)} "${e.textContent.trim().slice(0, 40)}"`);
    if (s.webkitLineClamp !== "none" && e.scrollHeight > e.clientHeight + 1 && !e.title && !e.closest("[title]")) out.push(`clamped-no-title: ${sel(e)} "${e.textContent.trim().slice(0, 40)}"`);
    if (s.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1 && !e.title && !e.closest("[title]")) out.push(`ellipsis-no-title: ${sel(e)} "${e.textContent.trim().slice(0, 40)}"`);
  }
  for (const e of document.querySelectorAll("button, a[href], [role=button], input, select, textarea")) {
    if (!vis(e)) continue;
    const name = (e.getAttribute("aria-label") || e.textContent || e.title || e.placeholder || (e.labels && e.labels[0]?.textContent) || "").trim();
    if (!name) out.push(`no-accessible-name: ${sel(e)}`);
    const r = e.getBoundingClientRect();
    if (vw < 600 && (r.height < 28 || r.width < 28) && e.type !== "checkbox" && e.type !== "radio") out.push(`small-target(${Math.round(r.width)}x${Math.round(r.height)}): ${sel(e)} "${name.slice(0, 20)}"`);
  }
  return [...new Set(out)];
};

const report = {};
const pages = [["home", ""], ["project-hub", "project/hub"], ["project-ideas", "project/ideas"], ["sessions", "sessions"], ["doctor", "doctor"], ["setup", "setup"], ["envs", "envs"], ["ports", "ports"], ["changes", "changes"]];
for (const theme of ["light", "dark"]) {
  await page.emulateMedia({ colorScheme: theme });
  for (const w of [390, 768, 1280]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    for (const [name, path] of pages) {
      await page.goto(BASE + path, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(300);
      const key = `${name}@${w}/${theme}`;
      report[key] = await page.evaluate(probe);
      await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, fullPage: true });
    }
  }
}
// keyboard: every focusable shows a visible focus indicator
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(BASE, { waitUntil: "networkidle" });
const noFocus = [];
for (let i = 0; i < 40; i++) {
  await page.keyboard.press("Tab");
  const r = await page.evaluate(() => {
    const e = document.activeElement; if (!e || e === document.body) return null;
    const s = getComputedStyle(e);
    const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none";
    return ring ? null : e.tagName.toLowerCase() + "." + String(e.className).split(" ")[0] + " " + (e.textContent || "").trim().slice(0, 20);
  });
  if (r) noFocus.push(r);
}
report["focus-ring-missing"] = [...new Set(noFocus)];

for (const [k, v] of Object.entries(report)) if (v.length) console.log(`\n## ${k}\n` + v.map((x) => "  " + x).join("\n"));
console.log("\nscreenshots:", OUT);
await browser.close();
