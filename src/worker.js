/**
 * Spacers Business Club — Worker V4
 * Source de vérité : Supabase (au lieu d'Apps Script)
 *
 * Variables d'environnement requises dans Cloudflare Worker Settings :
 *   - SUPABASE_URL              (variable, ex: https://xxxxx.supabase.co)
 *   - SUPABASE_SERVICE_ROLE_KEY (secret, eyJhbGci...)
 *
 * Routes :
 *   GET /                                  → public/index.html (PWA partenaire)
 *   GET /pilote                            → public/pilote.html (PWA admin)
 *   GET /api/ping                          → health check
 *   GET /api/partner-by-token/:token       → JSON partenaire complet
 *   GET /api/admin/auth/:token             → profil admin seul
 *   GET /api/admin/dashboard/:token        → profil admin + stats globales
 */

const CACHE_TTL = 30; // secondes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS });
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

    return env.ASSETS.fetch(request);
  },
};

// ============================================================================
//  ROUTING API
// ============================================================================

async function handleApi(request, env, path) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({
      error: 'Supabase credentials not configured',
      detail: 'Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Worker Settings',
    }, 500);
  }

  const method = request.method;

  try {
    // ===== POST : mutations admin =====
    if (method === 'POST') {
      let body = null;
      try { body = await request.json(); } catch {}

      let m = path.match(/^\/api\/admin\/prestation-livrer\/([a-zA-Z0-9_-]{16,})\/(PRE-[0-9]+-[0-9]+)$/);
      if (m) return await handlePrestationLivrer(m[1], m[2], body, env);

      m = path.match(/^\/api\/admin\/pack-utiliser\/([a-zA-Z0-9_-]{16,})\/(PAC-[0-9]+-[0-9]+)$/);
      if (m) return await handlePackUtiliser(m[1], m[2], body, env);

      return jsonResponse({ error: 'Unknown POST route', path }, 404);
    }

    // ===== GET =====
    // Health check
    if (path === '/api/ping') {
      return jsonResponse({
        status: 'ok',
        version: 'V4.2 — Supabase + mutations',
        backend: 'supabase',
        timestamp: new Date().toISOString(),
      });
    }

    // Partner by magic token
    let m = path.match(/^\/api\/partner-by-token\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handlePartnerByToken(m[1], env);

    // Admin auth
    m = path.match(/^\/api\/admin\/auth\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminAuth(m[1], env);

    // Admin dashboard
    m = path.match(/^\/api\/admin\/dashboard\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminDashboard(m[1], env);

    // Admin partners list
    m = path.match(/^\/api\/admin\/partners\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminPartners(m[1], env);

    // Admin partner detail
    m = path.match(/^\/api\/admin\/partner\/([a-zA-Z0-9_-]{16,})\/(CON-[0-9]+-[0-9]+)$/);
    if (m) return await handleAdminPartnerDetail(m[1], m[2], env);

    // ===== TICKIE (Vivenu) routes =====
    if (path.match(/^\/api\/admin\/tickie\/ping\/([a-zA-Z0-9_-]{16,})$/)) {
      const tm = path.match(/^\/api\/admin\/tickie\/ping\/([a-zA-Z0-9_-]{16,})$/);
      return await handleTickiePing(tm[1], env);
    }
    if (path.match(/^\/api\/admin\/tickie\/customers\/([a-zA-Z0-9_-]{16,})$/)) {
      const tm = path.match(/^\/api\/admin\/tickie\/customers\/([a-zA-Z0-9_-]{16,})$/);
      return await handleTickieCustomers(tm[1], env);
    }
    if (path.match(/^\/api\/admin\/tickie\/events\/([a-zA-Z0-9_-]{16,})$/)) {
      const tm = path.match(/^\/api\/admin\/tickie\/events\/([a-zA-Z0-9_-]{16,})$/);
      return await handleTickieEvents(tm[1], env);
    }

    return jsonResponse({
      error: 'Not found',
      available_routes: [
        'GET  /api/ping',
        'GET  /api/partner-by-token/:token',
        'GET  /api/admin/auth/:token',
        'GET  /api/admin/dashboard/:token',
        'GET  /api/admin/partners/:token',
        'GET  /api/admin/partner/:token/:contractId',
        'POST /api/admin/prestation-livrer/:token/:prestationId',
        'POST /api/admin/pack-utiliser/:token/:packId',
        'GET  /api/admin/tickie/ping/:token',
        'GET  /api/admin/tickie/customers/:token',
        'GET  /api/admin/tickie/events/:token',
      ],
      path,
    }, 404);
  } catch (err) {
    return jsonResponse({
      error: 'Server error',
      detail: err.message,
      stack: err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : null,
    }, 500);
  }
}

// ============================================================================
//  PARTNER BY TOKEN — utilise Supabase relations imbriquées (1 requête)
// ============================================================================

async function handlePartnerByToken(token, env) {
  // PostgREST permet de demander les FK relations en imbriqué via select=*,foreign(*)
  const query =
    `magic_token=eq.${token}` +
    `&select=*,partenaire:partenaires(*),prestations(*),packs_places(*)` +
    `&limit=1`;

  const rows = await supabaseQuery('contrats', query, env);

  if (!rows || rows.length === 0) {
    return jsonResponse({ error: 'Token invalide ou partenaire introuvable' }, 404);
  }

  const c = rows[0];
  const p = c.partenaire || {};
  const prestations = (c.prestations || []).sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const packsArr = (c.packs_places || []);
  const pack = packsArr.length > 0 ? packsArr[0] : null;

  // Format de sortie identique à l'ancien Apps Script (compat index.html)
  const result = {
    partenaire: {
      raison_sociale: p.raison_sociale || '',
      siren: p.siren || '',
      secteur: p.secteur || '',
      adresse: p.adresse || '',
      representant: p.representant || '',
      fonction: p.representant_fonction || '',
      niveau: p.niveau || '',
    },
    contrat: {
      id: c.id,
      saison: c.saison || '',
      type: c.type || '',
      montant_ht: Number(c.montant_ht || 0),
      tva: Number(c.tva || 0),
      montant_ttc: Number(c.montant_ttc || 0),
      date_debut: c.date_debut || null,
      date_fin: c.date_fin || null,
      statut: c.statut || '',
      codes_prestations: prestations.map(pr => pr.code).filter(Boolean),
      lien_doc: c.lien_doc || '',
    },
    prestations: prestations.map(pr => ({
      id: pr.id,
      code: pr.code || '',
      designation: pr.designation || '',
      detail: pr.detail || '',
      nb_total: Number(pr.nb_total || 0),
      nb_livre: Number(pr.nb_livre || 0),
      nb_restant: Math.max(0, Number(pr.nb_total || 0) - Number(pr.nb_livre || 0)),
      statut: pr.statut || '',
    })),
    pack_places: pack ? {
      id: pack.id,
      libelle: pack.libelle || '',
      alloues: Number(pack.alloues || 0),
      utilises: Number(pack.utilises || 0),
      restants: Number(pack.restants || (pack.alloues - pack.utilises) || 0),
      seuil_alerte: Number(pack.seuil_alerte || 3),
      statut: computePackStatut(pack),
    } : null,
    alertes: [], // À brancher quand on aura migré la table alertes
    meta: {
      generated_at: new Date().toISOString(),
      version: 'V4-supabase',
    },
  };

  return jsonResponse(result);
}

function computePackStatut(p) {
  const a = Number(p.alloues || 0);
  const r = Math.max(0, a - Number(p.utilises || 0));
  const s = Number(p.seuil_alerte || 3);
  if (a === 0) return 'A configurer';
  if (r === 0) return 'Epuise';
  if (r <= s) return 'Faible stock';
  return 'Disponible';
}

// ============================================================================
//  ADMIN AUTH — vérifie token et retourne profil
// ============================================================================

async function handleAdminAuth(token, env) {
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id,prenom,nom,email,role&limit=1`,
    env
  );

  if (!admins || admins.length === 0) {
    return jsonResponse({ error: 'Invalid admin token' }, 401);
  }

  // Update derniere_connexion (fire-and-forget)
  fetch(`${env.SUPABASE_URL}/rest/v1/admins?magic_token=eq.${token}`, {
    method: 'PATCH',
    headers: supabaseHeaders(env),
    body: JSON.stringify({ derniere_connexion: new Date().toISOString() }),
  }).catch(() => {}); // silent fail

  return jsonResponse({
    admin: admins[0],
    meta: { version: 'V4-supabase', generated_at: new Date().toISOString() },
  });
}

// ============================================================================
//  ADMIN DASHBOARD — profil + stats globales
// ============================================================================

async function handleAdminDashboard(token, env) {
  // 1. Auth admin
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id,prenom,nom,email,role&limit=1`,
    env
  );
  if (!admins || admins.length === 0) {
    return jsonResponse({ error: 'Invalid admin token' }, 401);
  }
  const admin = admins[0];

  const saisonActive = '2026-2027'; // TODO: rendre dynamique via une table config

  // 2. Stats en parallèle (Promise.all)
  const [contrats, packs, alertes] = await Promise.all([
    supabaseQuery('contrats',
      `saison=eq.${saisonActive}&statut=eq.${encodeURIComponent('Signé')}&select=id,montant_ht`,
      env),
    supabaseQuery('packs_places',
      `id=like.PAC-${saisonActive.replace('-','').slice(2)}-*&alloues=gt.0&select=id`,
      env),
    supabaseQuery('alertes', `traitee=eq.false&select=id`, env),
  ]);

  const partenaires_actifs = contrats.length;
  const chiffre_signe = contrats.reduce((s, c) => s + Number(c.montant_ht || 0), 0);
  const packs_configures = packs.length;
  const alertes_total = alertes.length;

  return jsonResponseNoCache({
    admin,
    saison: saisonActive,
    stats: {
      partenaires_actifs,
      chiffre_signe,
      packs_configures,
      alertes_total,
    },
    meta: {
      version: 'V4.2-supabase',
      generated_at: new Date().toISOString(),
    },
  });
}

// ============================================================================
//  HELPERS SUPABASE
// ============================================================================

function supabaseHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function supabaseQuery(table, queryString, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${queryString}`;
  const res = await fetch(url, {
    headers: supabaseHeaders(env),
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status} on ${table}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      'X-Backend': 'supabase',
      ...CORS,
    },
  });
}

// ============================================================================
//  ADMIN PARTNERS LIST — V4.1
// ============================================================================

async function handleAdminPartners(token, env) {
  // Auth
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id&limit=1`,
    env
  );
  if (!admins || admins.length === 0) {
    return jsonResponse({ error: 'Invalid admin token' }, 401);
  }

  const saisonActive = '2026-2027';

  // Fetch contrats + relations (partenaire, prestations agrégées, packs agrégés)
  const contrats = await supabaseQuery(
    'contrats',
    `saison=eq.${saisonActive}` +
    `&select=id,saison,type,montant_ht,montant_ttc,statut,magic_token,date_debut,date_fin,` +
    `partenaire:partenaires(id,siren,raison_sociale,representant,representant_fonction,niveau),` +
    `prestations(id,nb_total,nb_livre),` +
    `packs_places(id,alloues,utilises,seuil_alerte)` +
    `&order=id.asc`,
    env
  );

  const partners = contrats.map(c => {
    const p = c.partenaire || {};
    const prestations = c.prestations || [];
    const packsArr = c.packs_places || [];

    const nbPrest = prestations.length;
    const nbPrestLivrees = prestations.filter(pr => Number(pr.nb_livre) >= Number(pr.nb_total) && Number(pr.nb_total) > 0).length;

    const pack = packsArr.length > 0 ? packsArr[0] : null;
    const packAlloues = pack ? Number(pack.alloues || 0) : 0;
    const packUtilises = pack ? Number(pack.utilises || 0) : 0;

    return {
      contrat_id: c.id,
      raison_sociale: p.raison_sociale || '—',
      siren: p.siren || '',
      representant: p.representant || '',
      fonction: p.representant_fonction || '',
      niveau: p.niveau || '',
      type: c.type || '—',
      montant_ht: Number(c.montant_ht || 0),
      montant_ttc: Number(c.montant_ttc || 0),
      statut: c.statut || '—',
      date_debut: c.date_debut || null,
      date_fin: c.date_fin || null,
      nb_prestations: nbPrest,
      nb_prestations_livrees: nbPrestLivrees,
      pack_alloues: packAlloues,
      pack_utilises: packUtilises,
      magic_token: c.magic_token || '',
    };
  });

  return jsonResponseNoCache({
    saison: saisonActive,
    count_total: partners.length,
    partners,
    meta: {
      version: 'V4.2-supabase',
      generated_at: new Date().toISOString(),
    },
  });
}

// ============================================================================
//  ADMIN PARTNER DETAIL — V4.1
// ============================================================================

async function handleAdminPartnerDetail(token, contractId, env) {
  // Auth
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id&limit=1`,
    env
  );
  if (!admins || admins.length === 0) {
    return jsonResponse({ error: 'Invalid admin token' }, 401);
  }

  // Fetch contrat avec toutes les relations
  const rows = await supabaseQuery(
    'contrats',
    `id=eq.${contractId}` +
    `&select=*,partenaire:partenaires(*),prestations(*),packs_places(*)` +
    `&limit=1`,
    env
  );

  if (!rows || rows.length === 0) {
    return jsonResponse({ error: 'Contrat introuvable', contractId }, 404);
  }

  const c = rows[0];
  const p = c.partenaire || {};
  const prestations = (c.prestations || []).sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const packsArr = (c.packs_places || []);
  const pack = packsArr.length > 0 ? packsArr[0] : null;

  return jsonResponseNoCache({
    partenaire: {
      id: p.id || '',
      raison_sociale: p.raison_sociale || '',
      siren: p.siren || '',
      secteur: p.secteur || '',
      adresse: p.adresse || '',
      representant: p.representant || '',
      representant_email: p.representant_email || '',
      fonction: p.representant_fonction || '',
      niveau: p.niveau || '',
    },
    contrat: {
      id: c.id,
      saison: c.saison || '',
      type: c.type || '',
      montant_ht: Number(c.montant_ht || 0),
      tva: Number(c.tva || 0),
      montant_ttc: Number(c.montant_ttc || 0),
      date_debut: c.date_debut || null,
      date_fin: c.date_fin || null,
      statut: c.statut || '',
      lien_doc: c.lien_doc || '',
      magic_token: c.magic_token || '',
    },
    prestations: prestations.map(pr => ({
      id: pr.id,
      code: pr.code || '',
      designation: pr.designation || '',
      detail: pr.detail || '',
      nb_total: Number(pr.nb_total || 0),
      nb_livre: Number(pr.nb_livre || 0),
      nb_restant: Math.max(0, Number(pr.nb_total || 0) - Number(pr.nb_livre || 0)),
      statut: pr.statut || '',
    })),
    pack_places: pack ? {
      id: pack.id,
      libelle: pack.libelle || '',
      alloues: Number(pack.alloues || 0),
      utilises: Number(pack.utilises || 0),
      restants: Number(pack.restants || (pack.alloues - pack.utilises) || 0),
      seuil_alerte: Number(pack.seuil_alerte || 3),
    } : null,
    meta: {
      version: 'V4.2-supabase',
      generated_at: new Date().toISOString(),
    },
  });
}

// ============================================================================
//  MUTATIONS — V4.2
// ============================================================================

async function authAdmin_(token, env) {
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id,prenom,nom,role&limit=1`,
    env
  );
  return (admins && admins.length > 0) ? admins[0] : null;
}

