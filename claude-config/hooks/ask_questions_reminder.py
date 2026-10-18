#!/usr/bin/env python3
"""UserPromptSubmit hook: re-injects the "ask, never write open questions in prose" rule every turn.

Why: CLAUDE.md and memory already say it, but open questions still end up as a prose
"Questions for you" list. Cause: the ponytail plugin tells the model to "ship the lazy
version and question it in the same response", which reads as permission to ask in prose.
This reminder explicitly overrides that line. Edit/disable: settings.local.json -> hooks.UserPromptSubmit
"""
print(
    "QUESTION RULE (unconditional): every open question, fork, or 'which of these?' goes through "
    "the AskUserQuestion tool with concrete options, before ending the turn. NEVER put questions in "
    "the final summary prose (no 'Questions for you', no 'Say so if you want X', no trailing '?'). "
    "This overrides ponytail's 'question it in the same response': ponytail still ships the lazy "
    "default, but the question itself is asked via AskUserQuestion."
)
