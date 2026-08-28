# Refresh dispatcher

Cloudflare Worker that triggers the catalogue refresh hourly.

## Why this exists

GitHub Actions barely honours the cron on this repository. Against an hourly
schedule on an active workflow on the default branch, with the repo public, not
a fork, Actions enabled and no queued runs, it delivered **one** `schedule`
event in roughly 24 hourly slots, and that one arrived 25 minutes late
(cron `7 * * * *`, fired 18:32 UTC on 28 Aug 2026). `workflow_dispatch` and
`repository_dispatch` worked throughout, so the workflow itself is fine and
GitHub simply is not enqueueing the cron reliably. Cloudflare cron triggers are
dependable, so the schedule lives here instead.

## Deploy

One secret: a **fine-grained** GitHub personal access token scoped to this
repository only, with

- Contents: **write**

created at <https://github.com/settings/personal-access-tokens/new>. Then:

`Contents: write` is what `POST /repos/{owner}/{repo}/dispatches` requires.
`Actions: write` is the permission for `workflow_dispatch`, a different
endpoint, and is not needed here. With only `Contents: read` the dispatch fails
with `403 Resource not accessible by personal access token`.


```
cd worker
wrangler login                       # if `wrangler whoami` says not logged in
wrangler secret put GITHUB_TOKEN     # paste the PAT when prompted
wrangler deploy
```

The token is a Worker secret. It is never written to `wrangler.toml` or to git.

## Verify

Three checks, in increasing order of how much they actually prove.

**1. Did the deploy land?** Proves the Worker responds and a non-empty
`GITHUB_TOKEN` secret exists. It does **not** prove the token is valid or
correctly scoped.

```
curl https://disaster-imagery-refresh.giovand.workers.dev
```

**2. Does the token actually work?** This is the only check that exercises the
real path: Worker code, the real deployed secret, and GitHub's dispatch
endpoint. `wrangler dev --remote` runs on Cloudflare's edge bound to the live
secrets, and `--test-scheduled` lets the cron handler be fired on demand.

```
wrangler dev --remote --port 8802 --test-scheduled
curl 'http://127.0.0.1:8802/__scheduled?cron=7+*+*+*+*'
```

Then read the Worker log. `ok: dispatched refresh to ...` means the whole chain
works. A failure prints GitHub's own status, and the two worth recognising are:

| Log line | Meaning |
|---|---|
| `GitHub returned 401` | Token is wrong, revoked or empty |
| `GitHub returned 403: Resource not accessible` | Token lacks `Contents: write` |

Note that `/__scheduled` answers `200 Ran scheduled event` either way. The
verdict is in the log, not the HTTP status.

**3. Did Cloudflare's own cron fire?** The one thing that cannot be forced.

```
wrangler tail                        # watch cron fires, one per hour at :07
gh run list --repo cgiovando/disaster-imagery-viewer --limit 3
```

A run with event `repository_dispatch` at about :07 means the schedule works.

## Triggering a refresh by hand

```
gh workflow run refresh.yml --repo cgiovando/disaster-imagery-viewer
```

This talks to GitHub directly, so it is a way to refresh, **not** a test of the
Worker: it bypasses the Worker, the PAT and the dispatch path entirely. Use
check 2 above to test those.

The Worker deliberately exposes **no** HTTP trigger. An open one would let
anyone who learned the URL spawn unlimited Actions runs, each hitting OAM,
titiler, HDX and Planetary Computer, and guarding it would mean a second shared
secret to invent, store and remember for no real gain over `gh workflow run`.
Requests other than GET and HEAD get `410 Gone` rather than a misleading 200,
so an older runbook doing `curl -X POST` fails loudly instead of appearing to
succeed while nothing happens.

## Local testing

No Cloudflare account needed. Put a dummy token in `worker/.dev.vars`
(gitignored, never commit it):

```
GITHUB_TOKEN=dummy
```

Then:

```
wrangler dev --port 8799 --local --test-scheduled
curl 'http://127.0.0.1:8799/'                            # status JSON
curl -i 'http://127.0.0.1:8799/__scheduled?cron=7+*+*+*+*'
```

With a dummy token the scheduled run logs GitHub's own `401 Bad credentials`.
That is the success signal locally: it proves the request reached GitHub and
only the token was rejected. A real token yields 204 and logs `ok: dispatched`.

## Notes

- `compatibility_date` must not exceed what the installed wrangler's bundled
  runtime supports, or `wrangler dev` refuses to start with "newest date
  supported by this server binary". Bump it only alongside a wrangler upgrade.
- The `scheduled` handler rethrows after logging, so failures appear in
  `wrangler tail` rather than vanishing.
- The Actions cron in `.github/workflows/refresh.yml` is deliberately left in
  place. If GitHub starts honouring it the only cost is a duplicate hourly run,
  and the `concurrency` group in that workflow serialises them.
