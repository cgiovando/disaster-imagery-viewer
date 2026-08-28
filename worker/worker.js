/* Triggers the disaster-imagery-viewer catalogue refresh.
 *
 * Cron fires hourly and POSTs a repository_dispatch to GitHub, which runs the
 * refresh workflow. Also answers GET so the trigger can be exercised by hand
 * without waiting for the cron.
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

  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('method not allowed\n', { status: 405 });
    }
    try {
      const msg = await dispatch(env);
      return new Response(`${msg}\n`, { status: 200 });
    } catch (err) {
      return new Response(`${err.message}\n`, { status: 502 });
    }
  },
};
