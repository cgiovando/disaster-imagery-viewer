# Refresh dispatcher

Cloudflare Worker that triggers the catalogue refresh hourly.

## Why this exists

GitHub Actions delivered **zero** `schedule` events for this repository in its
first 12 hours, despite a valid hourly cron on an active workflow on the default
branch, with the repo public, not a fork, Actions enabled and no queued runs.
`workflow_dispatch` worked throughout, so the workflow itself was fine and
GitHub simply was not enqueueing the cron. Cloudflare cron triggers are
dependable, so the schedule lives here instead.

## Deploy

You need a **fine-grained** GitHub personal access token scoped to this
repository only, with:

- Contents: read
- Actions: write

Then:

```
cd worker
wrangler secret put GITHUB_TOKEN     # paste the token when prompted
wrangler deploy
```

The token is a Worker secret. It is never written to `wrangler.toml` or to git.

## Verify

```
wrangler tail                                   # watch cron fires
curl -X POST https://disaster-imagery-refresh.<subdomain>.workers.dev
gh run list --repo cgiovando/disaster-imagery-viewer --limit 3
```

A run with event `repository_dispatch` means it worked.

## Notes

- The `fetch` handler exists so the trigger can be exercised without waiting for
  the cron. It performs the same dispatch as the schedule.
- A successful GitHub dispatch returns 204 with no body; anything else is
  treated as a failure and logged.
- The Actions cron in `.github/workflows/refresh.yml` is deliberately left in
  place. If GitHub starts honouring it the only cost is a duplicate hourly run,
  and the `concurrency` group in that workflow serialises them.
