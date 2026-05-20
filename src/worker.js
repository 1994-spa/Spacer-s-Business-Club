/**
 * Spacers Business Club — Worker proxy + static assets
 * V3.13 — Admin routes + pilote routing
 *
 * Routes :
 *   GET /                                  → public/index.html (PWA partenaire)
 *   GET /pilote                            → public/pilote.html (PWA admin)
 *   GET /api/ping                          → health check
 *   GET /api/partner/:siren                → JSON par SIREN (dev / fallback)
 *   GET /api/partner-by-token/:token       → JSON par magic token (partenaire)
 *   GET /api/admin/auth/:token             → vérifier magic token admin
 *   GET /api/admin/dashboard/:token        → stats globales admin
 *
 * Secret requis : env.API_TOKEN (Cloudflare Worker Settings → Variables)
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbz2axXoeQS1BNac4Wjjp-ZaZ5JSU7heEHAuaKeOK030HiLRWHUktsHgXpW2udbw6Rdr/exec';

const CACHE_TTL_SECONDS = 60;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Routes API
    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
      }
      return await handleApi(request, env, path);
    }

    // Routing /pilote → pilote.html
    if (path === '/pilote' || path === '/pilote/') {
      const rewritten = new Request(
        new URL('/pilote.html', request.url).toString(),
        request
      );
      return env.ASSETS.fetch(rewritten);
    }

    // Static assets (index.html par défaut)
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, path) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let queryString = '';

  // /api/ping
  if (path === '/api/ping') {
    queryString = 'action=ping';
  }
  // /api/partner/:siren — accès direct par SIREN (dev / fallback)
  else if (path.startsWith('/api/partner/') && !path.startsWith('/api/partner-by-token/')) {
    const m = path.match(/^\/api\/partner\/(\d+)$/);
    if (m) {
      if (!env.API_TOKEN) return jsonResponse({ error: 'API_TOKEN not configured' }, 500);
      const siren = m[1];
      queryString = `action=partner&siren=${siren}&token=${env.API_TOKEN}`;
    } else {
      return jsonResponse({ error: 'Invalid SIREN format' }, 400);
    }
  }
  // /api/partner-by-token/:token
  else if (path.startsWith('/api/partner-by-token/')) {
    const m = path.match(/^\/api\/partner-by-token\/([a-zA-Z0-9_-]{16,})$/);
    if (m) {
      if (!env.API_TOKEN) return jsonResponse({ error: 'API_TOKEN not configured' }, 500);
      const magicToken = m[1];
      queryString = `action=partner-by-token&magic_token=${magicToken}&token=${env.API_TOKEN}`;
    } else {
      return jsonResponse({ error: 'Invalid magic token format' }, 400);
    }
  }
  // /api/admin/auth/:token — vérifier token admin
  else if (path.startsWith('/api/admin/auth/')) {
    const m = path.match(/^\/api\/admin\/auth\/([a-zA-Z0-9_-]{16,})$/);
    if (m) {
      if (!env.API_TOKEN) return jsonResponse({ error: 'API_TOKEN not configured' }, 500);
      const adminToken = m[1];
      queryString = `action=admin-auth&magic_token=${adminToken}&token=${env.API_TOKEN}`;
    } else {
      return jsonResponse({ error: 'Invalid admin token format' }, 400);
    }
  }
  // /api/admin/dashboard/:token — stats globales
  else if (path.startsWith('/api/admin/dashboard/')) {
    const m = path.match(/^\/api\/admin\/dashboard\/([a-zA-Z0-9_-]{16,})$/);
    if (m) {
      if (!env.API_TOKEN) return jsonResponse({ error: 'API_TOKEN not configured' }, 500);
      const adminToken = m[1];
      queryString = `action=admin-dashboard&magic_token=${adminToken}&token=${env.API_TOKEN}`;
    } else {
      return jsonResponse({ error: 'Invalid admin token format' }, 400);
    }
  }
  else {
    return jsonResponse({
      error: 'Not found',
      available_routes: [
        '/api/ping',
        '/api/partner/:siren',
        '/api/partner-by-token/:token',
        '/api/admin/auth/:token',
        '/api/admin/dashboard/:token',
      ],
      path: path,
    }, 404);
  }

  try {
    const upstreamUrl = `${APPS_SCRIPT_URL}?${queryString}`;
    const upstream = await fetch(upstreamUrl, {
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    });
    const body = await upstream.text();

    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        'X-Proxy-By': 'spacers-business-club-worker',
        ...CORS_HEADERS,
      },
    });
  } catch (err) {
    return jsonResponse({ error: 'Upstream fetch failed', detail: err.message }, 502);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}
