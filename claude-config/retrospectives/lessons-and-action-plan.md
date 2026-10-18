# Lessons and action plan

Failure patterns that kept recurring across Claude Code sessions, each with a concrete prevention
action. Patterns, not raw incidents: when `/retro` (see `skills/retro`) logs the same mistake a
second time, it belongs here.

## 1. Declared "fixed"/"confirmed" without real end-to-end verification

Typical cases: a synthetic repro called "confirmed" instead of measuring the real app; a dev
server left running; several bugs shipped as "done" and only caught when the user retested; a
refresh bug "fixed" by checking a map that was never populated on that code path.

**Action:** before saying "fixed"/"confirmed", either show real evidence (measurement, log line,
running output) or say explicitly "changed but unverified, because X." A memory note alone does
not hold for this one; see pattern 7.

## 2. Reinvented a mechanism instead of diffing it against an existing correct sibling

Typical cases: rebuilding state as ephemeral when a correct persistent version of the same
pattern sits in the same file; wiring a button to the wrong pre-existing function without
comparing it to the sibling a few lines away, then writing a comment defending the choice.

**Action:** before wiring new behavior to an existing function, or building new state for
something that already has a same-purpose sibling, diff the two side by side.

## 3. Presented an inference as a settled/verified fact

Typical cases: a root-cause guess called "exactly the diagnosis" with no access to the evidence; a
code comment stating a design rationale that was an unverified assumption; a mutating command
planned from remembered state instead of checking the current state first.

**Action:** label claims verified vs inferred. This applies to self-authored diagnoses and code
comments, not only to "who wrote this code" provenance claims.

## 4. Unrequested scope change decided silently

Typical cases: adding a label or button nobody asked for; excluding a feature from a plan;
narrowing "update everything so nothing is stale" to the files already being touched.

**Action:** the rule "state a deviation, never decide it silently" exists; the gap is that nobody
checks it before sending. Pre-send check: does this plan/summary add, remove, or narrow anything
the user didn't ask for? If yes, say so in one sentence first.

## 5. Ignored an explicit standing instruction given earlier in the same session

Typical cases: the user said "I run all git commands" at the start and a git-running step was
planned later anyway; plan-mode ceremony applied mechanically to a plain research question, and
again after the user said "stop and wait".

**Action:** before proposing a command or invoking a procedural gate (ExitPlanMode,
AskUserQuestion), scan back through the session for a standing instruction that overrides the
default procedure for this case. `hooks/destructive_command_guard.py` enforces the git half.

## 6. Irreversible action taken on an ambiguous instruction without confirming scope

Typical case: "remove the logs" interpreted as the most recently discussed topic, and the wrong
log files were deleted.

**Action:** an ambiguous deletion/removal request gets one clarifying question before `rm`.
`hooks/destructive_command_guard.py` enforces this for wildcard/recursive deletes.

## 7. Fixed a decaying-instruction problem with another decaying instruction

Typical case: after diagnosing that a passive memory note doesn't reliably hold, another
memory-note reminder was added as the fix. The language rule only held once it became a
`UserPromptSubmit` hook.

**Action:** when the fix is "make future-me reliably do X", default to a hook or script check over
a new memory file. A memory note is the right tier only when the user asks for one, or the
failure mode genuinely can't be checked mechanically.

## 8. Housekeeping drift at turn boundaries

Typical cases: a background dev server left running; a tool call made and never used or
mentioned; a code comment referencing the task/session/PR it came from; a todo list started
late although the ask was multi-step from the first message.

**Action:** one end-of-turn check: no stray background processes, no code comment referencing
this task/session/PR, no tool call left unexplained, todo list opened at the first sign of 3+
distinct steps.

## Enforcement tiers

Patterns 1-3 recur even with a memory note, so the fix is enforcement, not another note. Patterns
5 and 6 are covered by a hook (`hooks/destructive_command_guard.py`). Patterns 4 and 8 are hard to
check mechanically: keep them as memory entries and reinforce them when they drift.
