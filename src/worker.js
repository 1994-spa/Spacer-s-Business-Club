/**
 * Spacers Business Club — Worker proxy + static assets
 * V3.10 — Magic token route added
 *
 * Routes :
 *   GET /                              → public/index.html (PWA)
 *   GET /api/ping                      → health check
 *   GET /api/partner/:siren            → JSON par SIREN (dev / fallback)
 *   GET /api/partner-by-token/:token   → JSON par magic token (prod auth)
 *
 * Secret requis : env.API_TOKEN (configuré dans Cloudflare Worker Settings)
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

    // Routes API → logique Worker
    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS_HEADERS });
      }
      return await handleApi(request, env, path);
    }

    // Static assets via le binding ASSETS
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
  else if (path.startsWith('/api/partner/')) {
    const m = path.match(/^\/api\/partner\/(\d+)$/);
    if (m) {
      if (!env.API_TOKEN) {
        return jsonResponse({
          error: 'API_TOKEN not configured',
          detail: 'Add secret API_TOKEN in Cloudflare Worker Settings',
        }, 500);
      }
      const siren = m[1];
      queryString = `action=partner&siren=${siren}&token=${env.API_TOKEN}`;
    } else {
      return jsonResponse({ error: 'Invalid SIREN format' }, 400);
    }
  }
  // /api/partner-by-token/:token — accès par magic token (prod auth)
  else if (path.startsWith('/api/partner-by-token/')) {
    const m = path.match(/^\/api\/partner-by-token\/([a-zA-Z0-9_-]{16,})$/);
    if (m) {
      if (!env.API_TOKEN) {
        return jsonResponse({
          error: 'API_TOKEN not configured',
        }, 500);
      }
      const magicToken = m[1];
      queryString = `action=partner-by-token&magic_token=${magicToken}&token=${env.API_TOKEN}`;
    } else {
      return jsonResponse({ error: 'Invalid magic token format' }, 400);
    }
  }
  else {
    return jsonResponse({
      error: 'Not found',
      available_routes: ['/api/ping', '/api/partner/:siren', '/api/partner-by-token/:token'],
      path: path,
    }, 404);
  }

  try {
    const upstreamUrl = `${APPS_SCRIPT_URL}?${queryString}`;
    const upstream = await fetch(upstreamUrl, {
      cf: {
        cacheTtl: CACHE_TTL_SECONDS,
        cacheEverything: true,
      },
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
    return jsonResponse({
      error: 'Upstream fetch failed',
      detail: err.message,
    }, 502);
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