async function supabasePatch_(table, filter, payload, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${filter}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PATCH ${table} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function supabasePost_(table, payload, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 201) {
    const body = await res.text();
    throw new Error(`POST ${table} ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

async function logAudit_(adminId, action, table, recordId, changes, env) {
  // Fire-and-forget : on ne bloque pas si le log échoue
  supabasePost_('audit_log', {
    admin_id: adminId,
    action: action,
    table_name: table,
    record_id: recordId,
    changes: changes,
  }, env).catch(() => {});
}

// ----------- POST /api/admin/prestation-livrer/:token/:prestationId -----------

async function handlePrestationLivrer(token, prestationId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery('prestations', `id=eq.${prestationId}&select=*`, env);
  if (!rows || rows.length === 0) {
    return jsonResponseNoCache({ error: 'Prestation introuvable', id: prestationId }, 404);
  }
  const pre = rows[0];

  const count = Math.max(1, Number((body && body.count) || 1));
  const oldLivre = Number(pre.nb_livre || 0);
  const total = Number(pre.nb_total || 0);
  const newLivre = Math.min(total, oldLivre + count);
  const newStatut = newLivre >= total && total > 0 ? 'Livrée' : (newLivre > 0 ? 'En cours' : 'A livrer');

  await supabasePatch_('prestations', `id=eq.${prestationId}`,
    { nb_livre: newLivre, statut: newStatut }, env);

  logAudit_(admin.id, 'prestation_livrer', 'prestations', prestationId, {
    from: oldLivre, to: newLivre, by: `${admin.prenom} ${admin.nom}`,
  }, env);

  return jsonResponseNoCache({
    success: true,
    prestation: {
      id: prestationId,
      code: pre.code,
      nb_total: total,
      nb_livre: newLivre,
      nb_restant: Math.max(0, total - newLivre),
      statut: newStatut,
    },
  });
}

// ----------- POST /api/admin/pack-utiliser/:token/:packId -----------

async function handlePackUtiliser(token, packId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery('packs_places', `id=eq.${packId}&select=*`, env);
  if (!rows || rows.length === 0) {
    return jsonResponseNoCache({ error: 'Pack introuvable', id: packId }, 404);
  }
  const pack = rows[0];

  const count = Math.max(1, Number((body && body.count) || 1));
  const oldUtilises = Number(pack.utilises || 0);
  const alloues = Number(pack.alloues || 0);
  const newUtilises = Math.min(alloues, oldUtilises + count);

  await supabasePatch_('packs_places', `id=eq.${packId}`,
    { utilises: newUtilises }, env);

  logAudit_(admin.id, 'pack_utiliser', 'packs_places', packId, {
    from: oldUtilises, to: newUtilises, by: `${admin.prenom} ${admin.nom}`,
  }, env);

  return jsonResponseNoCache({
    success: true,
    pack: {
      id: packId,
      alloues: alloues,
      utilises: newUtilises,
      restants: Math.max(0, alloues - newUtilises),
    },
  });
}

// ============================================================================
//  Helper : réponse sans cache (pour mutations + lectures admin sensibles)
// ============================================================================

function jsonResponseNoCache(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Backend': 'supabase',
      ...CORS,
    },
  });
}

// ============================================================================
//  TICKIE (Vivenu) — Sprint Tickie 1 : exploration
// ============================================================================
//
//  Variables d'environnement requises :
//    - TICKIE_API_KEY : Bearer token Tickie (secret Cloudflare)
//    - TICKIE_BASE_URL (optionnel) : "https://vivenu.com/api" par défaut
//
//  Endpoints exposés :
//    - GET /api/admin/tickie/ping/:token       → test connexion + comptes
//    - GET /api/admin/tickie/customers/:token  → liste customers Tickie
//    - GET /api/admin/tickie/events/:token     → liste events (matchs)
//
// ============================================================================

const TICKIE_DEFAULT_BASE = 'https://vivenu.com/api';

async function tickieRequest_(path, env, queryParams) {
  if (!env.TICKIE_API_KEY) {
    throw new Error('TICKIE_API_KEY not configured in Worker Secrets');
  }
  const base = env.TICKIE_BASE_URL || TICKIE_DEFAULT_BASE;
  const qs = queryParams ? '?' + new URLSearchParams(queryParams).toString() : '';
  const url = `${base}${path}${qs}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.TICKIE_API_KEY}`,
      'Accept': 'application/json',
    },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tickie ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ----------- GET /api/admin/tickie/ping/:token -----------
// Teste la connexion Tickie et retourne quelques stats minimales

async function handleTickiePing(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  try {
    // Pull les 3 premiers events et 3 premiers customers pour valider la connexion
    const [eventsRes, customersRes] = await Promise.all([
      tickieRequest_('/events', env, { top: '3' }).catch(e => ({ error: e.message })),
      tickieRequest_('/customers', env, { top: '3' }).catch(e => ({ error: e.message })),
    ]);

    return jsonResponseNoCache({
      status: 'ok',
      tickie_base_url: env.TICKIE_BASE_URL || TICKIE_DEFAULT_BASE,
      sample_events: eventsRes,
      sample_customers: customersRes,
      meta: {
        version: 'V4.3-tickie-explore',
        generated_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    return jsonResponseNoCache({
      status: 'error',
      error: e.message,
      hint: 'Vérifie TICKIE_API_KEY dans Worker Secrets',
    }, 500);
  }
}

// ----------- GET /api/admin/tickie/customers/:token -----------
// Liste tous les customers Tickie pour faire le mapping avec nos partenaires

async function handleTickieCustomers(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  try {
    const raw = await tickieRequest_('/customers', env, { top: '500' });
    // Vivenu retourne { rows: [...], total } OU { docs: [...] } selon endpoint
    const customers = raw.rows || raw.docs || (Array.isArray(raw) ? raw : []);

    // On mappe seulement les champs utiles
    const simplified = customers.map(c => ({
      tickie_id: c._id || c.id,
      email: c.email || '',
      company: c.company || '',
      firstname: c.firstname || '',
      lastname: c.lastname || '',
      created_at: c.createdAt || null,
    }));

    return jsonResponseNoCache({
      total: simplified.length,
      customers: simplified,
      meta: { version: 'V4.3', generated_at: new Date().toISOString() },
    });
  } catch (e) {
    return jsonResponseNoCache({ error: e.message }, 500);
  }
}

// ----------- GET /api/admin/tickie/events/:token -----------
// Liste tous les events Tickie (matchs de la saison)

async function handleTickieEvents(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  try {
    const raw = await tickieRequest_('/events', env, { top: '100' });
    const events = raw.rows || raw.docs || (Array.isArray(raw) ? raw : []);

    const simplified = events.map(e => ({
      tickie_id: e._id || e.id,
      name: e.name || e.title || '',
      start: e.start || e.startDate || null,
      end: e.end || e.endDate || null,
      sellStart: e.sellStart || null,
      sellEnd: e.sellEnd || null,
      location_name: e.locationName || e.location?.name || '',
    }));

    return jsonResponseNoCache({
      total: simplified.length,
      events: simplified,
      meta: { version: 'V4.3', generated_at: new Date().toISOString() },
    });
  } catch (e) {
    return jsonResponseNoCache({ error: e.message }, 500);
  }
}
