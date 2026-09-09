// Cloudflare Worker → personal HTTP forward-proxy for the quiz bot.
// What this gives you: MiniPIX sees a Cloudflare datacenter IP (your bot server
// sits in India, so the Worker runs on the nearest colo and usually exits with
// an INDIAN Cloudflare IP) instead of your home IP.
//
// HONEST LIMITS (read before relying on this):
// 1. You do NOT get to pick IPs, and there is NO 1-account = 1-IP guarantee.
//    All your accounts share Cloudflare's edge pool (usually same /24).
// 2. Egress ASN is AS13335 (hosting range) — trivially detectable as datacenter.
// 3. Free plan: 100k requests/day per account — plenty for quiz traffic.
// 4. Gray-area ToS: fine for personal low-volume use; don't resell/abuse it or
//    Cloudflare may limit the worker. For guaranteed unique Indian residential
//    IPs you need paid residential/mobile proxies (set those via /setproxy).
//
// DEPLOY (1 minute, no CLI):
// 1. https://dash.cloudflare.com → Workers & Pages → Create Worker → Deploy.
// 2. Edit code → paste this file → Save and deploy. Note the *.workers.dev URL.
// 3. In Telegram: /setproxy <phone> https://<your-worker>.workers.dev
//    (optional: set SECRET below AND use https://<worker>.workers.dev/?key=SECRET)
// The bot detects *.workers.dev URLs automatically and forwards via ?to=.
const SECRET = ''; // e.g. 'mysecret123' — leave '' for open (URL is unguessable anyway)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (SECRET && url.searchParams.get('key') !== SECRET)
      return new Response('forbidden', { status: 403 });
    // Bot calls:  https://<worker>/?to=<https-url>&key=<secret>
    // Allowed targets: MiniPIX API + IP-echo services (so the bot can SHOW
    // you the exit IP on every rotation). Nothing else is forwarded.
    const to = url.searchParams.get('to');
    if (!to || !/^https?:\/\/(api\.minipix\.com|api\.minipix\.co|api\.ipify\.org|ip-api\.com)/.test(to))
      return new Response('proxy ok — append ?to=<https-url>&key=' + (SECRET ? '<secret>' : '<none>'), { status: 200 });
    const init = { method: req.method, headers: new Headers(req.headers), body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(), redirect: 'manual' };
    init.headers.delete('host');
    const upstream = await fetch(to, init);
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  }
};
