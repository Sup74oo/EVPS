/**
 * ÉlecRoute – passerelle Enode (Cloudflare Worker, offre gratuite suffisante)
 *
 * Pourquoi un Worker ? Enode impose un "client_secret" qui ne doit jamais être
 * placé dans une web app (il serait lisible par tous). Le Worker le garde côté
 * serveur et ne renvoie à l'app que les données utiles (batterie, autonomie, position).
 *
 * Variables à définir dans Cloudflare (Settings > Variables and Secrets) :
 *   ENODE_CLIENT_ID      (secret)  identifiant client Enode
 *   ENODE_CLIENT_SECRET  (secret)  secret client Enode
 *   ENODE_ENV            (texte)   "sandbox" pour tester, "production" ensuite
 *   APP_KEY              (secret)  mot de passe de votre choix, à recopier dans l'app
 *   ALLOWED_ORIGIN       (texte)   ex. https://votre-pseudo.github.io  (facultatif, "*" sinon)
 *
 * Routes :
 *   POST /link?user=ID       -> crée une session Enode Link, renvoie { linkUrl }
 *   GET  /vehicles?user=ID   -> liste des véhicules liés, données normalisées
 *   POST /refresh?user=ID    -> demande à Enode de rafraîchir les données des véhicules
 *   POST /unlink?user=ID     -> supprime l'utilisateur et ses liaisons chez Enode
 */
let cachedToken = null, tokenExp = 0;

async function getToken(env, oauthUrl) {
  if (cachedToken && Date.now() < tokenExp - 60000) return cachedToken;
  const r = await fetch(oauthUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.ENODE_CLIENT_ID + ':' + env.ENODE_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error('Authentification Enode refusée (' + r.status + ')');
  const j = await r.json();
  cachedToken = j.access_token;
  tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return cachedToken;
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400'
    };
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (!env.APP_KEY || req.headers.get('X-App-Key') !== env.APP_KEY) return json({ error: 'Clé d’application invalide' }, 401);

    const url = new URL(req.url);
    const user = url.searchParams.get('user') || '';
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(user)) return json({ error: 'Identifiant utilisateur invalide' }, 400);

    const envName = env.ENODE_ENV === 'production' ? 'production' : 'sandbox';
    const API = `https://enode-api.${envName}.enode.io`;
    const OAUTH = `https://oauth.${envName}.enode.io/oauth2/token`;

    try {
      const token = await getToken(env, OAUTH);
      const call = (path, opt = {}) => fetch(API + path, {
        ...opt,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opt.headers || {}) }
      });

      if (url.pathname === '/link' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const r = await call(`/users/${user}/link`, {
          method: 'POST',
          body: JSON.stringify({
            vendorType: 'vehicle',
            scopes: ['vehicle:read:data', 'vehicle:read:location'],
            language: 'fr-FR',
            redirectUri: body.redirectUri
          })
        });
        const j = await r.json();
        return json(r.ok ? { linkUrl: j.linkUrl } : { error: j.title || j.detail || 'Erreur Enode' }, r.status);
      }

      if (url.pathname === '/vehicles' && req.method === 'GET') {
        const r = await call(`/users/${user}/vehicles?pageSize=50`);
        if (r.status === 404) return json([]);
        const j = await r.json();
        if (!r.ok) return json({ error: j.title || j.detail || 'Erreur Enode' }, r.status);
        const list = (j.data || j || []).map(v => ({
          id: v.id,
          brand: v.information?.brand || v.vendor,
          model: v.information?.model,
          year: v.information?.year,
          soc: v.chargeState?.batteryLevel ?? null,
          range: v.chargeState?.range ?? null,
          capacity: v.chargeState?.batteryCapacity ?? null,
          plugged: v.chargeState?.isPluggedIn ?? null,
          charging: v.chargeState?.isCharging ?? null,
          lat: v.location?.latitude ?? null,
          lon: v.location?.longitude ?? null,
          odometer: v.odometer?.distance ?? null,
          reachable: v.isReachable ?? null,
          updated: v.chargeState?.lastUpdated || v.lastSeen || null
        }));
        return json(list);
      }

      if (url.pathname === '/refresh' && req.method === 'POST') {
        const r = await call(`/users/${user}/vehicles?pageSize=50`);
        const j = await r.json();
        await Promise.all((j.data || []).map(v => call(`/vehicles/${v.id}/refresh-hint`, { method: 'POST' })));
        return json({ ok: true });
      }

      if (url.pathname === '/unlink' && req.method === 'POST') {
        const r = await call(`/users/${user}`, { method: 'DELETE' });
        return json({ ok: r.ok }, r.ok ? 200 : r.status);
      }

      return json({ error: 'Route inconnue' }, 404);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  }
};
