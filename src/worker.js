/**
 * Spacers Business Club — Worker V4.7.1
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
 *
 * V4.7.1 — Fix : url is not defined dans handleApi pour routes avec query string
 */

const CACHE_TTL = 30; // secondes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// ============================================================================
//  EMAIL SETTINGS — Sprint C.2 (Resend transactional)
// ============================================================================
const EMAIL_FROM = "Spacer's Business Club <marketing@spacerstoulouse.fr>";
const EMAIL_REPLY_TO_CLUB = 'marketing@spacerstoulouse.fr';
const EMAIL_FALLBACK_PARTNER = 'spacersytb@gmail.com'; // si l'offre n'a pas de contact_email

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS });
      }
      return await handleApi(request, env, path, ctx);
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

async function handleApi(request, env, path, ctx) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({
      error: 'Supabase credentials not configured',
      detail: 'Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Worker Settings',
    }, 500);
  }

  // V4.7.1 FIX : url manquait, ce qui cassait toutes les routes utilisant url.searchParams
  const url = new URL(request.url);

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

      // Tickie partner mapping
      m = path.match(/^\/api\/admin\/partner\/([a-zA-Z0-9_-]{16,})\/(CON-[0-9]+-[0-9]+)\/create-tickie-customer$/);
      if (m) return await handleCreateTickieCustomer(m[1], m[2], body || {}, env);

      m = path.match(/^\/api\/admin\/partner\/([a-zA-Z0-9_-]{16,})\/(CON-[0-9]+-[0-9]+)\/send-tickie-login$/);
      if (m) return await handleSendTickieLogin(m[1], m[2], env);

      m = path.match(/^\/api\/admin\/partner\/([a-zA-Z0-9_-]{16,})\/(CON-[0-9]+-[0-9]+)\/unlink-tickie$/);
      if (m) return await handleUnlinkTickie(m[1], m[2], env);

      // Offres emploi — admin CRUD + modération
      m = path.match(/^\/api\/admin\/offres\/([a-zA-Z0-9_-]{16,})\/create$/);
      if (m) return await handleAdminOffreCreate(m[1], body || {}, env);

      m = path.match(/^\/api\/admin\/offres\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update$/);
      if (m) return await handleAdminOffreUpdate(m[1], m[2], body || {}, env);

      m = path.match(/^\/api\/admin\/offres\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/publish$/);
      if (m) return await handleAdminOffrePublish(m[1], m[2], env);

      m = path.match(/^\/api\/admin\/offres\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/reject$/);
      if (m) return await handleAdminOffreReject(m[1], m[2], body || {}, env);

      m = path.match(/^\/api\/admin\/offres\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/archive$/);
      if (m) return await handleAdminOffreArchive(m[1], m[2], env);

      // Publications (forum / proposition / echange) — admin CRUD + modération
      m = path.match(/^\/api\/admin\/publications\/([a-zA-Z0-9_-]{16,})\/create$/);
      if (m) return await handleAdminPublicationCreate(m[1], body || {}, env);

      m = path.match(/^\/api\/admin\/publications\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update$/);
      if (m) return await handleAdminPublicationUpdate(m[1], m[2], body || {}, env);

      m = path.match(/^\/api\/admin\/publications\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/publish$/);
      if (m) return await handleAdminPublicationPublish(m[1], m[2], env);

      m = path.match(/^\/api\/admin\/publications\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/reject$/);
      if (m) return await handleAdminPublicationReject(m[1], m[2], body || {}, env);

      m = path.match(/^\/api\/admin\/publications\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/archive$/);
      if (m) return await handleAdminPublicationArchive(m[1], m[2], env);

      // Partenaire — Publications & Annonces emploi (proposition)
      m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/publications$/);
      if (m) return await handlePartnerPublicationCreate(m[1], body || {}, env);

      m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/offres-emploi$/);
      if (m) return await handlePartnerOffreCreate(m[1], body || {}, env);

      // Public — soumission de candidature (Sprint C.1)
      m = path.match(/^\/api\/public\/offre\/([0-9a-f-]{36})\/candidature$/);
      if (m) return await handlePublicCandidatureCreate(m[1], body || {}, env, ctx);

      // Sprint C.3 — Update statut candidature (admin)
      m = path.match(/^\/api\/admin\/candidature\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update-statut$/);
      if (m) return await handleAdminCandidatureUpdateStatut(m[1], m[2], body || {}, env);

      return jsonResponse({ error: 'Unknown POST route', path }, 404);
    }

    // ===== GET =====
    // Health check
    if (path === '/api/ping') {
      return jsonResponse({
        status: 'ok',
        version: 'V4.7.1 — Supabase + mutations + url fix',
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

    // Admin offres — liste (filtre par statut via ?statut=)
    m = path.match(/^\/api\/admin\/offres\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminOffresList(m[1], url.searchParams, env);

    // Admin offre — détail
    m = path.match(/^\/api\/admin\/offre\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})$/);
    if (m) return await handleAdminOffreDetail(m[1], m[2], env);

    // Admin publications — liste (filtre par type + statut via query)
    m = path.match(/^\/api\/admin\/publications\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminPublicationsList(m[1], url.searchParams, env);

    // Admin publication — détail
    m = path.match(/^\/api\/admin\/publication\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})$/);
    if (m) return await handleAdminPublicationDetail(m[1], m[2], env);

    // Partner — ses publications & annonces emploi
    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/publications$/);
    if (m) return await handlePartnerPublicationsList(m[1], url.searchParams, env);

    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/offres-emploi$/);
    if (m) return await handlePartnerOffresList(m[1], env);

    // Public — liste des annonces publiées (Sprint C.1, sans auth, pour app bénévole + page publique)
    m = path.match(/^\/api\/public\/offres-emploi$/);
    if (m) return await handlePublicOffresList(url.searchParams, env);

    // Public — détail offre + incrément vues_count
    m = path.match(/^\/api\/public\/offre\/([0-9a-f-]{36})$/);
    if (m) return await handlePublicOffreDetail(m[1], env);

    // ===== Sprint C.3 — Candidatures admin =====
    m = path.match(/^\/api\/admin\/candidatures\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminCandidaturesList(m[1], url.searchParams, env);

    m = path.match(/^\/api\/admin\/candidature\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})$/);
    if (m) return await handleAdminCandidatureDetail(m[1], m[2], env);

    // ===== Assets statiques (PDF Minute de l'emploi en fallback) =====
    if (path === '/assets/minute-emploi-template.pdf' || path === '/minute_de_l_emploi_template.pdf') {
      const binary = Uint8Array.from(atob(MINUTE_EMPLOI_TEMPLATE_B64), c => c.charCodeAt(0));
      return new Response(binary, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline; filename="minute_de_l_emploi_template.pdf"',
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

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
        'POST /api/admin/partner/:token/:contractId/create-tickie-customer',
        'POST /api/admin/partner/:token/:contractId/send-tickie-login',
        'POST /api/admin/partner/:token/:contractId/unlink-tickie',
        'GET  /api/admin/offres/:token',
        'GET  /api/admin/offre/:token/:offreId',
        'POST /api/admin/offres/:token/create',
        'POST /api/admin/offres/:token/:offreId/update',
        'POST /api/admin/offres/:token/:offreId/publish',
        'POST /api/admin/offres/:token/:offreId/reject',
        'POST /api/admin/offres/:token/:offreId/archive',
        'GET  /api/admin/candidatures/:token?statut=X&offre_id=Y',
        'GET  /api/admin/candidature/:token/:candidatureId',
        'POST /api/admin/candidature/:token/:candidatureId/update-statut',
        'GET  /api/public/offres-emploi',
        'GET  /api/public/offre/:offreId',
        'POST /api/public/offre/:offreId/candidature',
        'GET  /api/admin/publications/:token?type=X&statut=Y',
        'GET  /api/admin/publication/:token/:id',
        'POST /api/admin/publications/:token/create',
        'POST /api/admin/publications/:token/:id/update',
        'POST /api/admin/publications/:token/:id/publish',
        'POST /api/admin/publications/:token/:id/reject',
        'POST /api/admin/publications/:token/:id/archive',
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
      tickie_customer_id: p.tickie_customer_id || null,
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
      tickieRequest_('/customers/rich', env, { top: '3' }).catch(e => ({ error: e.message })),
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
    const raw = await tickieRequest_('/customers/rich', env, { top: '500' });
    // Vivenu retourne { rows: [...], total } OU { docs: [...] } selon endpoint
    const customers = raw.rows || raw.docs || (Array.isArray(raw) ? raw : []);

    // On mappe seulement les champs utiles
    const simplified = customers.map(c => ({
      tickie_id: c._id || c.id,
      email: c.primaryEmail || c.email || '',
      company: c.company || '',
      firstname: c.prename || c.firstname || '',
      lastname: c.lastname || '',
      name: c.name || '',
      phone: c.phone || '',
      external_id: c.externalId || '',
      tags: c.tags || [],
      verified: c.verified || false,
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

// ============================================================================
//  TICKIE — Sprint 2 : Mapping partenaires
// ============================================================================

// ----------- POST /api/admin/partner/:token/:contractId/create-tickie-customer -----------
// Body attendu : { email, prenom, nom, telephone? }
// Crée un customer Tickie pour ce partenaire et stocke le _id dans Supabase

async function handleCreateTickieCustomer(token, contractId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  // Récup contrat + partenaire (via PostgREST embedding)
  const contrats = await supabaseQuery(
    'contrats',
    `id=eq.${contractId}&select=id,saison,partenaire_id,partenaires(id,raison_sociale,niveau,tickie_customer_id)&limit=1`,
    env
  );
  if (!contrats || contrats.length === 0) {
    return jsonResponseNoCache({ error: 'Contrat introuvable' }, 404);
  }
  const contrat = contrats[0];
  const partenaire = contrat.partenaires;
  if (!partenaire) return jsonResponseNoCache({ error: 'Partenaire introuvable' }, 404);

  if (partenaire.tickie_customer_id) {
    return jsonResponseNoCache({
      error: 'Customer Tickie déjà lié à ce partenaire',
      tickie_customer_id: partenaire.tickie_customer_id,
      hint: 'Utilise "Délier" si tu veux re-créer',
    }, 400);
  }

  // Validation body
  const email = String(body.email || '').trim().toLowerCase();
  const prenom = String(body.prenom || '').trim();
  const nom = String(body.nom || '').trim();
  const telephone = String(body.telephone || '').trim();

  if (!email || !email.includes('@') || email.length < 5) {
    return jsonResponseNoCache({ error: 'Email invalide', got: email }, 400);
  }

  // Création customer Tickie — on ne met QUE les champs non-vides
  const tickiePayload = {
    primaryEmail: email,
    company: partenaire.raison_sociale,
    tags: ['PARTENAIRE_BC', `SAISON_${contrat.saison}`],
    externalId: contrat.id,
    verified: true,
  };
  if (prenom) tickiePayload.prename = prenom;
  if (nom) tickiePayload.lastname = nom;
  if (telephone) tickiePayload.phone = telephone;

  // meta : uniquement les clés qui ont une valeur
  const meta = {
    supabase_partenaire_id: partenaire.id,
    saison: contrat.saison,
  };
  if (partenaire.niveau) meta.niveau = partenaire.niveau;
  tickiePayload.meta = meta;

  let tickieCustomer;
  try {
    const base = env.TICKIE_BASE_URL || TICKIE_DEFAULT_BASE;
    const res = await fetch(`${base}/customers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.TICKIE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(tickiePayload),
    });
    const text = await res.text();
    if (!res.ok) {
      return jsonResponseNoCache({
        error: 'Tickie API error',
        status: res.status,
        detail: text.slice(0, 500),
        payload_sent: tickiePayload,
      }, 502);
    }
    tickieCustomer = text ? JSON.parse(text) : null;
  } catch (e) {
    return jsonResponseNoCache({ error: 'Tickie network error', detail: e.message }, 502);
  }

  const tickieId = tickieCustomer && (tickieCustomer._id || tickieCustomer.id);
  if (!tickieId) {
    return jsonResponseNoCache({
      error: 'Tickie did not return an _id',
      raw: tickieCustomer,
    }, 502);
  }

  // Update Supabase
  try {
    await supabasePatch_('partenaires', `id=eq.${partenaire.id}`, {
      tickie_customer_id: tickieId,
    }, env);
  } catch (e) {
    return jsonResponseNoCache({
      error: 'Customer Tickie créé MAIS écriture Supabase échouée',
      tickie_customer_id: tickieId,
      detail: e.message,
    }, 500);
  }

  // Audit
  await logAudit_(admin.id, 'partenaire.create_tickie_customer', 'partenaires', partenaire.id, {
    tickie_customer_id: tickieId,
    email,
    company: partenaire.raison_sociale,
  }, env).catch(() => {});

  return jsonResponseNoCache({
    ok: true,
    tickie_customer_id: tickieId,
    email,
    company: partenaire.raison_sociale,
    next_step: 'Tu peux maintenant envoyer le login au partenaire',
  });
}

// ----------- POST /api/admin/partner/:token/:contractId/send-tickie-login -----------
// Active le compte Tickie (envoie email de connexion au partenaire)

async function handleSendTickieLogin(token, contractId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const contrats = await supabaseQuery(
    'contrats',
    `id=eq.${contractId}&select=partenaire_id,partenaires(id,raison_sociale,tickie_customer_id)&limit=1`,
    env
  );
  if (!contrats || contrats.length === 0) {
    return jsonResponseNoCache({ error: 'Contrat introuvable' }, 404);
  }
  const partenaire = contrats[0].partenaires;
  if (!partenaire || !partenaire.tickie_customer_id) {
    return jsonResponseNoCache({
      error: 'Pas de customer Tickie lié à ce partenaire',
      hint: 'Crée-le d\'abord avec "Créer compte Tickie"',
    }, 400);
  }

  try {
    const base = env.TICKIE_BASE_URL || TICKIE_DEFAULT_BASE;
    const res = await fetch(`${base}/customers/${partenaire.tickie_customer_id}/account`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.TICKIE_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ suppressEmail: false }),
    });
    const text = await res.text();
    if (!res.ok) {
      return jsonResponseNoCache({
        error: 'Tickie API error',
        status: res.status,
        detail: text.slice(0, 500),
      }, 502);
    }
  } catch (e) {
    return jsonResponseNoCache({ error: 'Tickie network error', detail: e.message }, 502);
  }

  await logAudit_(admin.id, 'partenaire.send_tickie_login', 'partenaires', partenaire.id, {
    tickie_customer_id: partenaire.tickie_customer_id,
  }, env).catch(() => {});

  return jsonResponseNoCache({
    ok: true,
    message: 'Email de connexion envoyé au partenaire',
    tickie_customer_id: partenaire.tickie_customer_id,
  });
}

// ----------- POST /api/admin/partner/:token/:contractId/unlink-tickie -----------
// Délie le partenaire de son customer Tickie (ne supprime PAS le customer Tickie)

async function handleUnlinkTickie(token, contractId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const contrats = await supabaseQuery(
    'contrats',
    `id=eq.${contractId}&select=partenaire_id,partenaires(id,tickie_customer_id)&limit=1`,
    env
  );
  if (!contrats || contrats.length === 0) {
    return jsonResponseNoCache({ error: 'Contrat introuvable' }, 404);
  }
  const partenaire = contrats[0].partenaires;
  if (!partenaire) return jsonResponseNoCache({ error: 'Partenaire introuvable' }, 404);
  const oldId = partenaire.tickie_customer_id;
  if (!oldId) {
    return jsonResponseNoCache({ error: 'Pas de customer Tickie à délier' }, 400);
  }

  await supabasePatch_('partenaires', `id=eq.${partenaire.id}`, {
    tickie_customer_id: null,
  }, env);

  await logAudit_(admin.id, 'partenaire.unlink_tickie', 'partenaires', partenaire.id, {
    tickie_customer_id: { from: oldId, to: null },
  }, env).catch(() => {});

  return jsonResponseNoCache({
    ok: true,
    unlinked: oldId,
    note: 'Le customer Tickie n\'a PAS été supprimé côté Tickie. Le mapping est juste retiré.',
  });
}

// ============================================================================
//  OFFRES D'EMPLOI — Sprint Annonces Phase A : Admin CRUD + modération
// ============================================================================

const OFFRE_STATUTS = ['en_attente', 'publie', 'refuse', 'expire', 'pourvue', 'archive'];

// ----------- GET /api/admin/offres/:token?statut=... -----------
async function handleAdminOffresList(token, queryParams, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const statutFilter = queryParams.get('statut'); // optionnel
  let filter = 'select=*,contrats(id,partenaires(raison_sociale))&order=created_at.desc&limit=200';
  if (statutFilter && OFFRE_STATUTS.includes(statutFilter)) {
    filter = `statut=eq.${statutFilter}&` + filter;
  }
  const rows = await supabaseQuery('offres_emploi', filter, env);

  const offres = (rows || []).map(o => ({
    id: o.id,
    contrat_id: o.contrat_id,
    partenaire: o.contrats?.partenaires?.raison_sociale || '—',
    titre: o.titre,
    type_contrat: o.type_contrat || '',
    lieu: o.lieu || '',
    salaire_indicatif: o.salaire_indicatif || '',
    statut: o.statut,
    date_publication: o.date_publication,
    date_expiration: o.date_expiration,
    vues_count: o.vues_count || 0,
    candidatures_count: o.candidatures_count || 0,
    created_at: o.created_at,
    created_by: o.created_by || '',
  }));

  // Stats par statut (pour les onglets/badges)
  const stats = { en_attente: 0, publie: 0, refuse: 0, archive: 0, expire: 0, pourvue: 0, total: 0 };
  // Si filtre actif, on doit aussi récupérer le count global. Pour simplifier, on fait un 2e query sans filtre.
  if (statutFilter) {
    const allRows = await supabaseQuery('offres_emploi', 'select=statut', env);
    (allRows || []).forEach(r => {
      stats[r.statut] = (stats[r.statut] || 0) + 1;
      stats.total++;
    });
  } else {
    offres.forEach(o => {
      stats[o.statut] = (stats[o.statut] || 0) + 1;
      stats.total++;
    });
  }

  return jsonResponseNoCache({
    offres,
    stats,
    filter: statutFilter || 'all',
    meta: { version: 'V4.5', generated_at: new Date().toISOString() },
  });
}

// ----------- GET /api/admin/offre/:token/:offreId -----------
async function handleAdminOffreDetail(token, offreId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery(
    'offres_emploi',
    `id=eq.${offreId}&select=*,contrats(id,partenaires(raison_sociale,siren))&limit=1`,
    env
  );
  if (!rows || rows.length === 0) {
    return jsonResponseNoCache({ error: 'Offre introuvable' }, 404);
  }
  const o = rows[0];
  return jsonResponseNoCache({
    offre: {
      id: o.id,
      contrat_id: o.contrat_id,
      partenaire: o.contrats?.partenaires?.raison_sociale || '—',
      titre: o.titre,
      description: o.description || '',
      type_contrat: o.type_contrat || '',
      lieu: o.lieu || '',
      salaire_indicatif: o.salaire_indicatif || '',
      duree: o.duree || '',
      experience_requise: o.experience_requise || '',
      url_externe: o.url_externe || '',
      contact_nom: o.contact_nom || '',
      contact_email: o.contact_email || '',
      contact_telephone: o.contact_telephone || '',
      statut: o.statut,
      raison_refus: o.raison_refus || '',
      date_publication: o.date_publication,
      date_expiration: o.date_expiration,
      vues_count: o.vues_count || 0,
      candidatures_count: o.candidatures_count || 0,
      created_by: o.created_by || '',
      created_at: o.created_at,
      updated_at: o.updated_at,
      // V4.7.1 : on expose aussi metadata pour que le pilote puisse afficher logo_b64, date_match, les_plus
      metadata: o.metadata || {},
    },
  });
}

// ----------- POST /api/admin/offres/:token/create -----------
// Body : { contrat_id, titre, description, type_contrat, lieu, ... }
async function handleAdminOffreCreate(token, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const contrat_id = String(body.contrat_id || '').trim();
  const titre = String(body.titre || '').trim();
  if (!contrat_id || !contrat_id.match(/^CON-\d+-\d+$/)) {
    return jsonResponseNoCache({ error: 'contrat_id invalide' }, 400);
  }
  if (!titre) {
    return jsonResponseNoCache({ error: 'Titre obligatoire' }, 400);
  }

  // Default expiration : 60 jours
  const expirationDays = Math.max(1, Math.min(365, Number(body.expiration_days) || 60));
  const dateExpiration = new Date(Date.now() + expirationDays * 86400 * 1000).toISOString();

  const insertData = {
    contrat_id,
    titre,
    description: body.description || null,
    type_contrat: body.type_contrat || null,
    lieu: body.lieu || null,
    salaire_indicatif: body.salaire_indicatif || null,
    duree: body.duree || null,
    experience_requise: body.experience_requise || null,
    url_externe: body.url_externe || null,
    contact_nom: body.contact_nom || null,
    contact_email: body.contact_email || null,
    contact_telephone: body.contact_telephone || null,
    statut: body.publish_now ? 'publie' : 'en_attente',
    date_publication: body.publish_now ? new Date().toISOString() : null,
    date_expiration: dateExpiration,
    created_by: 'admin',
    created_by_admin_id: admin.id,
  };

  let created;
  try {
    const arr = await supabaseInsert_('offres_emploi', insertData, env);
    created = Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500);
  }

  await logAudit_(admin.id, 'offre.create', 'offres_emploi', created.id, {
    titre, contrat_id, statut: insertData.statut,
  }, env).catch(() => {});

  return jsonResponseNoCache({ ok: true, offre: created });
}

// ----------- POST /api/admin/offres/:token/:offreId/update -----------
async function handleAdminOffreUpdate(token, offreId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const allowedFields = [
    'titre', 'description', 'type_contrat', 'lieu', 'salaire_indicatif',
    'duree', 'experience_requise', 'url_externe',
    'contact_nom', 'contact_email', 'contact_telephone',
    'date_expiration',
  ];
  const updateData = {};
  for (const k of allowedFields) {
    if (body[k] !== undefined) updateData[k] = body[k] || null;
  }
  if (Object.keys(updateData).length === 0) {
    return jsonResponseNoCache({ error: 'Aucune mise à jour à appliquer' }, 400);
  }

  try {
    await supabasePatch_('offres_emploi', `id=eq.${offreId}`, updateData, env);
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur update', detail: e.message }, 500);
  }

  await logAudit_(admin.id, 'offre.update', 'offres_emploi', offreId, updateData, env).catch(() => {});

  return jsonResponseNoCache({ ok: true });
}

// ----------- POST /api/admin/offres/:token/:offreId/publish -----------
async function handleAdminOffrePublish(token, offreId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  await supabasePatch_('offres_emploi', `id=eq.${offreId}`, {
    statut: 'publie',
    date_publication: new Date().toISOString(),
    raison_refus: null,
  }, env);

  await logAudit_(admin.id, 'offre.publish', 'offres_emploi', offreId, {}, env).catch(() => {});

  return jsonResponseNoCache({ ok: true, statut: 'publie' });
}

// ----------- POST /api/admin/offres/:token/:offreId/reject -----------
// Body : { raison }
async function handleAdminOffreReject(token, offreId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const raison = String(body.raison || '').trim() || 'Refus admin';

  await supabasePatch_('offres_emploi', `id=eq.${offreId}`, {
    statut: 'refuse',
    raison_refus: raison,
    date_publication: null,
  }, env);

  await logAudit_(admin.id, 'offre.reject', 'offres_emploi', offreId, { raison }, env).catch(() => {});

  return jsonResponseNoCache({ ok: true, statut: 'refuse', raison });
}

// ----------- POST /api/admin/offres/:token/:offreId/archive -----------
async function handleAdminOffreArchive(token, offreId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  await supabasePatch_('offres_emploi', `id=eq.${offreId}`, {
    statut: 'archive',
  }, env);

  await logAudit_(admin.id, 'offre.archive', 'offres_emploi', offreId, {}, env).catch(() => {});

  return jsonResponseNoCache({ ok: true, statut: 'archive' });
}

// Helper supabaseInsert_ (si pas déjà défini ailleurs)
async function supabaseInsert_(table, data, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase credentials not configured');
  }
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ============================================================================
//  PUBLICATIONS (forum / proposition / echange) — Sprint Publications Phase A
// ============================================================================

const PUB_TYPES = ['forum', 'proposition', 'echange'];
const PUB_STATUTS = ['en_attente', 'publie', 'refuse', 'expire', 'archive'];

// ----------- GET /api/admin/publications/:token?type=X&statut=Y -----------
async function handleAdminPublicationsList(token, queryParams, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const typeFilter = queryParams.get('type');
  const statutFilter = queryParams.get('statut');

  let filters = [];
  if (typeFilter && PUB_TYPES.includes(typeFilter)) filters.push(`type=eq.${typeFilter}`);
  if (statutFilter && PUB_STATUTS.includes(statutFilter)) filters.push(`statut=eq.${statutFilter}`);
  const baseQuery = filters.join('&') + (filters.length ? '&' : '') +
    'select=*,partenaires(raison_sociale)&order=created_at.desc&limit=200';

  const rows = await supabaseQuery('publications', baseQuery, env);

  const publications = (rows || []).map(p => ({
    id: p.id,
    type: p.type,
    contrat_id: p.contrat_id,
    partenaire_id: p.partenaire_id,
    partenaire: p.partenaires?.raison_sociale || '—',
    titre: p.titre,
    description: p.description || '',
    categorie: p.categorie || '',
    tags: p.tags || [],
    data: p.data || {},
    statut: p.statut,
    raison_refus: p.raison_refus || '',
    date_publication: p.date_publication,
    date_expiration: p.date_expiration,
    vues_count: p.vues_count || 0,
    reponses_count: p.reponses_count || 0,
    contact_email: p.contact_email || '',
    contact_nom: p.contact_nom || '',
    created_by: p.created_by || '',
    created_at: p.created_at,
  }));

  // Stats globales par type/statut (utile pour les badges sidebar)
  const allRows = await supabaseQuery('publications', 'select=type,statut', env);
  const stats = {};
  PUB_TYPES.forEach(t => {
    stats[t] = { en_attente: 0, publie: 0, refuse: 0, archive: 0, expire: 0, total: 0 };
  });
  (allRows || []).forEach(r => {
    if (!stats[r.type]) return;
    stats[r.type][r.statut] = (stats[r.type][r.statut] || 0) + 1;
    stats[r.type].total++;
  });

  return jsonResponseNoCache({
    publications,
    stats,
    filter: { type: typeFilter || 'all', statut: statutFilter || 'all' },
    meta: { version: 'V4.6', generated_at: new Date().toISOString() },
  });
}

// ----------- GET /api/admin/publication/:token/:id -----------
async function handleAdminPublicationDetail(token, pubId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery(
    'publications',
    `id=eq.${pubId}&select=*,partenaires(id,raison_sociale,siren)&limit=1`,
    env
  );
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Publication introuvable' }, 404);

  const p = rows[0];
  return jsonResponseNoCache({
    publication: {
      id: p.id,
      type: p.type,
      contrat_id: p.contrat_id,
      partenaire_id: p.partenaire_id,
      partenaire: p.partenaires?.raison_sociale || '—',
      titre: p.titre,
      description: p.description || '',
      categorie: p.categorie || '',
      tags: p.tags || [],
      data: p.data || {},
      contact_nom: p.contact_nom || '',
      contact_email: p.contact_email || '',
      contact_telephone: p.contact_telephone || '',
      statut: p.statut,
      raison_refus: p.raison_refus || '',
      date_publication: p.date_publication,
      date_expiration: p.date_expiration,
      vues_count: p.vues_count || 0,
      reponses_count: p.reponses_count || 0,
      created_by: p.created_by || '',
      created_at: p.created_at,
      updated_at: p.updated_at,
    },
  });
}

// ----------- POST /api/admin/publications/:token/create -----------
async function handleAdminPublicationCreate(token, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const type = String(body.type || '').trim();
  if (!PUB_TYPES.includes(type)) {
    return jsonResponseNoCache({ error: 'type invalide', expected: PUB_TYPES }, 400);
  }
  const titre = String(body.titre || '').trim();
  if (!titre) return jsonResponseNoCache({ error: 'Titre obligatoire' }, 400);

  const contrat_id = String(body.contrat_id || '').trim();
  let partenaire_id = null;
  if (contrat_id) {
    if (!contrat_id.match(/^CON-\d+-\d+$/)) {
      return jsonResponseNoCache({ error: 'contrat_id invalide' }, 400);
    }
    // Récupérer partenaire_id du contrat
    const contrats = await supabaseQuery('contrats', `id=eq.${contrat_id}&select=partenaire_id&limit=1`, env);
    if (contrats && contrats[0]) partenaire_id = contrats[0].partenaire_id;
  }

  // Default expiration : 90 jours pour forum/echange, 180j pour proposition
  const defaultDays = type === 'proposition' ? 180 : 90;
  const expirationDays = Math.max(1, Math.min(365, Number(body.expiration_days) || defaultDays));
  const dateExpiration = new Date(Date.now() + expirationDays * 86400 * 1000).toISOString();

  const insertData = {
    type,
    contrat_id: contrat_id || null,
    partenaire_id,
    titre,
    description: body.description || null,
    categorie: body.categorie || null,
    tags: body.tags && Array.isArray(body.tags) ? body.tags : null,
    data: body.data || {},
    contact_nom: body.contact_nom || null,
    contact_email: body.contact_email || null,
    contact_telephone: body.contact_telephone || null,
    statut: body.publish_now ? 'publie' : 'en_attente',
    date_publication: body.publish_now ? new Date().toISOString() : null,
    date_expiration: dateExpiration,
    created_by: 'admin',
    created_by_admin_id: admin.id,
  };

  let created;
  try {
    const arr = await supabaseInsert_('publications', insertData, env);
    created = Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500);
  }

  await logAudit_(admin.id, 'publication.create', 'publications', created.id, {
    type, titre, contrat_id, statut: insertData.statut,
  }, env).catch(() => {});

  return jsonResponseNoCache({ ok: true, publication: created });
}

// ----------- POST /api/admin/publications/:token/:id/update -----------
async function handleAdminPublicationUpdate(token, pubId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const allowedFields = [
    'titre', 'description', 'categorie', 'tags', 'data',
    'contact_nom', 'contact_email', 'contact_telephone',
    'date_expiration',
  ];
  const updateData = {};
  for (const k of allowedFields) {
    if (body[k] !== undefined) updateData[k] = body[k] || null;
  }
  if (Object.keys(updateData).length === 0) {
    return jsonResponseNoCache({ error: 'Aucune mise à jour à appliquer' }, 400);
  }

  try {
    await supabasePatch_('publications', `id=eq.${pubId}`, updateData, env);
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur update', detail: e.message }, 500);
  }

  await logAudit_(admin.id, 'publication.update', 'publications', pubId, updateData, env).catch(() => {});

  return jsonResponseNoCache({ ok: true });
}

// ----------- POST /api/admin/publications/:token/:id/publish -----------
async function handleAdminPublicationPublish(token, pubId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  await supabasePatch_('publications', `id=eq.${pubId}`, {
    statut: 'publie',
    date_publication: new Date().toISOString(),
    raison_refus: null,
  }, env);

  await logAudit_(admin.id, 'publication.publish', 'publications', pubId, {}, env).catch(() => {});

  return jsonResponseNoCache({ ok: true, statut: 'publie' });
}

// ----------- POST /api/admin/publications/:token/:id/reject -----------
async function handleAdminPublicationReject(token, pubId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const raison = String(body.raison || '').trim() || 'Refus admin';

  await supabasePatch_('publications', `id=eq.${pubId}`, {
    statut: 'refuse',
    raison_refus: raison,
    date_publication: null,
  }, env);

  await logAudit_(admin.id, 'publication.reject', 'publications', pubId, { raison }, env).catch(() => {});

  return jsonResponseNoCache({ ok: true, statut: 'refuse', raison });
}

// ----------- POST /api/admin/publications/:token/:id/archive -----------
async function handleAdminPublicationArchive(token, pubId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  await supabasePatch_('publications', `id=eq.${pubId}`, { statut: 'archive' }, env);
  await logAudit_(admin.id, 'publication.archive', 'publications', pubId, {}, env).catch(() => {});

  return jsonResponseNoCache({ ok: true, statut: 'archive' });
}

// ============================================================================
//  PARTNER — Phase B : Proposer publications et annonces emploi
// ============================================================================

// Auth helper : identifie le partenaire via le magic_token du contrat
async function authPartner_(token, env) {
  const rows = await supabaseQuery(
    'contrats',
    `magic_token=eq.${token}&select=id,partenaire_id,saison,partenaires(id,raison_sociale,representant)&limit=1`,
    env
  );
  if (!rows || rows.length === 0) return null;
  return {
    contrat_id: rows[0].id,
    partenaire_id: rows[0].partenaire_id,
    saison: rows[0].saison,
    raison_sociale: rows[0].partenaires?.raison_sociale || '',
    representant: rows[0].partenaires?.representant || '',
  };
}

// ----------- GET /api/partner/:token/publications?type=X -----------
async function handlePartnerPublicationsList(token, queryParams, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const typeFilter = queryParams.get('type');
  let filters = [`contrat_id=eq.${partner.contrat_id}`];
  if (typeFilter && PUB_TYPES.includes(typeFilter)) filters.push(`type=eq.${typeFilter}`);
  filters.push('select=id,type,titre,description,categorie,data,statut,raison_refus,date_publication,date_expiration,vues_count,reponses_count,created_at');
  filters.push('order=created_at.desc');
  filters.push('limit=100');

  const rows = await supabaseQuery('publications', filters.join('&'), env);

  return jsonResponseNoCache({
    contrat_id: partner.contrat_id,
    publications: rows || [],
    meta: { version: 'V4.7-partner', generated_at: new Date().toISOString() },
  });
}

// ----------- POST /api/partner/:token/publications -----------
// Body : { type, titre, description, categorie, data, contact_nom, contact_email, contact_telephone }
async function handlePartnerPublicationCreate(token, body, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const type = String(body.type || '').trim();
  if (!PUB_TYPES.includes(type)) {
    return jsonResponseNoCache({ error: 'type invalide', expected: PUB_TYPES }, 400);
  }
  const titre = String(body.titre || '').trim();
  if (!titre) return jsonResponseNoCache({ error: 'Titre obligatoire' }, 400);

  const defaultDays = type === 'proposition' ? 180 : 90;
  const dateExpiration = new Date(Date.now() + defaultDays * 86400 * 1000).toISOString();

  const insertData = {
    type,
    contrat_id: partner.contrat_id,
    partenaire_id: partner.partenaire_id,
    titre,
    description: body.description || null,
    categorie: body.categorie || null,
    data: body.data || {},
    contact_nom: body.contact_nom || partner.representant || null,
    contact_email: body.contact_email || null,
    contact_telephone: body.contact_telephone || null,
    statut: 'en_attente',                    // toujours en attente quand créé par partenaire
    date_expiration: dateExpiration,
    created_by: 'partenaire',
  };

  let created;
  try {
    const arr = await supabaseInsert_('publications', insertData, env);
    created = Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500);
  }

  return jsonResponseNoCache({
    ok: true,
    publication: created,
    message: 'Publication créée. Elle est en cours de validation par l\'équipe Spacers.',
  });
}

// ----------- GET /api/partner/:token/offres-emploi -----------
async function handlePartnerOffresList(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const filter = `contrat_id=eq.${partner.contrat_id}&select=*&order=created_at.desc&limit=100`;
  const rows = await supabaseQuery('offres_emploi', filter, env);

  return jsonResponseNoCache({
    contrat_id: partner.contrat_id,
    offres: rows || [],
    meta: { version: 'V4.7-partner', generated_at: new Date().toISOString() },
  });
}

// ----------- POST /api/partner/:token/offres-emploi -----------
async function handlePartnerOffreCreate(token, body, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const titre = String(body.titre || '').trim();
  if (!titre) return jsonResponseNoCache({ error: 'Titre obligatoire' }, 400);

  const contact_email = String(body.contact_email || '').trim();
  if (!contact_email || !contact_email.includes('@')) {
    return jsonResponseNoCache({ error: 'Email contact obligatoire' }, 400);
  }

  const expirationDays = 60;
  const dateExpiration = new Date(Date.now() + expirationDays * 86400 * 1000).toISOString();

  const insertData = {
    contrat_id: partner.contrat_id,
    titre,
    description: body.description || null,
    type_contrat: body.type_contrat || null,
    lieu: body.lieu || null,
    salaire_indicatif: body.salaire_indicatif || null,
    duree: body.duree || null,
    experience_requise: body.experience_requise || null,
    url_externe: body.url_externe || null,
    contact_nom: body.contact_nom || partner.representant || null,
    contact_email,
    contact_telephone: body.contact_telephone || null,
    statut: 'en_attente',                    // toujours en attente
    date_expiration: dateExpiration,
    created_by: 'partenaire',
    metadata: body.metadata || {},           // logo_b64, date_match, les_plus, source
  };

  let created;
  try {
    const arr = await supabaseInsert_('offres_emploi', insertData, env);
    created = Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500);
  }

  return jsonResponseNoCache({
    ok: true,
    offre: created,
    message: 'Annonce créée. Elle est en cours de validation par l\'équipe Spacers.',
  });
}

// ============================================================================
//  PUBLIC ENDPOINTS — Sprint C.1 : tuyau emploi public + candidatures
//  Pas d'auth (sauf rate limit éventuel via Cloudflare WAF en couche au-dessus)
//  Consommé par l'app bénévole (cross-origin) et toute page publique future
// ============================================================================

// ----------- GET /api/public/offres-emploi -----------
// Liste publique des annonces validées (statut=publie + non-expirées)
// Pas de pagination V1 (limit 100), filtres côté client
async function handlePublicOffresList(queryParams, env) {
  const nowIso = new Date().toISOString();
  // Filtre : publie + non expirée (date_expiration null OU > now)
  const filter =
    `statut=eq.publie` +
    `&or=(date_expiration.is.null,date_expiration.gt.${encodeURIComponent(nowIso)})` +
    `&select=id,titre,description,type_contrat,lieu,duree,salaire_indicatif,experience_requise,` +
    `url_externe,contact_nom,contact_email,contact_telephone,date_publication,metadata,` +
    `contrats(id,partenaires(raison_sociale,niveau))` +
    `&order=date_publication.desc&limit=100`;

  const rows = await supabaseQuery('offres_emploi', filter, env);

  // Normalisation pour matcher le format attendu par l'app bénévole
  // (mêmes noms de champs que sa table annonces_emploi pour minimiser le code de merge)
  const offres = (rows || []).map(o => {
    const meta = o.metadata || {};
    return {
      id: o.id,
      type: 'partenaire',
      titre: o.titre,
      description: o.description || '',
      type_contrat: o.type_contrat || '',
      lieu: o.lieu || '',
      duree: o.duree || '',
      salaire_indicatif: o.salaire_indicatif || '',
      experience_requise: o.experience_requise || '',
      partenaire_nom: o.contrats?.partenaires?.raison_sociale || '',
      partenaire_niveau: o.contrats?.partenaires?.niveau || '',
      partenaire_logo_url: meta.logo_b64 || null,  // base64 data URL, OK pour <img src>
      contact_nom: o.contact_nom || '',
      contact_email: o.contact_email || '',
      contact_tel: o.contact_telephone || '',
      contact_lien: o.url_externe || '',
      publiee_le: o.date_publication,
      les_plus: meta.les_plus || '',
      date_match: meta.date_match || '',
      source: 'spacers-business-club',
    };
  });

  return jsonResponseNoCache({
    offres,
    count: offres.length,
    meta: { version: 'V4.12-cand-par-offre', generated_at: new Date().toISOString() },
  });
}

// ----------- GET /api/public/offre/:id -----------
// Détail d'une offre + incrémente vues_count (fire-and-forget)
async function handlePublicOffreDetail(offreId, env) {
  const rows = await supabaseQuery(
    'offres_emploi',
    `id=eq.${offreId}&statut=eq.publie&select=*,contrats(id,partenaires(raison_sociale,niveau))&limit=1`,
    env
  );
  if (!rows || rows.length === 0) {
    return jsonResponseNoCache({ error: 'Offre introuvable ou non publiée' }, 404);
  }
  const o = rows[0];
  const meta = o.metadata || {};

  // Increment vues_count en fire-and-forget (n'attend pas la réponse)
  fetch(`${env.SUPABASE_URL}/rest/v1/offres_emploi?id=eq.${offreId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({ vues_count: (o.vues_count || 0) + 1 }),
  }).catch(() => {});

  return jsonResponseNoCache({
    offre: {
      id: o.id,
      type: 'partenaire',
      titre: o.titre,
      description: o.description || '',
      type_contrat: o.type_contrat || '',
      lieu: o.lieu || '',
      duree: o.duree || '',
      salaire_indicatif: o.salaire_indicatif || '',
      experience_requise: o.experience_requise || '',
      partenaire_nom: o.contrats?.partenaires?.raison_sociale || '',
      partenaire_niveau: o.contrats?.partenaires?.niveau || '',
      partenaire_logo_url: meta.logo_b64 || null,
      contact_nom: o.contact_nom || '',
      contact_email: o.contact_email || '',
      contact_tel: o.contact_telephone || '',
      contact_lien: o.url_externe || '',
      publiee_le: o.date_publication,
      les_plus: meta.les_plus || '',
      date_match: meta.date_match || '',
    },
  });
}

// ----------- POST /api/public/offre/:id/candidature -----------
// Body : { candidat_email, candidat_nom, candidat_prenom, candidat_telephone?, message?, cv_url?, source?, benevole_id?, benevole_pseudo? }
async function handlePublicCandidatureCreate(offreId, body, env, ctx) {
  // 1. Vérifier que l'offre existe et est publiée + récupérer le nom du partenaire
  const offreRows = await supabaseQuery(
    'offres_emploi',
    `id=eq.${offreId}&statut=eq.publie` +
    `&select=id,contrat_id,titre,candidatures_count,contact_email,contact_nom,contrats(partenaires(raison_sociale))` +
    `&limit=1`,
    env
  );
  if (!offreRows || offreRows.length === 0) {
    return jsonResponseNoCache({ error: 'Offre introuvable ou non publiée' }, 404);
  }
  const offre = offreRows[0];
  const partenaireRaisonSociale = offre.contrats?.partenaires?.raison_sociale || 'le partenaire';

  // 2. Validation body
  const candidat_email = String(body.candidat_email || '').trim().toLowerCase();
  const candidat_nom = String(body.candidat_nom || '').trim();
  const candidat_prenom = String(body.candidat_prenom || '').trim();

  if (!candidat_email || !candidat_email.includes('@') || candidat_email.length < 5) {
    return jsonResponseNoCache({ error: 'Email candidat invalide' }, 400);
  }
  if (!candidat_nom) {
    return jsonResponseNoCache({ error: 'Nom du candidat obligatoire' }, 400);
  }
  if (!candidat_prenom) {
    return jsonResponseNoCache({ error: 'Prénom du candidat obligatoire' }, 400);
  }

  // 3. Insert candidature
  const candidat_telephone = String(body.candidat_telephone || '').trim() || null;
  const message = body.message ? String(body.message).trim() : null;
  const cv_url = body.cv_url ? String(body.cv_url).trim() : null;

  const insertData = {
    offre_id: offreId,
    contrat_id: offre.contrat_id || null,
    candidat_email,
    candidat_nom,
    candidat_prenom,
    candidat_telephone,
    message,
    cv_url,
    source: String(body.source || 'app-benevole').slice(0, 30),
    benevole_id: body.benevole_id ? String(body.benevole_id).slice(0, 64) : null,
    benevole_pseudo: body.benevole_pseudo ? String(body.benevole_pseudo).slice(0, 100) : null,
    statut: 'nouveau',
  };

  let created;
  try {
    const arr = await supabaseInsert_('candidatures', insertData, env);
    created = Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création candidature', detail: e.message }, 500);
  }

  // 4. Incrémenter candidatures_count sur l'offre (fire-and-forget)
  fetch(`${env.SUPABASE_URL}/rest/v1/offres_emploi?id=eq.${offreId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({ candidatures_count: (offre.candidatures_count || 0) + 1 }),
  }).catch(() => {});

  // 5. Sprint C.2 — Envoi des 2 emails via Resend
  //    ctx.waitUntil() = on dit à Cloudflare "garde le worker vivant jusqu'à la fin de ces promises"
  //    Sans ça, le runtime tue les fetch après la response et les console.warn sont invisibles.
  const emailContext = {
    candidat_prenom,
    candidat_nom,
    candidat_email,
    candidat_telephone,
    message,
    cv_url,
    offre_titre: offre.titre,
    partenaire_nom: partenaireRaisonSociale,
    partenaire_contact_email: offre.contact_email || EMAIL_FALLBACK_PARTNER,
    partenaire_contact_nom: offre.contact_nom || '',
  };

  console.log(`[Candidature] Envoi emails — partenaire=${emailContext.partenaire_contact_email}, candidat=${candidat_email}`);

  // Email 1 : notification au partenaire (reply-to = candidat pour réponse directe)
  const emailPartnerPromise = sendEmailViaResend(env, {
    to: emailContext.partenaire_contact_email,
    subject: `Nouvelle candidature reçue — ${offre.titre}`,
    html: renderEmailPartnerNotification(emailContext),
    replyTo: candidat_email,
  }).then(r => {
    if (r.ok) console.log(`[Email partenaire] Sent OK, id=${r.id}`);
    else if (r.skipped) console.warn(`[Email partenaire] Skipped: ${r.reason}`);
    else console.error(`[Email partenaire] Failed:`, JSON.stringify(r));
  }).catch(e => console.error(`[Email partenaire] Exception:`, e.message));

  // Email 2 : confirmation au candidat (reply-to = club)
  const emailCandidatePromise = sendEmailViaResend(env, {
    to: candidat_email,
    subject: `Confirmation de votre candidature — ${offre.titre}`,
    html: renderEmailCandidateConfirmation(emailContext),
    replyTo: EMAIL_REPLY_TO_CLUB,
  }).then(r => {
    if (r.ok) console.log(`[Email candidat] Sent OK, id=${r.id}`);
    else if (r.skipped) console.warn(`[Email candidat] Skipped: ${r.reason}`);
    else console.error(`[Email candidat] Failed:`, JSON.stringify(r));
  }).catch(e => console.error(`[Email candidat] Exception:`, e.message));

  // ctx.waitUntil garde le worker vivant après la response pour terminer ces promises
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(Promise.all([emailPartnerPromise, emailCandidatePromise]));
  } else {
    // Fallback si ctx absent (ne devrait pas arriver) — await synchrone
    await Promise.all([emailPartnerPromise, emailCandidatePromise]);
  }

  return jsonResponseNoCache({
    ok: true,
    candidature: {
      id: created.id,
      offre_titre: offre.titre,
      candidat_email,
      created_at: created.created_at,
    },
    message: 'Candidature envoyée. Le partenaire sera notifié sous peu.',
  });
}

// ============================================================================
//  RESEND EMAIL — Sprint C.2 : envoi transactionnel + templates HTML
// ============================================================================

async function sendEmailViaResend(env, { to, subject, html, text, replyTo, from }) {
  if (!env.RESEND_API_KEY) {
    console.warn('[Resend] RESEND_API_KEY not set — email skipped');
    return { skipped: true, reason: 'no_api_key' };
  }
  if (!to) {
    console.warn('[Resend] No recipient — email skipped');
    return { skipped: true, reason: 'no_recipient' };
  }
  try {
    const payload = {
      from: from || EMAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    };
    if (text) payload.text = text;
    if (replyTo) payload.reply_to = replyTo;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[Resend] HTTP', res.status, JSON.stringify(data));
      return { ok: false, status: res.status, error: data };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    console.error('[Resend] Network error:', e.message);
    return { ok: false, error: e.message };
  }
}

// Échappement HTML sûr pour insertion dans templates email
function escEmail(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Layout commun (table-based, inline styles — compatibilité maximale clients mail)
function emailLayout(headerEyebrow, headerTitle, headerSubtitle, bodyContent) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escEmail(headerTitle)}</title>
</head>
<body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0A1628;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF7F2;padding:30px 12px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:14px;border:1px solid #E5DED1;box-shadow:0 2px 10px rgba(10,22,40,0.06);">

      <!-- HEADER navy + halo or -->
      <tr><td style="background:#11203a;background-image:linear-gradient(135deg,#11203a 0%,#0A1628 100%);padding:30px 30px 26px;border-radius:14px 14px 0 0;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="width:48px;vertical-align:top;">
              <div style="background:#C8932B;color:#0A1628;width:42px;height:42px;border-radius:10px;text-align:center;line-height:42px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;">S</div>
            </td>
            <td style="padding-left:14px;vertical-align:middle;">
              <div style="color:#E8C977;font-size:10px;font-weight:bold;letter-spacing:2px;line-height:1;">SPACER'S BUSINESS CLUB</div>
              <div style="color:rgba(255,255,255,0.55);font-size:11px;margin-top:4px;">Toulouse Volley · Saison 2026–2027</div>
            </td>
          </tr>
        </table>
        <div style="margin-top:22px;">
          <div style="color:#C8932B;font-size:10px;font-weight:bold;letter-spacing:2px;line-height:1;margin-bottom:8px;">${escEmail(headerEyebrow)}</div>
          <div style="color:#FFFFFF;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.15;font-weight:500;">${escEmail(headerTitle)}</div>
          ${headerSubtitle ? `<div style="color:rgba(255,255,255,0.55);font-size:13px;margin-top:6px;">${escEmail(headerSubtitle)}</div>` : ''}
        </div>
      </td></tr>

      <!-- BODY -->
      <tr><td style="padding:30px 30px 24px;font-size:14px;line-height:1.65;color:#4A5568;">
        ${bodyContent}
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="background:#FAF7F2;padding:18px 30px;text-align:center;font-size:11px;color:#8A8478;border-top:1px solid #E5DED1;border-radius:0 0 14px 14px;">
        Spacer's Toulouse Volley · Palais des Sports André Brouat<br>
        <a href="https://spacerstoulouse.fr" style="color:#C8932B;text-decoration:none;">spacerstoulouse.fr</a>
        &nbsp;·&nbsp;
        <a href="mailto:marketing@spacerstoulouse.fr" style="color:#C8932B;text-decoration:none;">marketing@spacerstoulouse.fr</a>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// Email 1 : notification au partenaire (nouvelle candidature reçue)
function renderEmailPartnerNotification(ctx) {
  const eyebrow = 'NOUVELLE CANDIDATURE';
  const title = `${ctx.candidat_prenom} ${ctx.candidat_nom}`;
  const subtitle = `vient de postuler pour « ${ctx.offre_titre} »`;

  const infoRows = [];
  infoRows.push(`<tr><td style="padding:6px 0;font-size:13px;color:#4A5568;"><strong style="color:#0A1628;display:inline-block;width:90px;">Email</strong><a href="mailto:${escEmail(ctx.candidat_email)}" style="color:#C8932B;text-decoration:none;">${escEmail(ctx.candidat_email)}</a></td></tr>`);
  if (ctx.candidat_telephone) {
    infoRows.push(`<tr><td style="padding:6px 0;font-size:13px;color:#4A5568;"><strong style="color:#0A1628;display:inline-block;width:90px;">Téléphone</strong><a href="tel:${escEmail(ctx.candidat_telephone)}" style="color:#C8932B;text-decoration:none;">${escEmail(ctx.candidat_telephone)}</a></td></tr>`);
  }
  if (ctx.cv_url) {
    infoRows.push(`<tr><td style="padding:6px 0;font-size:13px;color:#4A5568;"><strong style="color:#0A1628;display:inline-block;width:90px;">CV / Lien</strong><a href="${escEmail(ctx.cv_url)}" target="_blank" rel="noopener" style="color:#C8932B;text-decoration:none;word-break:break-all;">${escEmail(ctx.cv_url)}</a></td></tr>`);
  }

  const messageBlock = ctx.message ? `
    <div style="margin-top:24px;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#8A8478;font-weight:bold;margin-bottom:8px;">Message du candidat</div>
      <div style="background:#FAF3DF;border-left:3px solid #C8932B;border-radius:6px;padding:14px 16px;font-size:14px;color:#0A1628;line-height:1.7;white-space:pre-wrap;font-style:italic;">${escEmail(ctx.message)}</div>
    </div>` : '';

  const partenaireGreet = ctx.partenaire_contact_nom ? `Bonjour ${escEmail(ctx.partenaire_contact_nom.split(' ')[0])},` : 'Bonjour,';

  const body = `
    <p style="margin:0 0 18px;font-size:14px;color:#4A5568;line-height:1.7;">${partenaireGreet}</p>
    <p style="margin:0 0 22px;font-size:14px;color:#4A5568;line-height:1.7;">
      Un(e) candidat(e) vient de postuler à votre annonce <strong style="color:#0A1628;">« ${escEmail(ctx.offre_titre)} »</strong> via le réseau Spacer's. Voici ses coordonnées :
    </p>

    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#FAF7F2;border-radius:10px;border:1px solid #E5DED1;padding:6px 16px;margin-bottom:8px;">
      ${infoRows.join('')}
    </table>

    ${messageBlock}

    <div style="margin-top:28px;padding-top:18px;border-top:1px solid #E5DED1;font-size:12px;color:#8A8478;line-height:1.7;font-style:italic;">
      Pour répondre, cliquez simplement sur "Répondre" — votre message ira directement au candidat. La candidature reste aussi consultable dans votre espace partenaire.
    </div>
  `;

  return emailLayout(eyebrow, title, subtitle, body);
}

// Email 2 : confirmation au candidat
function renderEmailCandidateConfirmation(ctx) {
  const eyebrow = 'CANDIDATURE BIEN REÇUE';
  const title = `Merci, ${ctx.candidat_prenom} !`;
  const subtitle = `Votre candidature pour « ${ctx.offre_titre} » est en route`;

  const recapRows = [];
  recapRows.push(`<tr><td style="padding:6px 0;font-size:13px;color:#4A5568;"><strong style="color:#0A1628;display:inline-block;width:90px;">Poste</strong>${escEmail(ctx.offre_titre)}</td></tr>`);
  recapRows.push(`<tr><td style="padding:6px 0;font-size:13px;color:#4A5568;"><strong style="color:#0A1628;display:inline-block;width:90px;">Entreprise</strong>${escEmail(ctx.partenaire_nom)}</td></tr>`);
  recapRows.push(`<tr><td style="padding:6px 0;font-size:13px;color:#4A5568;"><strong style="color:#0A1628;display:inline-block;width:90px;">Contact</strong>${escEmail(ctx.candidat_email)}</td></tr>`);

  const body = `
    <p style="margin:0 0 18px;font-size:14px;color:#4A5568;line-height:1.7;">
      Votre candidature a bien été transmise à <strong style="color:#0A1628;">${escEmail(ctx.partenaire_nom)}</strong>. Le partenaire vous contactera directement sur l'adresse email que vous avez fournie.
    </p>

    <div style="margin:24px 0;">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#8A8478;font-weight:bold;margin-bottom:8px;">Récapitulatif</div>
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#FAF7F2;border-radius:10px;border:1px solid #E5DED1;padding:6px 16px;">
        ${recapRows.join('')}
      </table>
    </div>

    <p style="margin:24px 0 18px;font-size:14px;color:#4A5568;line-height:1.7;">
      ${ctx.message ? 'Votre message a été inclus dans la notification envoyée au partenaire. ' : ''}Pensez à surveiller votre boîte de réception (et le dossier <em>spam</em>) dans les prochains jours.
    </p>

    <p style="margin:24px 0 0;font-size:14px;color:#4A5568;line-height:1.7;">
      Bonne chance pour la suite — l'équipe Spacer's
    </p>

    <div style="margin-top:28px;padding-top:18px;border-top:1px solid #E5DED1;font-size:12px;color:#8A8478;line-height:1.7;font-style:italic;">
      Une question ? Répondez simplement à ce mail, l'équipe vous lit.
    </div>
  `;

  return emailLayout(eyebrow, title, subtitle, body);
}

// ============================================================================
//  CANDIDATURES — Sprint C.3 (admin dashboard)
// ============================================================================

const CANDIDATURE_STATUTS = ['nouveau', 'vue', 'contactee', 'refusee', 'acceptee'];

// ----------- GET /api/admin/candidatures/:token -----------
// Query : ?statut=nouveau&offre_id=... (tous optionnels)
async function handleAdminCandidaturesList(token, queryParams, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const statutFilter = queryParams.get('statut');
  const offreFilter  = queryParams.get('offre_id');

  // Join offre + partenaire pour avoir le contexte côté UI
  let filter =
    'select=*,offres_emploi(id,titre,type_contrat,lieu,contrats(id,partenaires(raison_sociale)))' +
    '&order=created_at.desc&limit=500';
  const extra = [];
  if (statutFilter && CANDIDATURE_STATUTS.includes(statutFilter)) {
    extra.push(`statut=eq.${statutFilter}`);
  }
  if (offreFilter && /^[0-9a-f-]{36}$/.test(offreFilter)) {
    extra.push(`offre_id=eq.${offreFilter}`);
  }
  if (extra.length) filter = extra.join('&') + '&' + filter;

  const rows = await supabaseQuery('candidatures', filter, env);

  const candidatures = (rows || []).map(c => ({
    id: c.id,
    offre_id: c.offre_id,
    contrat_id: c.contrat_id,
    offre_titre: c.offres_emploi?.titre || '—',
    offre_type_contrat: c.offres_emploi?.type_contrat || '',
    offre_lieu: c.offres_emploi?.lieu || '',
    partenaire_nom: c.offres_emploi?.contrats?.partenaires?.raison_sociale || '—',
    candidat_prenom: c.candidat_prenom,
    candidat_nom: c.candidat_nom,
    candidat_email: c.candidat_email,
    candidat_telephone: c.candidat_telephone || '',
    message: c.message || '',
    cv_url: c.cv_url || '',
    source: c.source || '',
    benevole_id: c.benevole_id || '',
    benevole_pseudo: c.benevole_pseudo || '',
    statut: c.statut,
    pilote_notes: c.pilote_notes || '',
    traite_par_admin_id: c.traite_par_admin_id || null,
    traite_le: c.traite_le || null,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));

  // Stats : si filtre offre actif, stats de cette offre ; sinon stats globales
  let statsRows;
  if (offreFilter && /^[0-9a-f-]{36}$/.test(offreFilter)) {
    statsRows = await supabaseQuery('candidatures', `offre_id=eq.${offreFilter}&select=statut`, env);
  } else {
    statsRows = await supabaseQuery('candidatures', 'select=statut', env);
  }
  const stats = { nouveau: 0, vue: 0, contactee: 0, refusee: 0, acceptee: 0, total: 0 };
  (statsRows || []).forEach(r => {
    if (CANDIDATURE_STATUTS.includes(r.statut)) stats[r.statut]++;
    stats.total++;
  });

  return jsonResponseNoCache({ candidatures, stats });
}

// ----------- GET /api/admin/candidature/:token/:id -----------
async function handleAdminCandidatureDetail(token, candidatureId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery(
    'candidatures',
    `id=eq.${candidatureId}` +
    `&select=*,offres_emploi(id,titre,type_contrat,lieu,description,contact_email,contact_nom,contrats(id,partenaires(raison_sociale)))` +
    `&limit=1`,
    env
  );
  if (!rows || rows.length === 0) {
    return jsonResponseNoCache({ error: 'Candidature introuvable' }, 404);
  }
  const c = rows[0];

  return jsonResponseNoCache({
    candidature: {
      id: c.id,
      offre_id: c.offre_id,
      offre_titre: c.offres_emploi?.titre || '—',
      offre_type_contrat: c.offres_emploi?.type_contrat || '',
      offre_lieu: c.offres_emploi?.lieu || '',
      offre_description: c.offres_emploi?.description || '',
      offre_contact_nom: c.offres_emploi?.contact_nom || '',
      offre_contact_email: c.offres_emploi?.contact_email || '',
      partenaire_nom: c.offres_emploi?.contrats?.partenaires?.raison_sociale || '—',
      candidat_prenom: c.candidat_prenom,
      candidat_nom: c.candidat_nom,
      candidat_email: c.candidat_email,
      candidat_telephone: c.candidat_telephone || '',
      message: c.message || '',
      cv_url: c.cv_url || '',
      source: c.source || '',
      benevole_id: c.benevole_id || '',
      benevole_pseudo: c.benevole_pseudo || '',
      statut: c.statut,
      pilote_notes: c.pilote_notes || '',
      traite_par_admin_id: c.traite_par_admin_id || null,
      traite_le: c.traite_le || null,
      created_at: c.created_at,
      updated_at: c.updated_at,
    },
  });
}

// ----------- POST /api/admin/candidature/:token/:id/update-statut -----------
// Body : { statut: 'vue'|'contactee'|'refusee'|'acceptee', pilote_notes?: string }
async function handleAdminCandidatureUpdateStatut(token, candidatureId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const newStatut = String(body.statut || '').trim();
  if (!CANDIDATURE_STATUTS.includes(newStatut)) {
    return jsonResponseNoCache({ error: `Statut invalide. Valeurs : ${CANDIDATURE_STATUTS.join(', ')}` }, 400);
  }

  // Vérifier que la candidature existe
  const existing = await supabaseQuery(
    'candidatures',
    `id=eq.${candidatureId}&select=id,statut&limit=1`,
    env
  );
  if (!existing || existing.length === 0) {
    return jsonResponseNoCache({ error: 'Candidature introuvable' }, 404);
  }

  const patch = {
    statut: newStatut,
    traite_par_admin_id: admin.id,
    traite_le: new Date().toISOString(),
  };
  if (typeof body.pilote_notes === 'string') {
    patch.pilote_notes = body.pilote_notes.trim().slice(0, 5000) || null;
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/candidatures?id=eq.${candidatureId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const errTxt = await res.text();
    return jsonResponseNoCache({ error: 'Erreur update statut', detail: errTxt }, 500);
  }
  const updated = await res.json();

  return jsonResponseNoCache({
    ok: true,
    candidature: Array.isArray(updated) ? updated[0] : updated,
  });
}
