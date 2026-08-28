/* Triggers the disaster-imagery-viewer catalogue refresh.
 *
 * Cron fires hourly and POSTs a repository_dispatch to GitHub, which runs the
 * refresh workflow. To refresh by hand, use `gh workflow run refresh.yml`
 * rather than anything here: this Worker deliberately exposes no HTTP trigger,
 * so there is no endpoint anyone could hit to spawn unlimited Actions runs.
 */

async function dispatch(env) {
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;
  if (!repo) throw new Error('GITHUB_REPO is not configured');
  if (!token) throw new Error('GITHUB_TOKEN secret is not set');

  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects API requests without a User-Agent.
      'User-Agent': 'disaster-imagery-refresh-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: env.DISPATCH_EVENT || 'refresh' }),
  });

  // A successful dispatch is 204 No Content.
  if (res.status !== 204) {
    const body = await res.text();
    throw new Error(`GitHub returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return `dispatched ${env.DISPATCH_EVENT || 'refresh'} to ${repo}`;
}

export default {
  async scheduled(event, env, ctx) {
    // Let the runtime wait on this rather than firing and forgetting, so a
    // failure shows up in `wrangler tail` instead of vanishing.
    ctx.waitUntil(
      dispatch(env).then(
        (msg) => console.log(`ok: ${msg}`),
        (err) => {
          console.error(`refresh dispatch failed: ${err.message}`);
          throw err;
        },
      ),
    );
  },

  /* Status only. This triggers nothing, so it needs no guarding, and it answers
   * "did the deploy land and is the token in place" without waiting for :07.
   *
   * `github_token_set` reports whether a secret is configured, never its value.
   * That is operational state rather than repo-public information, and it is
   * kept deliberately: an empty secret uploaded by a silently-failing
   * `wrangler secret put` is exactly the failure this caught once already, and
   * knowing a token exists gains an attacker nothing when no endpoint here can
   * trigger anything.
   */
  async fetch(request, env) {
    /* POST used to perform the dispatch. Anyone following an older runbook must
     * not get a 200 that looks like a refresh happened, so say plainly that the
     * trigger is gone and where it went.
     */
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(
        'This Worker no longer exposes an HTTP trigger.\n' +
          'Refresh with: gh workflow run refresh.yml --repo ' + env.GITHUB_REPO + '\n',
        { status: 410, headers: { 'Content-Type': 'text/plain' } },
      );
    }

    const body = {
      worker: 'disaster-imagery-refresh',
      repo: env.GITHUB_REPO,
      schedule: '7 * * * *',
      github_token_set: Boolean(env.GITHUB_TOKEN),
      trigger: 'cron only; refresh by hand with `gh workflow run refresh.yml`',
    };
    return new Response(JSON.stringify(body, null, 2) + '\n', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
