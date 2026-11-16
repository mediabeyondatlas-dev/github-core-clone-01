# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mediabeyondatlas-dev/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mediabeyondatlas-dev/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process, written in TypeScript
(Node 22, standard library only). It serves four surfaces on one base URL:

- **REST v3** under `/api/v3` (repos, branches, commits, contents, issues,
  labels, comments, pull requests, merge)
- **GraphQL** at `/api/graphql` (repository, issues, pull requests, mutations,
  `__type` introspection, global node ids)
- **MCP** at `/mcp` (JSON-RPC 2.0 Streamable HTTP, `server/discover` +
  `initialize` eras, tools for repos, issues and pull requests)
- **Git smart HTTP** at `/{owner}/{repo}.git` (upload-pack protocol v2 with
  v0 fallback, receive-pack v0, packfiles, shallow fetch, fast-forward rules)

## Run

The entrypoint is `main.ts`. It binds an ephemeral port, registers it with
the environment (`POST $MAKEFUN_ENV_URL/register {"port": n}`), then polls
`GET $MAKEFUN_ENV_URL/done` until the trial ends and exits 0.

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 \
MAKEFUN_SHOP_TOKEN=<token> \
MAKEFUN_TRIAL_SEED=<seed> \
MAKEFUN_TRIAL_NOW=<iso-timestamp> \
node main.ts
```

All state is in memory. All timestamps come from `MAKEFUN_TRIAL_NOW`; all
ids are counters or seeded values, so two runs of the same trial are
byte-identical.

## Layout

- `main.ts` — lifecycle: bind, register, poll done, exit.
- `src/app.ts` — HTTP server and routing.
- `src/scenario.ts` — the seeded viewer identity (the token's login).
- `src/gitpack.ts` — git objects, pkt-lines, packfiles.
- `src/store.ts` — the in-memory forge: repos, refs, objects, issues, PRs.
- `src/rest.ts` — REST v3 handlers.
- `src/mcp.ts` — MCP handlers.
- `src/graphql.ts` — GraphQL parser and executor.
- `src/git.ts` — git smart-HTTP handlers.
- `src/http.ts` — small HTTP/JSON helpers shared by the handlers.

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dk68ddnc&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
