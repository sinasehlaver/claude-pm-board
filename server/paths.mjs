import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// PM_ROOT is the workspace root that owns the .claude/ dir we read & write.
// Set it to your projects folder to override. Defaults to the parent of this
// package (pm/ is expected to live directly under the workspace it manages),
// not process.cwd() — npm always runs `dev`/`start` with cwd = pm/, which has
// no .claude/state of its own and would silently render an empty board.
// Verify runs and tests override this explicitly via env.
const DEFAULT_PM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PM_ROOT = process.env.PM_ROOT || DEFAULT_PM_ROOT;
export const CLAUDE = join(PM_ROOT, ".claude");
export const STATE_DIR = join(CLAUDE, "state");
export const RULES_DIR = join(CLAUDE, "rules");
export const BACKLOG_DIR = join(CLAUDE, "backlog");
export const HANDOFFS_DIR = join(CLAUDE, "handoffs");
export const PM_DIR = join(CLAUDE, "pm");
export const ACTIVITY_FILE = join(PM_DIR, "activity.json");
export const SESSIONS_FILE = join(PM_DIR, "sessions.json");
export const SESSION_INDEX_FILE = join(PM_DIR, "session-index.json");
export const PLANS_DIR = join(process.env.HOME || "", ".claude", "plans");

// continuous/ — the burn-rate-paced autonomous runner (sibling project).
// CONTINUOUS_ROOT holds its code + config.json; CONTINUOUS_DIR holds its
// runtime files (state.json, log.jsonl, plans/, runner.lock) under .claude/.
export const CONTINUOUS_ROOT = process.env.CONTINUOUS_ROOT || join(PM_ROOT, "continuous");
export const CONTINUOUS_DIR = join(CLAUDE, "continuous");
