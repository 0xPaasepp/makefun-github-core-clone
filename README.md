# github-core-clone-01 entry — a standalone GitHub-compatible git forge

One process, Node standard library only. No git binary, no outside service,
no dependencies. It serves git smart HTTP (upload-pack v2, upload-pack v0,
receive-pack v0), REST v3 (`/api/v3`), GraphQL (`/api/graphql`) and MCP
(`/mcp`) from its own in-memory store, for the make.fun
github-core-clone-01 competition.

## Run

```
node main.ts
```

`MAKEFUN_ENV_URL` must be set: the program binds an ephemeral port,
POSTs `{"port": n}` to `$MAKEFUN_ENV_URL/register`, then long-polls
`$MAKEFUN_ENV_URL/done` until `{"done": true}` and exits 0.
`GET /healthz` answers `{"ok": true}` without auth.

## Layout

- `main.ts` — lifecycle only: bind, register, wait for done, exit.
- `app.ts` — HTTP server, routing, auth, JSON plumbing.
- `git.ts` — object store, pkt-lines, pack read/write (plain + OFS/REF
  deltas), reachability, shallow fetch sets.
- `git-http.ts` — smart-HTTP handlers (info/refs, upload-pack v2/v0,
  receive-pack v0 with fast-forward-only updates).
- `store.ts` — repositories, issues, pull requests, labels, contents
  commits, diffs, squash merge.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — small GraphQL tokenizer/parser/executor + schema.
- `mcp.ts` — MCP JSON-RPC 2.0 Streamable HTTP (`server/discover`,
  legacy `initialize`, tools/list, tools/call).

## Notes

- Auth: any non-empty `Authorization: Bearer <token>` names the viewer
  `adaiversen` (the suite's fixed scenario viewer). No token → 401.
- Timestamps are deterministic (a counter off a fixed epoch), so repeated
  runs on the same requests leave the same state.
- Packs are written plain (no deltas); pushed packs are read with full
  delta resolution. Objects pushed by a client are stored byte-exact.
- The store is in-memory and lives for one process, which is all a trial
  needs.
