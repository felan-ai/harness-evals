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

## Local Skill Development

The Skills CLI copies a local skill into its canonical installation directory;
its symlink mode links agent-specific directories to that copy, not back to this
repository. Running `npx skills add . --skill harness-evals --global` therefore
does not keep an installed skill synchronized with later repository edits.

When developing `skills/harness-evals/`, prefer a direct symlink from the
canonical user skill path to this checkout:

```bash
repo_root="$(git rev-parse --show-toplevel)"
skill_source="$repo_root/skills/harness-evals"
skill_target="$HOME/.agents/skills/harness-evals"

test -f "$skill_source/SKILL.md"
mkdir -p "$HOME/.agents/skills"
ln -s "$skill_source" "$skill_target"
```

Before creating the link, inspect `skill_target`. If it already exists and is
not the correct symlink, explain that replacing it changes user-level agent
configuration and obtain the user's approval before removing it with `rm -rf`.
After linking, verify the target with `readlink` and start a new agent session so
the updated skill is reloaded. A later Skills CLI install or update may replace
the direct link; recreate it when continuing local skill development.

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
