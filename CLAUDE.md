# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

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

## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
