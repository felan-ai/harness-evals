# Agent Instructions

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Session Completion

**When ending a work session**, complete these steps. Leave code changes uncommitted and unpushed unless the user explicitly asks for a commit or push.

1. **Run quality gates** (if code changed) - Tests, linters, builds
2. **Check git status** - Report changed files and whether they are staged, committed, or uncommitted
3. **Hand off** - Provide concise context for the next session

## Git Workflow

- Work on `main` by default.
- Do not create branches unless the user explicitly asks.
- Do not commit or push unless the user explicitly asks.
- When the user asks for a commit, commit only the requested changes after checking `git status`.
- When the user asks for a push, pull/rebase as needed and push only the requested branch.
