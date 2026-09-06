# Contributing

Small project, simple rules.

- `npm run typecheck && npm test` must pass. Both are fast.
- No runtime dependencies in the core. The whole thing should stay droppable
  into a `<script>` tag.
- Visual encoding changes need a reason in the PR description. The encodings in
  `src/scales.ts` are argued for in the README; if you are changing one, change
  the argument too.
- New adapters go in `src/adapters/` and implement `GraphSource`. They must not
  pull the renderer in as a dependency.
- Keep the layout deterministic. Same graph in, same picture out.
