# AGENTS.md — SpecTrim SDD Workflow Policy

1. **Task-Scoped Micro-Sessions**: For each task `TSK-XX` in `openspec/changes/<id>/tasks.md`, isolate the session and load only the sliced context produced by `npm run spectrim -- slice <repo> <changeId> --task TSK-XX`.
2. **AST-LOD & Hashline Reading**: Read target files to edit at `LOD0` (`L{n}#{hash}:`) and neighboring dependencies as `LOD1` AST skeletons. Never re-read unchanged files in the same session.
3. **Hashline Range Patches**: Apply edits using verified `L{start}#{hash}..L{end}#{hash}` anchors rather than rewriting full files. Reject and re-read on stale hashes.
4. **Requirement Traceability**: Annotate implemented code and tests with `@spec:REQ-XX` markers matching `specs/*/spec.md`.
5. **Zero-Token Pre-Review Gate**: Always run `npm run spectrim -- gate <repo> <changeId>` before invoking LLM code review. Only send the compressed delta diff to the LLM reviewer after deterministic checks pass.
6. **Provenance Discipline**: Never label `simulated` or `demo_fixture` metrics as `measured`. Real A/B evidence requires paired Git worktrees or verified copies of one snapshot, matching model/provider, and original provider usage.
