# github-core-clone-01 — a standalone GitHub-compatible git forge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/0xPaasepp/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/0xPaasepp/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

One process, Node 22, standard library only. No UI, no outside service, no
git binary, no dependencies. It serves a whole forge from its own
in-memory store:

- **git smart HTTP** — upload-pack v2 and receive-pack v0 for clone, fetch
  and push, with a hand-built object engine (SHA-1 objects, pack read and
  write, OFS/REF delta resolution, shallow and deepen fetches) on
  `node:zlib` and `node:crypto`.
- **REST v3** under `/api/v3` — repositories, contents, issues, comments,
  labels, pull requests, their files and squash merges.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` actually send, plus introspection, connections with
  cursors, and the five mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP (revision
  2026-07-28, with the legacy `initialize` handshake), eight tools that
  act on the same store as REST.

The transport is raw sockets (`node:net`) with a hand-rolled HTTP/1.1
parser: keep-alive and pipelined requests, Content-Length and chunked
bodies, `Expect: 100-continue`, Buffer responses built once and reused,
pack/advertisement/issue-response caches, and lean hot paths with no
per-request allocations on the read path.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the environment at
`$MAKEFUN_ENV_URL`, then polls `/done` until the trial ends and exits 0.
Every request the suite makes carries `Authorization: Bearer
$MAKEFUN_SHOP_TOKEN`; `/healthz` takes none.

## Layout

- `main.ts` — entrypoint: the register / poll / exit lifecycle.
- `app.ts` — the raw-socket HTTP/1.1 server and router.
- `store.ts` — the in-memory store: users, repos, issues, pulls, labels.
- `git.ts` — the git object engine: objects, pkt-lines, packs, fetch plans.
- `git-http.ts` — git smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `rest.ts` — the REST v3 API, with a per-issue response cache.
- `graphql.ts` — the GraphQL v4 API.
- `mcp.ts` — the MCP endpoint, eight tools.

State is deterministic: every timestamp is a monotonic sequence number,
never wall-clock time, so two runs of the same request order export the
same state byte for byte. Replays match.

## License

MIT — see [LICENSE](LICENSE).
