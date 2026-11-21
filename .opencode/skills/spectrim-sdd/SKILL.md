---
name: spectrim-sdd
description: Token-efficient OpenSpec SDD workflow using SpecTrim CLI (task-scoped slicing, AST-LOD, Hashline patching, log compression, zero-token Pre-Review Gate).
---

# SpecTrim OpenSpec Workflow

1. Detect stack and test/lint commands: `npm run spectrim -- detect <repo>`
2. Slice spec per task in fresh session: `npm run spectrim -- slice <repo> <changeId> --task TSK-XX`
3. Annotate code and tests with `@spec:REQ-XX`.
4. Run zero-token Pre-Review Gate before LLM review: `npm run spectrim -- gate <repo> <changeId>`
5. Run reproducible two-worktree A/B benchmark: `npm run spectrim -- bench <repo> <changeId>`
