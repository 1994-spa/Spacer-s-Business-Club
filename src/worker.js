/**
 * Spacers Business Club — Worker V4.38-stories (success stories : soumission partenaire + modération)
 * Source de vérité : Supabase (au lieu d'Apps Script)
 *
 * Variables d'environnement requises dans Cloudflare Worker Settings :
 *   - SUPABASE_URL              (variable, ex: https://xxxxx.supabase.co)
 *   - SUPABASE_SERVICE_ROLE_KEY (secret, eyJhbGci...)
 *   - SUPABASE_ANON_KEY         (variable, clé publique anon — pour l'auth partenaire)
 *   - RESEND_API_KEY            (secret, envoi des emails)
 *
 * V4.18-mails — Ajout du module "Mails" (campagnes email aux partenaires)
 */

const CACHE_TTL = 30; // secondes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// ============================================================================
//  EMAIL SETTINGS — Sprint C.2 (Resend transactional)
// ============================================================================
const EMAIL_FROM = "Spacer's Business Club <marketing@spacerstoulouse.fr>";
const EMAIL_REPLY_TO_CLUB = 'marketing@spacerstoulouse.fr';
const EMAIL_FALLBACK_PARTNER = 'spacersytb@gmail.com'; // si l'offre n'a pas de contact_email

// ===== Sprint Mails — campagnes email partenaires =====
const MAIL_STATUTS = ['brouillon', 'valide', 'envoye'];
const MAIL_SENDER_EMAIL = 'marketing@spacerstoulouse.fr'; // domaine vérifié Resend
const UNSUB_SALT = 'spacers-bc-unsub-2026';
const PUBLIC_BASE_URL = 'https://business.spacerstoulouse.fr';
const MAIL_ASSETS_BUCKET = 'mail-assets'; // bucket Supabase Storage public (images des mails)
const MAIL_IMG_MAX_BYTES = 3 * 1024 * 1024; // 3 Mo
const MAIL_IMG_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];

// ===== Sprint Invitations — événements partenaires (RSVP, places, relances) =====
const INVITATION_STATUTS = ['brouillon', 'valide', 'envoye', 'clos'];
const INVITATION_SENDER_EMAIL = 'marketing@spacerstoulouse.fr';

// ⚠️ RECOLLE ICI ton base64 existant du template PDF "Minute de l'emploi".
// Il n'était pas dans le fichier que tu m'as transmis. Laisse '' si tu ne l'as pas
// sous la main : la route /minute_de_l_emploi_template.pdf renverra alors un 404
// propre (au lieu de planter le worker). Le reste fonctionne normalement.
const MINUTE_EMPLOI_TEMPLATE_B64 = '';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS });
      }
      // Stripe — webhook (corps brut + vérif signature, AVANT tout parsing JSON)
      if (path === '/api/stripe/webhook' && request.method === 'POST') {
        return await handleStripeWebhook(request, env, ctx);
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

    // Sprint E.4 — Pages d'auth partenaire (/activate, /login, /reset)
    if (path === '/activate' || path === '/activate/') {
      return env.ASSETS.fetch(new Request(new URL('/activate.html', request.url).toString(), request));
    }
    if (path === '/login' || path === '/login/') {
      return env.ASSETS.fetch(new Request(new URL('/login.html', request.url).toString(), request));
    }
    if (path === '/reset' || path === '/reset/') {
      return env.ASSETS.fetch(new Request(new URL('/reset.html', request.url).toString(), request));
    }

    // Sprint Mails — page publique de désinscription (RGPD)
    if (path === '/desinscription' || path === '/desinscription/') {
      return await handleDesinscription(url, env);
    }

    // Sprint Invitations — pages publiques de réponse RSVP
    if (path === '/invitation' || path === '/invitation/') {
      return await handleInvitationPublicPage(url, env);
    }
    if (path === '/invitation/repondre' && request.method === 'POST') {
      return await handleInvitationPublicRepondre(request, env);
    }
    if (path === '/invitation/paye' || path === '/invitation/paye/') {
      return await handleInvitationPaidPage(url, env);
    }

    return env.ASSETS.fetch(request);
  },

  // Cron Cloudflare — relances & rappels d'invitations (déclenché par wrangler.toml [triggers] crons)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runInvitationRelances(env));
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

  const url = new URL(request.url);
  const method = request.method;

  try {
    // ===== POST : mutations admin =====
    if (method === 'POST') {
      // Upload image (multipart/form-data) — traité AVANT le parse JSON
      let mUp = path.match(/^\/api\/admin\/mails\/([a-zA-Z0-9_-]{16,})\/upload-image$/);
      if (mUp) return await handleAdminMailUploadImage(mUp[1], request, env);

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

      // Partenaire — mise à jour de sa fiche annuaire
      m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/ma-fiche$/);
      if (m) return await handlePartnerFicheUpdate(m[1], body || {}, env);

      // Networking — demande de mise en relation (partenaire) + traitement (admin)
      m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/intro-request$/);
      if (m) return await handlePartnerIntroRequest(m[1], body || {}, env);

      m = path.match(/^\/api\/admin\/intro\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update$/);
      if (m) return await handleAdminIntroUpdate(m[1], m[2], body || {}, env);

      // Success stories — soumission partenaire + modération admin
      m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/success-story$/);
      if (m) return await handlePartnerSuccessStoryCreate(m[1], body || {}, env);

      m = path.match(/^\/api\/admin\/success-story\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update$/);
      if (m) return await handleAdminSuccessStoryUpdate(m[1], m[2], body || {}, env);

      // Partenaire — répondre à une publication du board (Sprint B.3)
      m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/publication\/([0-9a-f-]{36})\/reponse$/);
      if (m) return await handlePartnerPublicationRespond(m[1], m[2], body || {}, env, ctx);

      // Public — soumission de candidature (Sprint C.1)
      m = path.match(/^\/api\/public\/offre\/([0-9a-f-]{36})\/candidature$/);
      if (m) return await handlePublicCandidatureCreate(m[1], body || {}, env, ctx);

      // Sprint C.3 — Update statut candidature (admin)
      m = path.match(/^\/api\/admin\/candidature\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update-statut$/);
      if (m) return await handleAdminCandidatureUpdateStatut(m[1], m[2], body || {}, env);

      // ===== Sprint D — Communications (admin CRUD + publish) =====
      m = path.match(/^\/api\/admin\/communications\/([a-zA-Z0-9_-]{16,})\/create$/);
      if (m) return await handleAdminCommunicationCreate(m[1], body || {}, env);

      m = path.match(/^\/api\/admin\/communications\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/publish$/);
      if (m) return await handleAdminCommunicationPublish(m[1], m[2], env, ctx);

      m = path.match(/^\/api\/admin\/communications\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/archive$/);
      if (m) return await handleAdminCommunicationArchive(m[1], m[2], env);

      // ===== Sprint Tickie — Rencontres + places VIP (POST) =====
      m = path.match(/^\/api\/admin\/rencontres\/([a-zA-Z0-9_-]{16,})\/create$/);
      if (m) return await handleAdminRencontreCreate(m[1], body || {}, env);

      m = path.match(/^\/api\/admin\/rencontre\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/ouvrir$/);
      if (m) return await handleAdminRencontreOuvrir(m[1], m[2], env);

      m = path.match(/^\/api\/admin\/rencontre\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/fermer$/);
      if (m) return await handleAdminRencontreFermer(m[1], m[2], env);

      m = path.match(/^\/api\/admin\/allocation\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update$/);
      if (m) return await handleAdminAllocationUpdate(m[1], m[2], body || {}, env);

      // ===== Sprint Mails — campagnes email aux partenaires =====
      m = path.match(/^\/api\/admin\/mails\/([a-zA-Z0-9_-]{16,})\/create$/);
      if (m) return await handleAdminMailCreate(m[1], body || {}, env);

      m = path.match(/^\/api\/admin\/mails\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update$/);
      if (m) return await handleAdminMailUpdate(m[1], m[2], body || {}, env);

      m = path.match(/^\/api\/admin\/mails\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/validate$/);
      if (m) return await handleAdminMailValidate(m[1], m[2], env);

      m = path.match(/^\/api\/admin\/mails\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/test$/);
      if (m) return await handleAdminMailTest(m[1], m[2], env, ctx);

      m = path.match(/^\/api\/admin\/mails\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/send$/);
      if (m) return await handleAdminMailSend(m[1], m[2], env, ctx);

      // ===== Sprint Invitations — admin =====
      m = path.match(/^\/api\/admin\/invitations\/([a-zA-Z0-9_-]{16,})\/create$/);
      if (m) return await handleAdminInvitationCreate(m[1], body || {}, env);

      m = path.match(/^\/api\/admin\/invitations\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/update$/);
      if (m) return await handleAdminInvitationUpdate(m[1], m[2], body || {}, env);

      m = path.match(/^\/api\/admin\/invitations\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/validate$/);
      if (m) return await handleAdminInvitationValidate(m[1], m[2], env);

      m = path.match(/^\/api\/admin\/invitations\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/test$/);
      if (m) return await handleAdminInvitationTest(m[1], m[2], env, ctx);

      m = path.match(/^\/api\/admin\/invitations\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/send$/);
      if (m) return await handleAdminInvitationSend(m[1], m[2], env, ctx);

      m = path.match(/^\/api\/admin\/invitations\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/relancer$/);
      if (m) return await handleAdminInvitationRelancer(m[1], m[2], env, ctx);

      // Sprint D — Communications (partenaire : RSVP)
      m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/communication\/([0-9a-f-]{36})\/rsvp$/);
      if (m) return await handlePartnerCommunicationRsvp(m[1], m[2], body || {}, env);

      // ===== Sprint E.2 — Gestion des contacts partenaires (admin) =====
      m = path.match(/^\/api\/admin\/partenaire\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/contacts\/create$/);
      if (m) return await handleAdminContactCreate(m[1], m[2], body || {}, env);

      // Admin — édition de la fiche annuaire de n'importe quel partenaire
      m = path.match(/^\/api\/admin\/partenaire\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/fiche$/);
      if (m) return await handleAdminPartenaireFicheUpdate(m[1], m[2], body || {}, env);

      // Ingestion automatique (Make.com / RSS) — protégée par SOCIAL_INGEST_SECRET
      if (path === '/api/ingest/social') return await handleSocialIngest(request, body || {}, env);

      // Admin — actualités du club (posts LinkedIn)
      m = path.match(/^\/api\/admin\/social-posts\/([a-zA-Z0-9_-]{16,})$/);
      if (m) return await handleAdminSocialUpsert(m[1], body || {}, env);

      // Admin — complétion en masse des secteurs depuis SIREN/SIRET
      m = path.match(/^\/api\/admin\/partenaires\/([a-zA-Z0-9_-]{16,})\/enrich-secteurs$/);
      if (m) return await handleAdminEnrichSecteurs(m[1], env);

      m = path.match(/^\/api\/admin\/social-post\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/delete$/);
      if (m) return await handleAdminSocialDelete(m[1], m[2], env);

      // ===== Sprint E.4 — Confirmation d'activation partenaire =====
      if (path === '/api/partner/confirm-activation') {
        return await handlePartnerConfirmActivation(request, env);
      }

      m = path.match(/^\/api\/admin\/partenaire\/([a-zA-Z0-9_-]{16,})\/contact\/([0-9a-f-]{36})\/update$/);
      if (m) return await handleAdminContactUpdate(m[1], m[2], body || {}, env);

      m = path.match(/^\/api\/admin\/partenaire\/([a-zA-Z0-9_-]{16,})\/contact\/([0-9a-f-]{36})\/delete$/);
      if (m) return await handleAdminContactDelete(m[1], m[2], env);

      m = path.match(/^\/api\/admin\/partenaire\/([a-zA-Z0-9_-]{16,})\/contact\/([0-9a-f-]{36})\/invite$/);
      if (m) return await handleAdminContactInvite(m[1], m[2], env);

      return jsonResponse({ error: 'Unknown POST route', path }, 404);
    }

    // ===== GET =====
    // Health check
    if (path === '/api/ping') {
      return jsonResponse({
        status: 'ok',
        version: 'V4.23-board — board + réponses + notif email auteur',
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

    // Admin export (données JSON → .xlsx généré côté navigateur)
    m = path.match(/^\/api\/admin\/export\/([a-zA-Z0-9_-]{16,})\/([a-z-]+)$/);
    if (m) return await handleAdminExport(m[1], m[2], env);

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

    // Partner — board partagé (toutes les publications publiées) + réponses (Sprint B.3)
    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/board$/);
    if (m) return await handlePartnerBoard(m[1], url.searchParams, env);

    // Partner — Annuaire des partenaires (networking) + sa propre fiche
    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/annuaire$/);
    if (m) return await handlePartnerAnnuaire(m[1], env);

    // Annuaire — backfill géocodage des adresses déjà en base (admin ; ouvrir l'URL dans le navigateur)
    m = path.match(/^\/api\/admin\/geocode-backfill\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminGeocodeBackfill(m[1], env);

    // Networking — suggestions + mes demandes de mise en relation
    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/suggestions$/);
    if (m) return await handlePartnerSuggestions(m[1], env);

    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/mes-intros$/);
    if (m) return await handlePartnerMesIntros(m[1], env);

    m = path.match(/^\/api\/admin\/intros\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminIntrosList(m[1], env);

    // Success stories — showcase partenaire + liste admin
    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/success-stories$/);
    if (m) return await handlePartnerSuccessStories(m[1], env);

    m = path.match(/^\/api\/admin\/success-stories\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminSuccessStoriesList(m[1], env);

    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/ma-fiche$/);
    if (m) return await handlePartnerFicheGet(m[1], env);

    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/siret-lookup$/);
    if (m) return await handlePartnerSiretLookup(m[1], url.searchParams, env);

    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/social-feed$/);
    if (m) return await handlePartnerSocialFeed(m[1], env);

    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/publication\/([0-9a-f-]{36})\/reponses$/);
    if (m) return await handlePartnerPublicationReponses(m[1], m[2], env);

    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/offres-emploi$/);
    if (m) return await handlePartnerOffresList(m[1], env);

    // Public — liste des annonces publiées (Sprint C.1, sans auth, pour app bénévole + page publique)
    m = path.match(/^\/api\/public\/offres-emploi$/);
    if (m) return await handlePublicOffresList(url.searchParams, env);

    // ===== Sprint Tickie — Rencontres + places VIP (GET) =====
    m = path.match(/^\/api\/admin\/rencontres\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminRencontresList(m[1], env);

    m = path.match(/^\/api\/admin\/rencontre\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/allocations$/);
    if (m) return await handleAdminRencontreAllocations(m[1], m[2], env);

    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/places$/);
    if (m) return await handlePartnerPlaces(m[1], env);

    // Public — détail offre + incrément vues_count
    m = path.match(/^\/api\/public\/offre\/([0-9a-f-]{36})$/);
    if (m) return await handlePublicOffreDetail(m[1], env);

    // ===== Sprint D — Communications (admin) =====
    m = path.match(/^\/api\/admin\/communications\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminCommunicationsList(m[1], url.searchParams, env);

    // ===== Sprint Mails =====
    m = path.match(/^\/api\/admin\/mails\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminMailsList(m[1], env);

    m = path.match(/^\/api\/admin\/mail\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})$/);
    if (m) return await handleAdminMailDetail(m[1], m[2], env);

    // ===== Sprint Invitations — admin (GET) =====
    m = path.match(/^\/api\/admin\/invitations\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminInvitationsList(m[1], env);

    m = path.match(/^\/api\/admin\/invitation\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})$/);
    if (m) return await handleAdminInvitationDetail(m[1], m[2], env);

    // ===== Sprint E.4 — Auth partenaire (Supabase Auth) =====
    if (path === '/api/auth/config') return await handleAuthConfig(env);

    m = path.match(/^\/api\/partner-by-session$/);
    if (m) return await handlePartnerBySession(request, env);

    // ===== Sprint G — Compte unifié multi-rôles =====
    if (path === '/api/me/roles') return await handleMeRoles(request, env);

    // ===== Sprint E.2 — Gestion des contacts partenaires (admin) =====
    m = path.match(/^\/api\/admin\/partenaires\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminPartenairesList(m[1], env);

    m = path.match(/^\/api\/admin\/siret-lookup\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminSiretLookup(m[1], url.searchParams, env);

    m = path.match(/^\/api\/admin\/social-posts\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminSocialList(m[1], env);

    m = path.match(/^\/api\/admin\/partenaire\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/contacts$/);
    if (m) return await handleAdminContactsList(m[1], m[2], env);

    m = path.match(/^\/api\/admin\/partenaire\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})\/fiche$/);
    if (m) return await handleAdminPartenaireFicheGet(m[1], m[2], env);

    m = path.match(/^\/api\/admin\/communication\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})$/);
    if (m) return await handleAdminCommunicationDetail(m[1], m[2], env);

    // Sprint D — Communications (partenaire : liste des publiées + sa réponse RSVP)
    m = path.match(/^\/api\/partner\/([a-zA-Z0-9_-]{16,})\/communications$/);
    if (m) return await handlePartnerCommunicationsList(m[1], env);

    // ===== Sprint C.3 — Candidatures admin =====
    m = path.match(/^\/api\/admin\/candidatures\/([a-zA-Z0-9_-]{16,})$/);
    if (m) return await handleAdminCandidaturesList(m[1], url.searchParams, env);

    m = path.match(/^\/api\/admin\/candidature\/([a-zA-Z0-9_-]{16,})\/([0-9a-f-]{36})$/);
    if (m) return await handleAdminCandidatureDetail(m[1], m[2], env);

    // ===== Assets statiques (PDF Minute de l'emploi en fallback) =====
    if (path === '/assets/minute-emploi-template.pdf' || path === '/minute_de_l_emploi_template.pdf') {
      if (!MINUTE_EMPLOI_TEMPLATE_B64) {
        return jsonResponse({ error: 'Template PDF non configuré (MINUTE_EMPLOI_TEMPLATE_B64 vide)' }, 404);
      }
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
        'GET  /api/admin/mails/:token',
        'GET  /api/admin/mail/:token/:id',
        'POST /api/admin/mails/:token/create',
        'POST /api/admin/mails/:token/upload-image',
        'POST /api/admin/mails/:token/:id/update',
        'POST /api/admin/mails/:token/:id/validate',
        'POST /api/admin/mails/:token/:id/test',
        'POST /api/admin/mails/:token/:id/send',
        'GET  /api/admin/invitations/:token',
        'GET  /api/admin/invitation/:token/:id',
        'POST /api/admin/invitations/:token/create',
        'POST /api/admin/invitations/:token/:id/update',
        'POST /api/admin/invitations/:token/:id/validate',
        'POST /api/admin/invitations/:token/:id/test',
        'POST /api/admin/invitations/:token/:id/send',
        'POST /api/admin/invitations/:token/:id/relancer',
        'GET  /api/admin/tickie/ping/:token',
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
//  PARTNER BY TOKEN
// ============================================================================

async function handlePartnerByToken(token, env) {
  const query =
    `magic_token=eq.${token}` +
    `&select=*,partenaire:partenaires(*),prestations(*),packs_places(*)` +
    `&limit=1`;

  const rows = await supabaseQuery('contrats', query, env);

  if (!rows || rows.length === 0) {
    return jsonResponse({ error: 'Token invalide ou partenaire introuvable' }, 404);
  }

  return jsonResponse(_buildPartnerDashboard(rows[0]));
}

function _buildPartnerDashboard(c) {
  const p = c.partenaire || {};
  const prestations = (c.prestations || []).sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const packsArr = (c.packs_places || []);
  const pack = packsArr.length > 0 ? packsArr[0] : null;

  return {
    magic_token: c.magic_token || '',
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
    alertes: [],
    meta: {
      generated_at: new Date().toISOString(),
      version: 'V4-supabase',
    },
  };
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
//  ADMIN AUTH
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

  fetch(`${env.SUPABASE_URL}/rest/v1/admins?magic_token=eq.${token}`, {
    method: 'PATCH',
    headers: supabaseHeaders(env),
    body: JSON.stringify({ derniere_connexion: new Date().toISOString() }),
  }).catch(() => {});

  return jsonResponse({
    admin: admins[0],
    meta: { version: 'V4-supabase', generated_at: new Date().toISOString() },
  });
}

// ============================================================================
//  ADMIN EXPORT (renvoie les données en JSON ; le .xlsx est généré côté
//  navigateur dans le Pilote admin, via SheetJS)
// ============================================================================

const ADMIN_EXPORT_DATASETS = {
  'partenaires': { table: 'partenaires',               order: 'raison_sociale', label: 'Annuaire partenaires' },
  'contacts':    { table: 'partenaire_contacts',                                label: 'Contacts partenaires' },
  'evenements':  { table: 'invitations',                                        label: 'Evenements' },
  'presences':   { table: 'invitation_destinataires',                           label: 'Presents aux evenements' },
  'packs':       { table: 'packs_places',                                       label: 'Packs de places' },
  'places-vip':  { table: 'rencontre_allocations',                              label: 'Places VIP par match' },
};

async function handleAdminExport(token, dataset, env) {
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id&limit=1`,
    env
  );
  if (!admins || admins.length === 0) {
    return jsonResponse({ error: 'Invalid admin token' }, 401);
  }

  const cfg = ADMIN_EXPORT_DATASETS[dataset];
  if (!cfg) {
    return jsonResponse({ error: 'Unknown dataset', available: Object.keys(ADMIN_EXPORT_DATASETS) }, 400);
  }

  let qs = 'select=*';
  if (cfg.order) qs += `&order=${encodeURIComponent(cfg.order)}`;
  let rows = await supabaseQuery(cfg.table, qs, env);
  if (!Array.isArray(rows)) rows = [];

  // Retire les champs base64 volumineux (logos, photos) — inutiles en Excel.
  rows = rows.map((r) => {
    const o = {};
    for (const k in r) { if (!/_b64$/.test(k)) o[k] = r[k]; }
    return o;
  });

  return jsonResponse({ dataset, label: cfg.label, count: rows.length, rows });
}

// ============================================================================
//  ADMIN DASHBOARD
// ============================================================================

async function handleAdminDashboard(token, env) {
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id,prenom,nom,email,role&limit=1`,
    env
  );
  if (!admins || admins.length === 0) {
    return jsonResponse({ error: 'Invalid admin token' }, 401);
  }
  const admin = admins[0];

  const saisonActive = '2026-2027';

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
//  ADMIN PARTNERS LIST
// ============================================================================

async function handleAdminPartners(token, env) {
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id&limit=1`,
    env
  );
  if (!admins || admins.length === 0) {
    return jsonResponse({ error: 'Invalid admin token' }, 401);
  }

  const saisonActive = '2026-2027';

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
//  ADMIN PARTNER DETAIL
// ============================================================================

async function handleAdminPartnerDetail(token, contractId, env) {
  const admins = await supabaseQuery(
    'admins',
    `magic_token=eq.${token}&actif=eq.true&select=id&limit=1`,
    env
  );
  if (!admins || admins.length === 0) {
    return jsonResponse({ error: 'Invalid admin token' }, 401);
  }

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
//  MUTATIONS
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
  supabasePost_('audit_log', {
    admin_id: adminId,
    action: action,
    table_name: table,
    record_id: recordId,
    changes: changes,
  }, env).catch(() => {});
}

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
//  TICKIE (Vivenu)
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

async function handleTickiePing(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  try {
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

async function handleTickieCustomers(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  try {
    const raw = await tickieRequest_('/customers/rich', env, { top: '500' });
    const customers = raw.rows || raw.docs || (Array.isArray(raw) ? raw : []);

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

async function handleCreateTickieCustomer(token, contractId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

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

  const email = String(body.email || '').trim().toLowerCase();
  const prenom = String(body.prenom || '').trim();
  const nom = String(body.nom || '').trim();
  const telephone = String(body.telephone || '').trim();

  if (!email || !email.includes('@') || email.length < 5) {
    return jsonResponseNoCache({ error: 'Email invalide', got: email }, 400);
  }

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

  await logAudit_(admin.id, 'partenaire.create_tickie_customer', 'partenaires', partenaire.id, {
    tickie_customer_id: tickieId,
    email,
    company: partenaire.raison_sociale,
  }, env);

  return jsonResponseNoCache({
    ok: true,
    tickie_customer_id: tickieId,
    email,
    company: partenaire.raison_sociale,
    next_step: 'Tu peux maintenant envoyer le login au partenaire',
  });
}

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
  }, env);

  return jsonResponseNoCache({
    ok: true,
    message: 'Email de connexion envoyé au partenaire',
    tickie_customer_id: partenaire.tickie_customer_id,
  });
}

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
  }, env);

  return jsonResponseNoCache({
    ok: true,
    unlinked: oldId,
    note: 'Le customer Tickie n\'a PAS été supprimé côté Tickie. Le mapping est juste retiré.',
  });
}

// ============================================================================
//  OFFRES D'EMPLOI
// ============================================================================

const OFFRE_STATUTS = ['en_attente', 'publie', 'refuse', 'expire', 'pourvue', 'archive'];

async function handleAdminOffresList(token, queryParams, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const statutFilter = queryParams.get('statut');
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

  const stats = { en_attente: 0, publie: 0, refuse: 0, archive: 0, expire: 0, pourvue: 0, total: 0 };
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
      metadata: o.metadata || {},
    },
  });
}

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
  }, env);

  if (insertData.statut === 'publie') {
    try { await syncOffreToAnnonces_(created.id, env); }
    catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', created.id, { detail: e.message }, env); }
  }
  return jsonResponseNoCache({ ok: true, offre: created });
}

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

  await logAudit_(admin.id, 'offre.update', 'offres_emploi', offreId, updateData, env);

  return jsonResponseNoCache({ ok: true });
}

async function handleAdminOffrePublish(token, offreId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  await supabasePatch_('offres_emploi', `id=eq.${offreId}`, {
    statut: 'publie',
    date_publication: new Date().toISOString(),
    raison_refus: null,
  }, env);

  await logAudit_(admin.id, 'offre.publish', 'offres_emploi', offreId, {}, env);

  try { await syncOffreToAnnonces_(offreId, env); }
  catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', offreId, { detail: e.message }, env); }
  return jsonResponseNoCache({ ok: true, statut: 'publie' });
}

async function handleAdminOffreReject(token, offreId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const raison = String(body.raison || '').trim() || 'Refus admin';

  await supabasePatch_('offres_emploi', `id=eq.${offreId}`, {
    statut: 'refuse',
    raison_refus: raison,
    date_publication: null,
  }, env);

  await logAudit_(admin.id, 'offre.reject', 'offres_emploi', offreId, { raison }, env);

  try { await deactivateAnnonceForOffre_(offreId, env); }
  catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', offreId, { detail: e.message }, env); }
  return jsonResponseNoCache({ ok: true, statut: 'refuse', raison });
}

async function handleAdminOffreArchive(token, offreId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  await supabasePatch_('offres_emploi', `id=eq.${offreId}`, {
    statut: 'archive',
  }, env);

  await logAudit_(admin.id, 'offre.archive', 'offres_emploi', offreId, {}, env);

  try { await deactivateAnnonceForOffre_(offreId, env); }
  catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', offreId, { detail: e.message }, env); }
  return jsonResponseNoCache({ ok: true, statut: 'archive' });
}

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
//  PUBLICATIONS
// ============================================================================

// ============================================================================
//  SYNC OFFRES EMPLOI -> BENEVOLES (annonces_emploi)
// ============================================================================
function benevolesReady_(env) {
  return !!(env.BENEVOLES_SUPABASE_URL && env.BENEVOLES_SERVICE_ROLE_KEY);
}
function benevolesHeaders_(env) {
  return {
    'apikey': env.BENEVOLES_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.BENEVOLES_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}
function normalizeLogo_(b64) {
  if (!b64) return null;
  const s = String(b64).trim();
  if (s.startsWith('data:')) return s;
  return `data:image/png;base64,${s}`;
}
async function bizSelectOne_(table, query, env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) return null;
  const arr = await res.json();
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}
async function syncOffreToAnnonces_(offreId, env) {
  if (!benevolesReady_(env)) throw new Error('BENEVOLES creds non configures');
  const offre = await bizSelectOne_('offres_emploi', `id=eq.${offreId}&select=*`, env);
  if (!offre) throw new Error('offre introuvable: ' + offreId);
  let nom = null, logo = null;
  if (offre.contrat_id) {
    const contrat = await bizSelectOne_('contrats', `id=eq.${encodeURIComponent(offre.contrat_id)}&select=partenaire_id`, env);
    if (contrat && contrat.partenaire_id) {
      const part = await bizSelectOne_('partenaires', `id=eq.${contrat.partenaire_id}&select=raison_sociale,logo_b64`, env);
      if (part) { nom = part.raison_sociale || null; logo = normalizeLogo_(part.logo_b64); }
    }
  }
  const payload = {
    source_offre_id: offre.id,
    type: 'partenaire',
    titre: offre.titre || null,
    description: offre.description || null,
    partenaire_nom: nom,
    partenaire_logo_url: logo,
    type_contrat: offre.type_contrat || null,
    lieu: offre.lieu || null,
    contact_nom: offre.contact_nom || null,
    contact_email: offre.contact_email || null,
    contact_tel: offre.contact_telephone || null,
    contact_lien: offre.url_externe || null,
    publiee_le: offre.date_publication || new Date().toISOString(),
    expire_le: offre.date_expiration || null,
    active: true,
    statut_validation: 'validee',
  };
  const res = await fetch(`${env.BENEVOLES_SUPABASE_URL}/rest/v1/annonces_emploi?on_conflict=source_offre_id`, {
    method: 'POST',
    headers: { ...benevolesHeaders_(env), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Sync annonces_emploi ${res.status}: ${t.slice(0,300)}`); }
  return res.json();
}
async function deactivateAnnonceForOffre_(offreId, env) {
  if (!benevolesReady_(env)) throw new Error('BENEVOLES creds non configures');
  const res = await fetch(`${env.BENEVOLES_SUPABASE_URL}/rest/v1/annonces_emploi?source_offre_id=eq.${offreId}`, {
    method: 'PATCH',
    headers: { ...benevolesHeaders_(env), Prefer: 'return=representation' },
    body: JSON.stringify({ active: false }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Desactivation annonce ${res.status}: ${t.slice(0,300)}`); }
  return res.json();
}

const PUB_TYPES = ['forum', 'proposition', 'echange'];
const PUB_STATUTS = ['en_attente', 'publie', 'refuse', 'expire', 'archive'];

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
    const contrats = await supabaseQuery('contrats', `id=eq.${contrat_id}&select=partenaire_id&limit=1`, env);
    if (contrats && contrats[0]) partenaire_id = contrats[0].partenaire_id;
  }

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
  }, env);

  return jsonResponseNoCache({ ok: true, publication: created });
}

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

  await logAudit_(admin.id, 'publication.update', 'publications', pubId, updateData, env);

  return jsonResponseNoCache({ ok: true });
}

async function handleAdminPublicationPublish(token, pubId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  await supabasePatch_('publications', `id=eq.${pubId}`, {
    statut: 'publie',
    date_publication: new Date().toISOString(),
    raison_refus: null,
  }, env);

  await logAudit_(admin.id, 'publication.publish', 'publications', pubId, {}, env);

  try { await syncOffreToAnnonces_(offreId, env); }
  catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', offreId, { detail: e.message }, env); }
  return jsonResponseNoCache({ ok: true, statut: 'publie' });
}

async function handleAdminPublicationReject(token, pubId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const raison = String(body.raison || '').trim() || 'Refus admin';

  await supabasePatch_('publications', `id=eq.${pubId}`, {
    statut: 'refuse',
    raison_refus: raison,
    date_publication: null,
  }, env);

  await logAudit_(admin.id, 'publication.reject', 'publications', pubId, { raison }, env);

  try { await deactivateAnnonceForOffre_(offreId, env); }
  catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', offreId, { detail: e.message }, env); }
  return jsonResponseNoCache({ ok: true, statut: 'refuse', raison });
}

async function handleAdminPublicationArchive(token, pubId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  await supabasePatch_('publications', `id=eq.${pubId}`, { statut: 'archive' }, env);
  await logAudit_(admin.id, 'publication.archive', 'publications', pubId, {}, env);

  try { await deactivateAnnonceForOffre_(offreId, env); }
  catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', offreId, { detail: e.message }, env); }
  return jsonResponseNoCache({ ok: true, statut: 'archive' });
}

// ============================================================================
//  PARTNER — Phase B
// ============================================================================

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
    statut: 'en_attente',
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
    statut: 'en_attente',
    date_expiration: dateExpiration,
    created_by: 'partenaire',
    metadata: body.metadata || {},
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
//  PUBLIC ENDPOINTS
// ============================================================================

async function handlePublicOffresList(queryParams, env) {
  const nowIso = new Date().toISOString();
  const filter =
    `statut=eq.publie` +
    `&or=(date_expiration.is.null,date_expiration.gt.${encodeURIComponent(nowIso)})` +
    `&select=id,titre,description,type_contrat,lieu,duree,salaire_indicatif,experience_requise,` +
    `url_externe,contact_nom,contact_email,contact_telephone,date_publication,metadata,` +
    `contrats(id,partenaires(raison_sociale,niveau))` +
    `&order=date_publication.desc&limit=100`;

  const rows = await supabaseQuery('offres_emploi', filter, env);

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
      partenaire_logo_url: meta.logo_b64 || null,
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
    meta: { version: 'V4.17-polish', generated_at: new Date().toISOString() },
  });
}

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

async function handlePublicCandidatureCreate(offreId, body, env, ctx) {
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

  fetch(`${env.SUPABASE_URL}/rest/v1/offres_emploi?id=eq.${offreId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({ candidatures_count: (offre.candidatures_count || 0) + 1 }),
  }).catch(() => {});

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

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(Promise.all([emailPartnerPromise, emailCandidatePromise]));
  } else {
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
//  RESEND EMAIL
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

function escEmail(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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

      <tr><td style="padding:30px 30px 24px;font-size:14px;line-height:1.65;color:#4A5568;">
        ${bodyContent}
      </td></tr>

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
//  CANDIDATURES — Sprint C.3
// ============================================================================

const CANDIDATURE_STATUTS = ['nouveau', 'vue', 'contactee', 'refusee', 'acceptee'];

async function handleAdminCandidaturesList(token, queryParams, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const statutFilter = queryParams.get('statut');
  const offreFilter  = queryParams.get('offre_id');

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

async function handleAdminCandidatureUpdateStatut(token, candidatureId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const newStatut = String(body.statut || '').trim();
  if (!CANDIDATURE_STATUTS.includes(newStatut)) {
    return jsonResponseNoCache({ error: `Statut invalide. Valeurs : ${CANDIDATURE_STATUTS.join(', ')}` }, 400);
  }

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

// ============================================================================
//  COMMUNICATIONS — Sprint D
// ============================================================================

const COM_TYPES = ['invitation', 'annonce'];
const COM_STATUTS = ['brouillon', 'publie', 'archive'];

async function handleAdminCommunicationsList(token, queryParams, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const typeFilter = queryParams.get('type');
  const statutFilter = queryParams.get('statut');

  let filters = [];
  if (typeFilter && COM_TYPES.includes(typeFilter)) filters.push(`type=eq.${typeFilter}`);
  if (statutFilter && COM_STATUTS.includes(statutFilter)) filters.push(`statut=eq.${statutFilter}`);
  const baseQuery = filters.join('&') + (filters.length ? '&' : '') +
    'select=*&order=created_at.desc&limit=200';

  const rows = await supabaseQuery('communications', baseQuery, env);

  const ids = (rows || []).map(r => r.id);
  let reponsesByCom = {};
  if (ids.length) {
    const inList = ids.map(id => `"${id}"`).join(',');
    const reps = await supabaseQuery('communication_reponses', `communication_id=in.(${inList})&select=communication_id,reponse,nb_personnes`, env);
    (reps || []).forEach(r => {
      if (!reponsesByCom[r.communication_id]) reponsesByCom[r.communication_id] = { present: 0, absent: 0, total_personnes: 0 };
      if (r.reponse === 'present') { reponsesByCom[r.communication_id].present++; reponsesByCom[r.communication_id].total_personnes += (r.nb_personnes || 1); }
      else if (r.reponse === 'absent') reponsesByCom[r.communication_id].absent++;
    });
  }

  const communications = (rows || []).map(c => ({
    id: c.id, type: c.type, titre: c.titre, message: c.message || '',
    categorie: c.categorie || '', data: c.data || {},
    statut: c.statut, date_publication: c.date_publication,
    created_at: c.created_at,
    reponses: reponsesByCom[c.id] || { present: 0, absent: 0, total_personnes: 0 },
  }));

  const allRows = await supabaseQuery('communications', 'select=type,statut', env);
  const stats = { invitation: { brouillon:0, publie:0, archive:0, total:0 }, annonce: { brouillon:0, publie:0, archive:0, total:0 } };
  (allRows || []).forEach(r => {
    if (!stats[r.type]) return;
    stats[r.type][r.statut] = (stats[r.type][r.statut] || 0) + 1;
    stats[r.type].total++;
  });

  return jsonResponseNoCache({ communications, stats });
}

async function handleAdminCommunicationDetail(token, comId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery('communications', `id=eq.${comId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Communication introuvable' }, 404);
  const c = rows[0];

  const reps = await supabaseQuery(
    'communication_reponses',
    `communication_id=eq.${comId}&select=*,contrats(id,partenaires(raison_sociale))&order=created_at.desc`,
    env
  );
  const reponses = (reps || []).map(r => ({
    id: r.id,
    contrat_id: r.contrat_id,
    partenaire_nom: r.contrats?.partenaires?.raison_sociale || '—',
    reponse: r.reponse,
    nb_personnes: r.nb_personnes || 1,
    commentaire: r.commentaire || '',
    created_at: r.created_at,
  }));

  const agg = { present: 0, absent: 0, total_personnes: 0 };
  reponses.forEach(r => {
    if (r.reponse === 'present') { agg.present++; agg.total_personnes += r.nb_personnes; }
    else if (r.reponse === 'absent') agg.absent++;
  });

  return jsonResponseNoCache({
    communication: {
      id: c.id, type: c.type, titre: c.titre, message: c.message || '',
      categorie: c.categorie || '', data: c.data || {},
      statut: c.statut, cible: c.cible, date_publication: c.date_publication,
      created_at: c.created_at, updated_at: c.updated_at,
    },
    reponses, agg,
  });
}

async function handleAdminCommunicationCreate(token, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const type = String(body.type || '').trim();
  if (!COM_TYPES.includes(type)) return jsonResponseNoCache({ error: 'type invalide', expected: COM_TYPES }, 400);
  const titre = String(body.titre || '').trim();
  if (!titre) return jsonResponseNoCache({ error: 'Titre obligatoire' }, 400);

  const insertData = {
    type, titre,
    message: body.message || null,
    categorie: body.categorie || null,
    data: body.data || {},
    statut: 'brouillon',
    cible: 'tous',
    created_by_admin_id: admin.id,
  };

  let created;
  try {
    const arr = await supabaseInsert_('communications', insertData, env);
    created = Array.isArray(arr) ? arr[0] : arr;
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500);
  }

  return jsonResponseNoCache({ ok: true, communication: created });
}

async function handleAdminCommunicationPublish(token, comId, env, ctx) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery('communications', `id=eq.${comId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Communication introuvable' }, 404);
  const com = rows[0];

  await supabasePatch_('communications', `id=eq.${comId}`, {
    statut: 'publie',
    date_publication: new Date().toISOString(),
  }, env);

  const emailJob = (async () => {
    try {
      const contrats = await supabaseQuery(
        'contrats',
        `select=id,partenaires(raison_sociale,representant,representant_email)&limit=200`,
        env
      );

      const seen = new Set();
      const recipients = [];
      let nbValid = 0, nbFallback = 0;
      (contrats || []).forEach(c => {
        const rawEmail = c.partenaires?.representant_email || '';
        const valid = rawEmail.includes('@');
        const email = valid ? rawEmail : EMAIL_FALLBACK_PARTNER;
        if (valid) nbValid++; else nbFallback++;
        if (seen.has(email)) return;
        seen.add(email);
        recipients.push({
          email,
          nom: c.partenaires?.representant || '',
          raison: c.partenaires?.raison_sociale || '',
        });
      });

      const isInvit = com.type === 'invitation';
      const subject = isInvit ? `Invitation — ${com.titre}` : `${com.titre}`;

      for (const r of recipients) {
        await sendEmailViaResend(env, {
          to: r.email,
          subject,
          html: isInvit ? renderEmailInvitation(com, r) : renderEmailAnnonce(com, r),
          replyTo: EMAIL_REPLY_TO_CLUB,
        });
      }
      console.log(`[Communication ${comId}] ${recipients.length} emails envoyés (${nbValid} valides, ${nbFallback} fallback)`);
    } catch (e) {
      console.error(`[Communication ${comId}] email job error:`, e.message);
    }
  })();

  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(emailJob);
  else await emailJob;

  try { await syncOffreToAnnonces_(offreId, env); }
  catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', offreId, { detail: e.message }, env); }
  return jsonResponseNoCache({ ok: true, statut: 'publie' });
}

async function handleAdminCommunicationArchive(token, comId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  await supabasePatch_('communications', `id=eq.${comId}`, { statut: 'archive' }, env);
  try { await deactivateAnnonceForOffre_(offreId, env); }
  catch (e) { await logAudit_(admin.id, 'offre.sync_error', 'offres_emploi', offreId, { detail: e.message }, env); }
  return jsonResponseNoCache({ ok: true, statut: 'archive' });
}

async function handlePartnerCommunicationsList(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const rows = await supabaseQuery(
    'communications',
    `statut=eq.publie&select=id,type,titre,message,categorie,data,date_publication,created_at&order=date_publication.desc&limit=100`,
    env
  );

  const myReps = await supabaseQuery(
    'communication_reponses',
    `contrat_id=eq.${partner.contrat_id}&select=communication_id,reponse,nb_personnes,commentaire`,
    env
  );
  const repByCom = {};
  (myReps || []).forEach(r => { repByCom[r.communication_id] = r; });

  const communications = (rows || []).map(c => ({
    ...c,
    ma_reponse: repByCom[c.id] || null,
  }));

  return jsonResponseNoCache({
    contrat_id: partner.contrat_id,
    communications,
    meta: { version: 'V4.13-comm', generated_at: new Date().toISOString() },
  });
}

async function handlePartnerCommunicationRsvp(token, comId, body, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const reponse = String(body.reponse || '').trim();
  if (!['present', 'absent'].includes(reponse)) {
    return jsonResponseNoCache({ error: 'reponse invalide (present|absent)' }, 400);
  }

  const comRows = await supabaseQuery('communications', `id=eq.${comId}&select=id,type,statut&limit=1`, env);
  if (!comRows || comRows.length === 0) return jsonResponseNoCache({ error: 'Communication introuvable' }, 404);
  if (comRows[0].type !== 'invitation') return jsonResponseNoCache({ error: 'Cette communication n\'attend pas de réponse' }, 400);

  let nb = parseInt(body.nb_personnes, 10);
  if (isNaN(nb) || nb < 0) nb = 1;
  if (reponse === 'absent') nb = 0;

  const payload = {
    communication_id: comId,
    contrat_id: partner.contrat_id,
    partenaire_id: partner.partenaire_id,
    reponse,
    nb_personnes: nb,
    commentaire: body.commentaire ? String(body.commentaire).trim().slice(0, 500) : null,
  };

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/communication_reponses?on_conflict=communication_id,contrat_id`, {
    method: 'POST',
    headers: { ...supabaseHeaders(env), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errTxt = await res.text();
    return jsonResponseNoCache({ error: 'Erreur RSVP', detail: errTxt }, 500);
  }
  const saved = await res.json();
  return jsonResponseNoCache({ ok: true, reponse: Array.isArray(saved) ? saved[0] : saved });
}

function renderEmailInvitation(com, recipient) {
  const d = com.data || {};
  const eyebrow = 'INVITATION';
  const greet = recipient.nom ? `Bonjour ${escEmail(recipient.nom.split(' ')[0])},` : 'Bonjour,';

  const infoRows = [];
  if (d.date_event) infoRows.push(`<tr><td style="padding:6px 0;font-size:13px;"><strong style="color:#0A1628;display:inline-block;width:90px;">Date</strong>${escEmail(d.date_event)}${d.heure ? ' · ' + escEmail(d.heure) : ''}</td></tr>`);
  if (d.lieu) infoRows.push(`<tr><td style="padding:6px 0;font-size:13px;"><strong style="color:#0A1628;display:inline-block;width:90px;">Lieu</strong>${escEmail(d.lieu)}</td></tr>`);
  if (d.deadline_rsvp) infoRows.push(`<tr><td style="padding:6px 0;font-size:13px;"><strong style="color:#0A1628;display:inline-block;width:90px;">Réponse avant</strong>${escEmail(d.deadline_rsvp)}</td></tr>`);

  const body = `
    <p style="margin:0 0 18px;font-size:14px;color:#4A5568;line-height:1.7;">${greet}</p>
    <p style="margin:0 0 22px;font-size:14px;color:#4A5568;line-height:1.7;">Le Spacer's Business Club a le plaisir de vous convier à l'événement suivant :</p>
    ${com.message ? `<p style="margin:0 0 20px;font-size:14px;color:#0A1628;line-height:1.7;white-space:pre-wrap;">${escEmail(com.message)}</p>` : ''}
    ${infoRows.length ? `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#FAF7F2;border-radius:10px;border:1px solid #E5DED1;padding:6px 16px;margin-bottom:20px;">${infoRows.join('')}</table>` : ''}
    <p style="margin:22px 0 0;font-size:13px;color:#8A8478;line-height:1.7;font-style:italic;">Merci de confirmer votre présence depuis votre espace partenaire.</p>
  `;
  return emailLayout(eyebrow, com.titre, '', body);
}

function renderEmailAnnonce(com, recipient) {
  const greet = recipient.nom ? `Bonjour ${escEmail(recipient.nom.split(' ')[0])},` : 'Bonjour,';
  const body = `
    <p style="margin:0 0 18px;font-size:14px;color:#4A5568;line-height:1.7;">${greet}</p>
    ${com.message ? `<p style="margin:0 0 20px;font-size:14px;color:#0A1628;line-height:1.7;white-space:pre-wrap;">${escEmail(com.message)}</p>` : ''}
    <p style="margin:22px 0 0;font-size:13px;color:#8A8478;line-height:1.7;font-style:italic;">Retrouvez toutes les actualités du club dans votre espace partenaire.</p>
  `;
  return emailLayout('ACTUALITÉ', com.titre, '', body);
}

// ============================================================================
//  CONTACTS PARTENAIRES — Sprint E.2
// ============================================================================

const CONTACT_STATUTS = ['a_inviter', 'invite', 'active', 'inactif'];

async function handleAdminPartenairesList(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const partenaires = await supabaseQuery(
    'partenaires',
    'select=id,siren,raison_sociale,representant,representant_email,tickie_customer_id&order=raison_sociale.asc&limit=500',
    env
  );

  const contacts = await supabaseQuery(
    'partenaire_contacts',
    'select=partenaire_id,statut',
    env
  );
  const statsByPartenaire = {};
  (contacts || []).forEach(c => {
    if (!statsByPartenaire[c.partenaire_id]) statsByPartenaire[c.partenaire_id] = { total: 0, a_inviter: 0, invite: 0, active: 0, inactif: 0 };
    statsByPartenaire[c.partenaire_id].total++;
    statsByPartenaire[c.partenaire_id][c.statut] = (statsByPartenaire[c.partenaire_id][c.statut] || 0) + 1;
  });

  const result = (partenaires || []).map(p => ({
    id: p.id,
    siren: p.siren,
    raison_sociale: p.raison_sociale,
    representant: p.representant || '',
    representant_email: p.representant_email || '',
    tickie_customer_id: p.tickie_customer_id || null,
    contacts_stats: statsByPartenaire[p.id] || { total: 0, a_inviter: 0, invite: 0, active: 0, inactif: 0 },
  }));

  return jsonResponseNoCache({
    partenaires: result,
    meta: { version: 'V4.17-polish', generated_at: new Date().toISOString() },
  });
}

async function handleAdminPartenaireFicheGet(token, partenaireId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('partenaires',
    `id=eq.${partenaireId}&select=id,raison_sociale,siren,siret,secteur,adresse,code_postal,ville,site_web,email_societe,logo_b64,niveau,type_partenariat,representant,representant_fonction,representant_email,representant_tel,representant_photo_b64&limit=1`,
    env);
  if (!rows || !rows.length) return jsonResponseNoCache({ error: 'Partenaire introuvable' }, 404);
  return jsonResponseNoCache({ fiche: rows[0] });
}

async function handleAdminPartenaireFicheUpdate(token, partenaireId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const str = (v, max) => { const s = (v == null ? '' : String(v)).trim(); return s ? s.slice(0, max || 300) : null; };
  const patch = {
    secteur: str(body.secteur, 120),
    adresse: str(body.adresse, 300),
    code_postal: str(body.code_postal, 20),
    ville: str(body.ville, 120),
    site_web: str(body.site_web, 300),
    email_societe: str(body.email_societe, 200),
    siret: str(body.siret, 20),
    siren: str(body.siren, 20),
    type_partenariat: str(body.type_partenariat, 60),
    representant: str(body.representant, 160),
    representant_fonction: str(body.representant_fonction, 160),
    representant_email: str(body.representant_email, 200),
    representant_tel: str(body.representant_tel, 40),
  };
  // l'admin peut corriger la raison sociale (mais on n'efface pas si vide)
  const rs = str(body.raison_sociale, 200);
  if (rs) patch.raison_sociale = rs;
  if (body.logo_b64 !== undefined) patch.logo_b64 = body.logo_b64 ? String(body.logo_b64).slice(0, 1500000) : null;
  if (body.representant_photo_b64 !== undefined) patch.representant_photo_b64 = body.representant_photo_b64 ? String(body.representant_photo_b64).slice(0, 1500000) : null;
  try {
    await supabasePatch_('partenaires', `id=eq.${partenaireId}`, patch, env);
    logAudit_(admin.id, 'partenaire.fiche.update', 'partenaires', partenaireId, {}, env);
    return jsonResponseNoCache({ ok: true });
  } catch (e) { return jsonResponseNoCache({ error: 'Erreur mise à jour', detail: e.message }, 500); }
}

async function handleAdminContactsList(token, partenaireId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const pRows = await supabaseQuery('partenaires', `id=eq.${partenaireId}&select=id,raison_sociale&limit=1`, env);
  if (!pRows || pRows.length === 0) return jsonResponseNoCache({ error: 'Partenaire introuvable' }, 404);

  const contacts = await supabaseQuery(
    'partenaire_contacts',
    `partenaire_id=eq.${partenaireId}&select=*&order=created_at.asc&limit=50`,
    env
  );

  return jsonResponseNoCache({
    partenaire: pRows[0],
    contacts: contacts || [],
  });
}

async function handleAdminContactCreate(token, partenaireId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const nom = String(body.nom || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (!nom) return jsonResponseNoCache({ error: 'Le nom est obligatoire' }, 400);
  if (!email || !email.includes('@')) return jsonResponseNoCache({ error: 'Email invalide' }, 400);

  const pRows = await supabaseQuery('partenaires', `id=eq.${partenaireId}&select=id&limit=1`, env);
  if (!pRows || pRows.length === 0) return jsonResponseNoCache({ error: 'Partenaire introuvable' }, 404);

  const existing = await supabaseQuery('partenaire_contacts', `email=ilike.${encodeURIComponent(email)}&select=id&limit=1`, env);
  if (existing && existing.length > 0) {
    return jsonResponseNoCache({ error: 'Un contact avec cet email existe déjà' }, 400);
  }

  const insertData = {
    partenaire_id: partenaireId,
    nom,
    prenom: body.prenom ? String(body.prenom).trim() : null,
    email,
    telephone: body.telephone ? String(body.telephone).trim() : null,
    fonction: body.fonction ? String(body.fonction).trim() : null,
    statut: 'a_inviter',
    created_by_admin_id: admin.id,
  };

  try {
    const arr = await supabaseInsert_('partenaire_contacts', insertData, env);
    const created = Array.isArray(arr) ? arr[0] : arr;
    return jsonResponseNoCache({ ok: true, contact: created });
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création contact', detail: e.message }, 500);
  }
}

async function handleAdminContactUpdate(token, contactId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const payload = {};
  if (body.nom !== undefined) payload.nom = String(body.nom).trim();
  if (body.prenom !== undefined) payload.prenom = body.prenom ? String(body.prenom).trim() : null;
  if (body.telephone !== undefined) payload.telephone = body.telephone ? String(body.telephone).trim() : null;
  if (body.fonction !== undefined) payload.fonction = body.fonction ? String(body.fonction).trim() : null;
  if (body.statut !== undefined && CONTACT_STATUTS.includes(body.statut)) payload.statut = body.statut;

  if (Object.keys(payload).length === 0) return jsonResponseNoCache({ error: 'Rien à modifier' }, 400);

  try {
    await supabasePatch_('partenaire_contacts', `id=eq.${contactId}`, payload, env);
    return jsonResponseNoCache({ ok: true });
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur modification', detail: e.message }, 500);
  }
}

async function handleAdminContactDelete(token, contactId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery('partenaire_contacts', `id=eq.${contactId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Contact introuvable' }, 404);
  const contact = rows[0];

  if (contact.auth_user_id) {
    try {
      await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${contact.auth_user_id}`, {
        method: 'DELETE',
        headers: supabaseHeaders(env),
      });
    } catch (e) {
      console.warn(`[Contact ${contactId}] auth.user delete failed:`, e.message);
    }
  }

  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/partenaire_contacts?id=eq.${contactId}`, {
      method: 'DELETE',
      headers: supabaseHeaders(env),
    });
    return jsonResponseNoCache({ ok: true });
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur suppression', detail: e.message }, 500);
  }
}

async function handleAdminContactInvite(token, contactId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery(
    'partenaire_contacts',
    `id=eq.${contactId}&select=*,partenaires(raison_sociale)&limit=1`,
    env
  );
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Contact introuvable' }, 404);
  const contact = rows[0];

  if (contact.statut === 'active') {
    return jsonResponseNoCache({ error: 'Ce contact a déjà un compte actif. Pour réinviter, utilise le reset password.' }, 400);
  }

  const redirectTo = encodeURIComponent('https://business.spacerstoulouse.fr/activate');
  const inviteUrl = `${env.SUPABASE_URL}/auth/v1/invite?redirect_to=${redirectTo}`;
  const inviteBody = {
    email: contact.email,
    data: {
      contact_id: contact.id,
      partenaire_id: contact.partenaire_id,
      raison_sociale: contact.partenaires?.raison_sociale || '',
      nom: contact.nom,
      prenom: contact.prenom || '',
    },
  };

  let inviteRes;
  try {
    inviteRes = await fetch(inviteUrl, {
      method: 'POST',
      headers: { ...supabaseHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(inviteBody),
    });
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur réseau Supabase', detail: e.message }, 502);
  }

  if (!inviteRes.ok) {
    const errTxt = await inviteRes.text();
    let errMsg = errTxt;
    try { const errJson = JSON.parse(errTxt); errMsg = errJson.msg || errJson.message || errJson.error_description || errTxt; } catch {}
    if (inviteRes.status === 422 || /already.*registered|exists/i.test(errMsg)) {
      return jsonResponseNoCache({ error: 'Cet email a déjà un compte Auth associé. Utilise la fonction reset password.', detail: errMsg }, 409);
    }
    return jsonResponseNoCache({ error: 'Erreur Supabase Auth', detail: errMsg }, inviteRes.status);
  }

  const inviteJson = await inviteRes.json();
  const authUserId = inviteJson.id || inviteJson.user?.id;
  if (!authUserId) {
    return jsonResponseNoCache({ error: 'Réponse Auth inattendue (id manquant)', detail: JSON.stringify(inviteJson).slice(0, 200) }, 500);
  }

  try {
    await supabasePatch_('partenaire_contacts', `id=eq.${contactId}`, {
      auth_user_id: authUserId,
      statut: 'invite',
      invitation_envoyee_at: new Date().toISOString(),
    }, env);
  } catch (e) {
    return jsonResponseNoCache({ error: 'Invitation envoyée mais MAJ contact échouée', detail: e.message }, 500);
  }

  return jsonResponseNoCache({
    ok: true,
    message: `Invitation envoyée à ${contact.email}`,
    auth_user_id: authUserId,
  });
}

// ============================================================================
//  AUTH PARTENAIRE — Sprint E.4
// ============================================================================

async function handleAuthConfig(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponseNoCache({
      error: 'Configuration manquante',
      detail: 'Add SUPABASE_ANON_KEY in Worker Settings → Variables',
    }, 500);
  }
  return jsonResponseNoCache({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
  });
}

async function verifySupabaseSession_(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const accessToken = m[1].trim();
  if (!accessToken) return null;

  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function handlePartnerBySession(request, env) {
  const user = await verifySupabaseSession_(request, env);
  if (!user || !user.id) return jsonResponseNoCache({ error: 'Session invalide' }, 401);

  const contacts = await supabaseQuery(
    'partenaire_contacts',
    `auth_user_id=eq.${user.id}&select=id,partenaire_id&limit=1`,
    env
  );
  if (!contacts || contacts.length === 0) {
    return jsonResponseNoCache({ error: 'Contact partenaire introuvable. Contactez le Spacer\'s Business Club.' }, 404);
  }
  const contact = contacts[0];

  const rows = await supabaseQuery(
    'contrats',
    `partenaire_id=eq.${contact.partenaire_id}` +
    `&select=*,partenaire:partenaires(*),prestations(*),packs_places(*)` +
    `&order=saison.desc&limit=1`,
    env
  );
  if (!rows || rows.length === 0) {
    return jsonResponseNoCache({ error: 'Aucun contrat actif pour votre société.' }, 404);
  }

  try {
    await supabasePatch_('partenaire_contacts', `id=eq.${contact.id}`, {
      derniere_connexion_at: new Date().toISOString(),
    }, env);
  } catch (_) {}

  // En mode session, le partenaire n'a pas de magic_token dans l'URL : on s'assure
  // que le contrat en possède un (généré au besoin) pour que les endpoints d'écriture
  // partenaire (/api/partner/:token/...) fonctionnent aussi en mode session.
  if (!rows[0].magic_token) {
    const newTok = (crypto.randomUUID && crypto.randomUUID().replace(/-/g, '')) ||
      (Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    try {
      await supabasePatch_('contrats', `id=eq.${rows[0].id}`, { magic_token: newTok }, env);
      rows[0].magic_token = newTok;
    } catch (_) {}
  }

  const dashboard = _buildPartnerDashboard(rows[0]);
  dashboard.auth_mode = 'session';
  dashboard.contact = { email: user.email || '' };
  return jsonResponseNoCache(dashboard);
}

async function handlePartnerConfirmActivation(request, env) {
  const user = await verifySupabaseSession_(request, env);
  if (!user || !user.id) return jsonResponseNoCache({ error: 'Session invalide' }, 401);

  const contacts = await supabaseQuery(
    'partenaire_contacts',
    `auth_user_id=eq.${user.id}&select=id,statut&limit=1`,
    env
  );
  if (!contacts || contacts.length === 0) {
    if (user.email) {
      const byEmail = await supabaseQuery(
        'partenaire_contacts',
        `email=ilike.${encodeURIComponent(user.email)}&select=id&limit=1`,
        env
      );
      if (byEmail && byEmail[0]) {
        await supabasePatch_('partenaire_contacts', `id=eq.${byEmail[0].id}`, {
          auth_user_id: user.id,
          statut: 'active',
          derniere_connexion_at: new Date().toISOString(),
        }, env);
        return jsonResponseNoCache({ ok: true, linked_by_email: true });
      }
    }
    return jsonResponseNoCache({ error: 'Contact introuvable' }, 404);
  }

  await supabasePatch_('partenaire_contacts', `id=eq.${contacts[0].id}`, {
    statut: 'active',
    derniere_connexion_at: new Date().toISOString(),
  }, env);

  return jsonResponseNoCache({ ok: true });
}

// ============================================================================
//  COMPTE UNIFIÉ — Sprint G
// ============================================================================

async function handleMeRoles(request, env) {
  const user = await verifySupabaseSession_(request, env);
  if (!user || !user.id) return jsonResponseNoCache({ error: 'Session invalide' }, 401);

  const userEmail = (user.email || '').toLowerCase();
  let isAdmin = false;
  let adminToken = null;

  let admins = await supabaseQuery(
    'admins',
    `auth_user_id=eq.${user.id}&select=id,magic_token,email&limit=1`,
    env
  );

  if ((!admins || admins.length === 0) && userEmail) {
    admins = await supabaseQuery(
      'admins',
      `email=ilike.${encodeURIComponent(userEmail)}&select=id,magic_token,email,auth_user_id&limit=1`,
      env
    );
    if (admins && admins.length > 0 && !admins[0].auth_user_id) {
      try {
        await supabasePatch_('admins', `id=eq.${admins[0].id}`, { auth_user_id: user.id }, env);
      } catch (_) {}
    }
  }

  if (admins && admins.length > 0) {
    isAdmin = true;
    adminToken = admins[0].magic_token;
  }

  const contacts = await supabaseQuery(
    'partenaire_contacts',
    `auth_user_id=eq.${user.id}&select=id,prenom,nom,partenaire_id,derniere_connexion_at,partenaires(raison_sociale)&limit=1`,
    env
  );

  let isPartner = false, partenaireId = null, raisonSociale = null, contactId = null, prenom = null, nom = null, derniereConnexion = null;
  if (contacts && contacts.length > 0) {
    const c = contacts[0];
    isPartner = true;
    partenaireId = c.partenaire_id;
    raisonSociale = c.partenaires?.raison_sociale || null;
    contactId = c.id;
    prenom = c.prenom;
    nom = c.nom;
    derniereConnexion = c.derniere_connexion_at;
  }

  return jsonResponseNoCache({
    is_admin: isAdmin,
    admin_token: adminToken,
    is_partner: isPartner,
    partenaire_id: partenaireId,
    raison_sociale: raisonSociale,
    contact_id: contactId,
    email: user.email,
    prenom,
    nom,
    derniere_connexion_at: derniereConnexion,
  });
}

// ============================================================================
//  MAILS — campagnes email aux partenaires (Sprint Mails)
//  Provider : Resend (réutilise sendEmailViaResend + emailLayout).
//  Destinataires v1 : tous les partenaire_contacts valides, hors désinscrits.
// ============================================================================

async function unsubKey_(email) {
  const data = new TextEncoder().encode(UNSUB_SALT + ':' + String(email).toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

async function unsubLink_(email) {
  const k = await unsubKey_(email);
  return `${PUBLIC_BASE_URL}/desinscription?e=${encodeURIComponent(email)}&k=${k}`;
}

function _mailFrom(mail) {
  const nom = (mail.expediteur_nom || 'Le Spacer\'s Business Club').replace(/[<>]/g, '');
  return `${nom} <${MAIL_SENDER_EMAIL}>`;
}

async function handleAdminMailsList(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery('mails', 'select=*&order=created_at.desc&limit=200', env);
  const mails = (rows || []).map(m => ({
    id: m.id, sujet: m.sujet, pre_header: m.pre_header || '', titre: m.titre || '',
    statut: m.statut, nb_destinataires: m.nb_destinataires || 0,
    envoye_le: m.envoye_le, cree_par_nom: m.cree_par_nom || '', created_at: m.created_at,
  }));
  const stats = { brouillon: 0, valide: 0, envoye: 0, total: 0 };
  mails.forEach(m => { stats[m.statut] = (stats[m.statut] || 0) + 1; stats.total++; });
  return jsonResponseNoCache({ mails, stats });
}

async function handleAdminMailDetail(token, mailId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('mails', `id=eq.${mailId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Mail introuvable' }, 404);
  const contacts = await supabaseQuery('partenaire_contacts', 'select=email,statut&limit=1000', env);
  const validCount = (contacts || []).filter(c => c.email && c.email.includes('@') && c.statut !== 'inactif').length;
  return jsonResponseNoCache({ mail: rows[0], destinataires_count: validCount });
}

async function handleAdminMailCreate(token, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const sujet = String(body.sujet || '').trim();
  if (!sujet) return jsonResponseNoCache({ error: 'Le sujet est obligatoire' }, 400);

  let email = '';
  try {
    const a = await supabaseQuery('admins', `magic_token=eq.${token}&select=email&limit=1`, env);
    if (a && a[0]) email = a[0].email || '';
  } catch (_) {}

  const insertData = {
    sujet,
    pre_header: body.pre_header || null,
    expediteur_nom: body.expediteur_nom || 'Le Spacer\'s Business Club',
    titre: body.titre || null,
    corps: body.corps || null,
    image_url: body.image_url || null,
    bouton_label: body.bouton_label || null,
    bouton_url: body.bouton_url || null,
    blocks: Array.isArray(body.blocks) ? body.blocks : [],
    destinataires_type: 'partenaires',
    statut: 'brouillon',
    cree_par_admin_id: admin.id,
    cree_par_nom: `${admin.prenom || ''} ${admin.nom || ''}`.trim() || null,
    cree_par_email: email || null,
  };
  try {
    const arr = await supabaseInsert_('mails', insertData, env);
    const created = Array.isArray(arr) ? arr[0] : arr;
    logAudit_(admin.id, 'mail.create', 'mails', created.id, { sujet }, env);
    return jsonResponseNoCache({ ok: true, mail: created });
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500);
  }
}

async function handleAdminMailUpdate(token, mailId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const cur = await supabaseQuery('mails', `id=eq.${mailId}&select=statut&limit=1`, env);
  if (!cur || cur.length === 0) return jsonResponseNoCache({ error: 'Mail introuvable' }, 404);
  if (cur[0].statut === 'envoye') return jsonResponseNoCache({ error: 'Mail déjà envoyé, non modifiable' }, 400);

  const allowed = ['sujet','pre_header','expediteur_nom','titre','corps','image_url','bouton_label','bouton_url'];
  const patch = {};
  for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k] || null;
  if (body.blocks !== undefined) patch.blocks = Array.isArray(body.blocks) ? body.blocks : [];
  patch.statut = 'brouillon';
  patch.updated_at = new Date().toISOString();

  try {
    await supabasePatch_('mails', `id=eq.${mailId}`, patch, env);
    return jsonResponseNoCache({ ok: true });
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur update', detail: e.message }, 500);
  }
}

async function handleAdminMailValidate(token, mailId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('mails', `id=eq.${mailId}&select=statut&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Mail introuvable' }, 404);
  if (rows[0].statut === 'envoye') return jsonResponseNoCache({ error: 'Mail déjà envoyé' }, 400);
  await supabasePatch_('mails', `id=eq.${mailId}`, { statut: 'valide', updated_at: new Date().toISOString() }, env);
  logAudit_(admin.id, 'mail.validate', 'mails', mailId, {}, env);
  return jsonResponseNoCache({ ok: true, statut: 'valide' });
}

async function handleAdminMailTest(token, mailId, env, ctx) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('mails', `id=eq.${mailId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Mail introuvable' }, 404);
  const mail = rows[0];

  let toEmail = mail.cree_par_email || '';
  if (!toEmail) {
    const a = await supabaseQuery('admins', `magic_token=eq.${token}&select=email&limit=1`, env);
    if (a && a[0]) toEmail = a[0].email || '';
  }
  if (!toEmail || !toEmail.includes('@')) return jsonResponseNoCache({ error: 'Aucune adresse de test disponible' }, 400);

  const unsub = await unsubLink_(toEmail);
  const job = sendEmailViaResend(env, {
    to: toEmail, from: _mailFrom(mail), subject: `[TEST] ${mail.sujet}`,
    html: renderEmailMail(mail, { nom: admin.prenom || '' }, unsub),
    replyTo: mail.cree_par_email || EMAIL_REPLY_TO_CLUB,
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job); else await job;
  return jsonResponseNoCache({ ok: true, sent_to: toEmail });
}

async function handleAdminMailSend(token, mailId, env, ctx) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('mails', `id=eq.${mailId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Mail introuvable' }, 404);
  const mail = rows[0];
  if (mail.statut === 'envoye') return jsonResponseNoCache({ error: 'Ce mail a déjà été envoyé' }, 400);
  if (mail.statut !== 'valide') return jsonResponseNoCache({ error: 'Le mail doit être validé avant envoi' }, 400);

  const contacts = await supabaseQuery('partenaire_contacts', 'select=email,nom,prenom,statut&limit=1000', env);
  const unsubs = await supabaseQuery('mail_desinscriptions', 'select=email&limit=2000', env);
  const blocked = new Set((unsubs || []).map(u => (u.email || '').toLowerCase()));

  const seen = new Set();
  const recipients = [];
  (contacts || []).forEach(c => {
    const email = (c.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || c.statut === 'inactif') return;
    if (blocked.has(email) || seen.has(email)) return;
    seen.add(email);
    recipients.push({ email, nom: c.nom || '', prenom: c.prenom || '' });
  });
  if (recipients.length === 0) return jsonResponseNoCache({ error: 'Aucun destinataire valide (liste vide ou tous désinscrits)' }, 400);

  const from = _mailFrom(mail);
  const replyTo = mail.cree_par_email || EMAIL_REPLY_TO_CLUB;

  const job = (async () => {
    let ok = 0, fail = 0;
    for (const r of recipients) {
      try {
        const unsub = await unsubLink_(r.email);
        const res = await sendEmailViaResend(env, { to: r.email, from, subject: mail.sujet, html: renderEmailMail(mail, r, unsub), replyTo });
        if (res && res.ok) ok++; else fail++;
      } catch (_) { fail++; }
      await new Promise(rs => setTimeout(rs, 120));
    }
    console.log(`[Mail ${mailId}] ${ok} OK / ${fail} échecs / ${recipients.length}`);
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job); else await job;

  await supabasePatch_('mails', `id=eq.${mailId}`, {
    statut: 'envoye', envoye_le: new Date().toISOString(),
    nb_destinataires: recipients.length, updated_at: new Date().toISOString(),
  }, env);
  logAudit_(admin.id, 'mail.send', 'mails', mailId, { nb: recipients.length }, env);
  return jsonResponseNoCache({ ok: true, statut: 'envoye', nb_destinataires: recipients.length });
}

function renderEmailMail(mail, recipient, unsubUrl) {
  // Mode blocs (nouveau) : si le mail contient des blocs, on rend la version modulaire
  let blocks = mail.blocks;
  if (typeof blocks === 'string') { try { blocks = JSON.parse(blocks); } catch { blocks = []; } }
  if (Array.isArray(blocks) && blocks.length > 0) {
    return emailShellBlocks(mail, renderBlocksToHtml(blocks), unsubUrl);
  }

  // Mode simple (repli / ancien) — comportement historique inchangé
  const titre = mail.titre || mail.sujet || '';
  let body = '';
  if (mail.image_url) body += `<img src="${escEmail(mail.image_url)}" alt="" width="540" style="display:block;width:100%;max-width:540px;height:auto;border-radius:10px;margin:0 0 22px;" />`;
  if (mail.corps)     body += `<div style="font-size:14px;color:#4A5568;line-height:1.7;white-space:pre-wrap;margin:0 0 22px;">${escEmail(mail.corps)}</div>`;
  if (mail.bouton_label && mail.bouton_url) {
    body += `<table cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 8px;"><tr>
      <td style="background:#C8932B;border-radius:999px;">
        <a href="${escEmail(mail.bouton_url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:bold;color:#0A1628;text-decoration:none;">${escEmail(mail.bouton_label)}</a>
      </td></tr></table>`;
  }
  body += `<div style="margin-top:26px;padding-top:16px;border-top:1px solid #E5DED1;font-size:11px;color:#8A8478;line-height:1.6;">
      Vous recevez cet email en tant que partenaire du Spacer's Business Club.
      ${unsubUrl ? `<a href="${escEmail(unsubUrl)}" style="color:#8A8478;text-decoration:underline;">Se désinscrire</a>.` : ''}
    </div>`;
  return emailLayout('LE BUSINESS CLUB', titre, mail.pre_header || '', body);
}

// ============================================================================
//  MAILS — moteur de rendu BLOCS -> HTML email-safe
//  Chaque bloc se rend en <table width=100%> autonome (gère son propre padding).
// ============================================================================
function _mailAlign(a) { return (a === 'center' || a === 'right' || a === 'left') ? a : 'left'; }
function _nl2br(s) { return escEmail(s).replace(/\r?\n/g, '<br/>'); }

function renderBlockImageTag(url, alt, width) {
  if (!url) return '';
  return `<img src="${escEmail(url)}" alt="${escEmail(alt || '')}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;border-radius:8px;" />`;
}

function renderOneBlock(b, ctx) {
  if (!b || !b.type) return '';
  const type = b.type;
  const wrap = (inner, pad) => `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="${pad}">${inner}</td></tr></table>`;
  const SIDE = 'padding:6px 30px;'; // padding latéral standard pour le contenu texte

  switch (type) {
    case 'entete': {
      const marque = (b.marque != null ? b.marque : "SPACER'S BUSINESS CLUB");
      const sousMarque = (b.sous_marque != null ? b.sous_marque : 'Toulouse Volley · Saison 2026–2027');
      const logoCell = b.logo_url
        ? `<td style="vertical-align:middle;"><img src="${escEmail(b.logo_url)}" alt="" height="46" style="display:block;height:46px;max-height:46px;width:auto;max-width:180px;border:0;" /></td>`
        : `<td style="width:48px;vertical-align:top;"><div style="background:#C8932B;color:#0A1628;width:42px;height:42px;border-radius:10px;text-align:center;line-height:42px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;">S</div></td>`;
      const textCell = (marque || sousMarque)
        ? `<td style="padding-left:14px;vertical-align:middle;">${marque ? `<div style="color:#E8C977;font-size:10px;font-weight:bold;letter-spacing:2px;line-height:1;">${escEmail(marque)}</div>` : ''}${sousMarque ? `<div style="color:rgba(255,255,255,0.55);font-size:11px;margin-top:4px;">${escEmail(sousMarque)}</div>` : ''}</td>`
        : '';
      const eyebrow = b.eyebrow ? `<div style="color:#C8932B;font-size:10px;font-weight:bold;letter-spacing:2px;margin-bottom:8px;">${escEmail(b.eyebrow)}</div>` : '';
      const titrePrincipal = b.titre ? `<div style="color:#FFFFFF;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.15;font-weight:500;">${escEmail(b.titre)}</div>` : '';
      const sousTitre = b.sous_titre ? `<div style="color:rgba(255,255,255,0.55);font-size:13px;margin-top:6px;">${escEmail(b.sous_titre)}</div>` : '';
      const bloc = (eyebrow || titrePrincipal || sousTitre) ? `<div style="margin-top:20px;">${eyebrow}${titrePrincipal}${sousTitre}</div>` : '';
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="background:#11203a;background-image:linear-gradient(135deg,#11203a 0%,#0A1628 100%);padding:26px 30px;">
        <table cellpadding="0" cellspacing="0" border="0"><tr>${logoCell}${textCell}</tr></table>${bloc}
      </td></tr></table>`;
    }
    case 'titre': {
      const align = _mailAlign(b.align);
      return wrap(`<div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.25;font-weight:500;color:#0A1628;text-align:${align};margin:6px 0;">${escEmail(b.text || '')}</div>`, SIDE);
    }
    case 'paragraphe': {
      const align = _mailAlign(b.align);
      return wrap(`<div style="font-size:14px;line-height:1.7;color:#4A5568;text-align:${align};">${_nl2br(b.text || '')}</div>`, SIDE);
    }
    case 'image': {
      const img = renderBlockImageTag(b.url, b.alt, 540);
      if (!img) return '';
      const inner = b.link ? `<a href="${escEmail(b.link)}" target="_blank" style="text-decoration:none;">${img}</a>` : img;
      return wrap(inner, 'padding:8px 30px;');
    }
    case 'banniere': {
      if (!b.url) return '';
      const img = `<img src="${escEmail(b.url)}" alt="${escEmail(b.alt || '')}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;" />`;
      const inner = b.link ? `<a href="${escEmail(b.link)}" target="_blank" style="text-decoration:none;">${img}</a>` : img;
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:0;font-size:0;line-height:0;">${inner}</td></tr></table>`;
    }
    case 'bouton': {
      if (!b.label || !b.url) return '';
      const align = _mailAlign(b.align || 'left');
      return wrap(`<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="${align}" style="margin:${align === 'center' ? '0 auto' : '0'};"><tr>
        <td style="background:#C8932B;border-radius:999px;"><a href="${escEmail(b.url)}" target="_blank" style="display:inline-block;padding:13px 28px;font-size:14px;font-weight:bold;color:#0A1628;text-decoration:none;">${escEmail(b.label)}</a></td>
      </tr></table>`, `padding:10px 30px;text-align:${align};`);
    }
    case 'separateur':
      return wrap(`<div style="border-top:1px solid #E5DED1;font-size:0;line-height:0;">&nbsp;</div>`, 'padding:12px 30px;');
    case 'deux_colonnes_texte': {
      return wrap(`<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>
        <td width="50%" valign="top" style="padding-right:10px;font-size:14px;line-height:1.7;color:#4A5568;">${_nl2br(b.gauche || '')}</td>
        <td width="50%" valign="top" style="padding-left:10px;font-size:14px;line-height:1.7;color:#4A5568;">${_nl2br(b.droite || '')}</td>
      </tr></table>`, SIDE);
    }
    case 'deux_colonnes_image': {
      const g = renderBlockImageTag(b.img_gauche, b.alt_gauche, 260);
      const d = renderBlockImageTag(b.img_droite, b.alt_droite, 260);
      const cell = (img, link, padSide) => `<td width="50%" valign="top" style="${padSide}">${link && img ? `<a href="${escEmail(link)}" target="_blank">${img}</a>` : img}</td>`;
      return wrap(`<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>${cell(g, b.link_gauche, 'padding-right:8px;')}${cell(d, b.link_droite, 'padding-left:8px;')}</tr></table>`, 'padding:8px 30px;');
    }
    case 'image_texte': {
      const img = renderBlockImageTag(b.url, b.alt, 220);
      const imgCell = b.link && img ? `<a href="${escEmail(b.link)}" target="_blank">${img}</a>` : img;
      return wrap(`<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>
        <td width="40%" valign="top" style="padding-right:14px;">${imgCell}</td>
        <td width="60%" valign="top" style="font-size:14px;line-height:1.7;color:#4A5568;">${_nl2br(b.text || '')}</td>
      </tr></table>`, SIDE);
    }
    case 'texte_image': {
      const img = renderBlockImageTag(b.url, b.alt, 220);
      const imgCell = b.link && img ? `<a href="${escEmail(b.link)}" target="_blank">${img}</a>` : img;
      return wrap(`<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>
        <td width="60%" valign="top" style="font-size:14px;line-height:1.7;color:#4A5568;padding-right:14px;">${_nl2br(b.text || '')}</td>
        <td width="40%" valign="top">${imgCell}</td>
      </tr></table>`, SIDE);
    }
    case 'menu': {
      const items = Array.isArray(b.items) ? b.items.filter(i => i && i.label) : [];
      if (!items.length) return '';
      const links = items.map(i => `<a href="${escEmail(i.url || '#')}" target="_blank" style="color:#0A1628;text-decoration:none;font-size:13px;font-weight:600;padding:0 10px;">${escEmail(i.label)}</a>`).join('<span style="color:#C8932B;">·</span>');
      return wrap(`<div style="text-align:center;">${links}</div>`, 'padding:10px 30px;');
    }
    case 'reseaux': {
      const parts = [];
      if (b.instagram) parts.push(`<a href="${escEmail(b.instagram)}" target="_blank" style="color:#C8932B;text-decoration:none;font-size:12px;font-weight:600;padding:0 8px;">Instagram</a>`);
      if (b.linkedin)  parts.push(`<a href="${escEmail(b.linkedin)}" target="_blank" style="color:#C8932B;text-decoration:none;font-size:12px;font-weight:600;padding:0 8px;">LinkedIn</a>`);
      if (b.facebook)  parts.push(`<a href="${escEmail(b.facebook)}" target="_blank" style="color:#C8932B;text-decoration:none;font-size:12px;font-weight:600;padding:0 8px;">Facebook</a>`);
      if (b.site)      parts.push(`<a href="${escEmail(b.site)}" target="_blank" style="color:#C8932B;text-decoration:none;font-size:12px;font-weight:600;padding:0 8px;">Site web</a>`);
      if (!parts.length) return '';
      return wrap(`<div style="text-align:center;">${parts.join('<span style="color:#E5DED1;">|</span>')}</div>`, 'padding:10px 30px;');
    }
    case 'adresse':
      return wrap(`<div style="text-align:center;font-size:11px;color:#8A8478;line-height:1.6;">${_nl2br(b.text || "Spacer's Toulouse Volley · Palais des Sports André Brouat")}</div>`, 'padding:10px 30px;');
    case 'pied': {
      const logo = b.logo_url ? `<img src="${escEmail(b.logo_url)}" alt="" height="40" style="display:inline-block;height:40px;max-height:40px;width:auto;max-width:170px;border:0;margin-bottom:10px;" /><br/>` : '';
      const ligne1 = escEmail(b.ligne1 || "Spacer's Toulouse Volley · Palais des Sports André Brouat");
      const site = b.site ? `<a href="${escEmail(b.site_url || 'https://spacerstoulouse.fr')}" style="color:#C8932B;text-decoration:none;">${escEmail(b.site)}</a>` : '';
      const email = b.email ? `<a href="mailto:${escEmail(b.email)}" style="color:#C8932B;text-decoration:none;">${escEmail(b.email)}</a>` : '';
      const sep = (site && email) ? '&nbsp;·&nbsp;' : '';
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="background:#FAF7F2;padding:18px 30px;text-align:center;font-size:11px;color:#8A8478;border-top:1px solid #E5DED1;">${logo}${ligne1}<br/>${site}${sep}${email}</td></tr></table>`;
    }
    case 'html':
      // Bloc HTML libre (admin de confiance) — inséré tel quel
      return `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:6px 30px;">${b.code || ''}</td></tr></table>`;
    case 'invit_modalite': {
      const inv = ctx && ctx.invitation;
      if (!inv) return wrap(`<div style="background:#FAF7F2;border:1px dashed #E5DED1;border-radius:10px;padding:14px 16px;font-size:12px;color:#8A8478;font-style:italic;">Modalités de l'événement (date, lieu…) — s'afficheront dans le mail réel.</div>`, 'padding:8px 30px;');
      const rows = [];
      const lieuParts = [inv.lieu_prelude, inv.lieu_adresse, [inv.lieu_cp, inv.lieu_ville].filter(Boolean).join(' ')].filter(Boolean);
      if (inv.date_event) rows.push(['Date', escEmail(inv.date_event) + (inv.heure ? ' · ' + escEmail(inv.heure) : '')]);
      if (lieuParts.length) rows.push(['Lieu', escEmail(lieuParts.join(', '))]);
      if (inv.reponse_avant) rows.push(['Réponse avant le', escEmail(_invDateFr(inv.reponse_avant))]);
      const body = rows.map(([k, v]) => `<tr><td style="padding:6px 0;font-size:13px;color:#4A5568;"><strong style="color:#0A1628;display:inline-block;width:120px;">${k}</strong>${v}</td></tr>`).join('');
      return wrap(`<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FAF7F2;border:1px solid #E5DED1;border-radius:10px;padding:8px 16px;">${body}</table>`, 'padding:10px 30px;');
    }
    case 'invit_reponse': {
      const base = ctx && ctx.rsvpBase;
      const labelOui = escEmail(b.label_oui || 'Je participe');
      const labelNon = escEmail(b.label_non || 'Je ne pourrai pas');
      if (!base) {
        return wrap(`<div style="text-align:center;"><span style="display:inline-block;background:#C8932B;color:#0A1628;font-weight:bold;font-size:14px;padding:13px 26px;border-radius:999px;margin:4px;">${labelOui}</span><span style="display:inline-block;background:#FFFFFF;color:#0A1628;border:1px solid #E5DED1;font-weight:bold;font-size:14px;padding:12px 26px;border-radius:999px;margin:4px;">${labelNon}</span></div>`, 'padding:14px 30px;');
      }
      const urlOui = `${base}&r=oui`;
      const urlNon = `${base}&r=non`;
      return wrap(`<table cellpadding="0" cellspacing="0" border="0" align="center" role="presentation"><tr>
        <td style="padding:4px;"><table cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#C8932B;border-radius:999px;"><a href="${escEmail(urlOui)}" target="_blank" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:bold;color:#0A1628;text-decoration:none;">${labelOui}</a></td></tr></table></td>
        <td style="padding:4px;"><table cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#FFFFFF;border:1px solid #E5DED1;border-radius:999px;"><a href="${escEmail(urlNon)}" target="_blank" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:bold;color:#0A1628;text-decoration:none;">${labelNon}</a></td></tr></table></td>
      </tr></table>`, 'padding:14px 30px;text-align:center;');
    }
    default:
      return '';
  }
}

function renderBlocksToHtml(blocks, ctx) {
  return (blocks || []).map(b => renderOneBlock(b, ctx)).join('\n');
}

// Coquille email pour le mode blocs : carte 600px + ligne de désinscription RGPD forcée.
function emailShellBlocks(mail, innerHtml, unsubUrl) {
  const preheader = mail.pre_header
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escEmail(mail.pre_header)}</div>`
    : '';
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escEmail(mail.sujet || '')}</title>
</head>
<body style="margin:0;padding:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0A1628;">
${preheader}
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF7F2;padding:30px 12px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border-radius:14px;border:1px solid #E5DED1;box-shadow:0 2px 10px rgba(10,22,40,0.06);overflow:hidden;">
      <tr><td style="padding:0;">
        ${innerHtml}
      </td></tr>
      <tr><td style="background:#FAF7F2;padding:14px 30px;text-align:center;font-size:11px;color:#8A8478;line-height:1.6;border-top:1px solid #E5DED1;border-radius:0 0 14px 14px;">
        Vous recevez cet email en tant que partenaire du Spacer's Business Club.
        ${unsubUrl ? `<a href="${escEmail(unsubUrl)}" style="color:#8A8478;text-decoration:underline;">Se désinscrire</a>.` : ''}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ============================================================================
//  MAILS — upload d'image vers Supabase Storage (bucket public mail-assets)
// ============================================================================
async function handleAdminMailUploadImage(token, request, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  let form;
  try { form = await request.formData(); } catch (_) {
    return jsonResponseNoCache({ error: 'Requête multipart invalide' }, 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return jsonResponseNoCache({ error: 'Aucun fichier reçu' }, 400);

  const type = (file.type || '').toLowerCase();
  if (!MAIL_IMG_TYPES.includes(type)) {
    return jsonResponseNoCache({ error: 'Format non supporté (png, jpg, gif, webp uniquement)' }, 400);
  }
  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAIL_IMG_MAX_BYTES) {
    return jsonResponseNoCache({ error: 'Image trop lourde (max 3 Mo)' }, 400);
  }
  const ext = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'jpg';
  const rand = (crypto.randomUUID && crypto.randomUUID().slice(0, 8)) || Math.random().toString(36).slice(2, 10);
  const objectPath = `mails/${Date.now()}-${rand}.${ext}`;

  const up = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${MAIL_ASSETS_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': type,
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    return jsonResponseNoCache({ error: 'Upload Supabase Storage échoué', detail: t.slice(0, 300) }, 502);
  }
  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${MAIL_ASSETS_BUCKET}/${objectPath}`;
  logAudit_(admin.id, 'mail.upload_image', 'storage', null, { path: objectPath }, env);
  return jsonResponseNoCache({ ok: true, url: publicUrl });
}

async function handleDesinscription(url, env) {
  const email = (url.searchParams.get('e') || '').trim().toLowerCase();
  const k = (url.searchParams.get('k') || '').trim();
  const page = (title, msg) => new Response(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
    <style>body{margin:0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#FAF7F2;color:#0A1628;display:grid;place-items:center;min-height:100vh;padding:24px}
    .c{background:#fff;border:1px solid #E5DED1;border-radius:16px;max-width:440px;padding:36px 32px;text-align:center;box-shadow:0 8px 24px rgba(10,22,40,.06)}
    .s{width:44px;height:44px;border-radius:11px;background:#C8932B;color:#0A1628;display:grid;place-items:center;font-family:Georgia,serif;font-weight:700;font-size:22px;margin:0 auto 16px}
    h1{font-family:Georgia,serif;font-weight:500;font-size:24px;margin:0 0 8px}p{color:#4A5568;font-size:14px;line-height:1.6;margin:0}</style></head>
    <body><div class="c"><div class="s">S</div><h1>${title}</h1><p>${msg}</p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );

  if (!email || !email.includes('@') || !k) return page('Lien invalide', 'Ce lien de désinscription est incomplet.');
  const expected = await unsubKey_(email);
  if (k !== expected) return page('Lien invalide', 'Ce lien de désinscription n\'est pas valide.');
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/mail_desinscriptions?on_conflict=email`, {
      method: 'POST',
      headers: { ...supabaseHeaders(env), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ email }),
    });
  } catch (_) {}
  return page('Désinscription confirmée', `L'adresse ${escEmail(email)} ne recevra plus les emails du Spacer's Business Club.`);
}

// ============================================================================
//  SPRINT INVITATIONS — événements partenaires (RSVP, places, relances)
// ============================================================================
function _invDateFr(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d);
}
function _invToken() {
  return (crypto.randomUUID && crypto.randomUUID().replace(/-/g, '')) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
}
function _invFrom(inv) {
  const nom = (inv.expediteur_nom || "Le Spacer's Business Club").replace(/[<>]/g, '');
  return `${nom} <${INVITATION_SENDER_EMAIL}>`;
}
function _invPlaces(inv, dests) {
  const max = inv.max_participants || 0;
  const used = (dests || []).filter(d => d.reponse === 'present').reduce((s, d) => s + (d.nb_personnes || 1), 0);
  return { max, used, restantes: max > 0 ? Math.max(0, max - used) : null };
}

function renderInvitationEmail(invitation, dest) {
  let blocks = invitation.blocks;
  if (typeof blocks === 'string') { try { blocks = JSON.parse(blocks); } catch { blocks = []; } }
  if (!Array.isArray(blocks) || !blocks.length) {
    blocks = [
      { type: 'entete', eyebrow: 'INVITATION', titre: invitation.theme || invitation.sujet || 'Invitation', marque: "SPACER'S BUSINESS CLUB", sous_marque: 'Toulouse Volley · Saison 2026–2027' },
      { type: 'invit_modalite' },
      { type: 'paragraphe', text: 'Nous serions ravis de vous compter parmi nous. Merci de confirmer votre présence ci-dessous.' },
      { type: 'invit_reponse' },
      { type: 'pied', ligne1: "Spacer's Toulouse Volley · Palais des Sports André Brouat", site: 'spacerstoulouse.fr', site_url: 'https://spacerstoulouse.fr', email: 'marketing@spacerstoulouse.fr' },
    ];
  }
  const rsvpBase = dest && dest.token ? `${PUBLIC_BASE_URL}/invitation?t=${encodeURIComponent(dest.token)}` : '';
  const inner = renderBlocksToHtml(blocks, { invitation, dest, rsvpBase });
  return emailShellBlocks({ sujet: invitation.sujet, pre_header: invitation.theme || '' }, inner, null);
}

async function handleAdminInvitationsList(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('invitations', 'select=*&order=created_at.desc&limit=200', env);
  const invitations = (rows || []).map(i => ({
    id: i.id, sujet: i.sujet, theme: i.theme || '', date_event: i.date_event || '', heure: i.heure || '',
    statut: i.statut, nb_destinataires: i.nb_destinataires || 0, max_participants: i.max_participants || 0,
    reponse_avant: i.reponse_avant, envoye_le: i.envoye_le, cree_par_nom: i.cree_par_nom || '', created_at: i.created_at,
  }));
  const stats = { brouillon: 0, valide: 0, envoye: 0, clos: 0, total: 0 };
  invitations.forEach(i => { stats[i.statut] = (stats[i.statut] || 0) + 1; stats.total++; });
  return jsonResponseNoCache({ invitations, stats });
}

async function handleAdminInvitationDetail(token, invitationId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('invitations', `id=eq.${invitationId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Invitation introuvable' }, 404);
  const inv = rows[0];
  const dests = await supabaseQuery('invitation_destinataires', `invitation_id=eq.${invitationId}&select=contact_nom,contact_prenom,contact_email,partenaire_nom,reponse,nb_personnes,commentaire,repondu_le,statut_paiement,montant_paye&order=repondu_le.desc.nullslast&limit=2000`, env);
  const present = (dests || []).filter(d => d.reponse === 'present');
  const absent = (dests || []).filter(d => d.reponse === 'absent');
  const sans = (dests || []).filter(d => !d.reponse);
  const places = _invPlaces(inv, dests);
  const agg = {
    total: (dests || []).length,
    present: present.length, absent: absent.length, sans_reponse: sans.length,
    total_personnes: present.reduce((s, d) => s + (d.nb_personnes || 1), 0),
    places_max: places.max, places_used: places.used, places_restantes: places.restantes,
    payes: (dests || []).filter(d => d.statut_paiement === 'paye').length,
    encaisse: (dests || []).reduce((s, d) => s + (d.statut_paiement === 'paye' ? (Number(d.montant_paye) || 0) : 0), 0),
  };
  // estimation du nb de destinataires potentiels (si pas encore envoyé)
  let destinataires_estimes = inv.nb_destinataires || 0;
  if (!destinataires_estimes) {
    const contacts = await supabaseQuery('partenaire_contacts', 'select=email,statut&limit=2000', env);
    destinataires_estimes = (contacts || []).filter(c => c.email && c.email.includes('@') && c.statut !== 'inactif').length;
  }
  return jsonResponseNoCache({ invitation: inv, destinataires: dests || [], agg, destinataires_estimes });
}

function _invInsertFromBody(body, admin, email) {
  const intOr0 = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : Math.max(0, n); };
  const dateOrNull = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(String(v))) ? String(v).slice(0, 10) : null;
  return {
    sujet: String(body.sujet || '').trim(),
    theme: body.theme || null,
    date_event: body.date_event || null,
    heure: body.heure || null,
    lieu_prelude: body.lieu_prelude || null,
    lieu_adresse: body.lieu_adresse || null,
    lieu_cp: body.lieu_cp || null,
    lieu_ville: body.lieu_ville || null,
    reponse_avant: dateOrNull(body.reponse_avant),
    date_relance: dateOrNull(body.date_relance),
    date_rappel: dateOrNull(body.date_rappel),
    expediteur_nom: body.expediteur_nom || "Le Spacer's Business Club",
    reply_to: body.reply_to || null,
    max_participants: intOr0(body.max_participants),
    est_payant: !!body.est_payant,
    prix_personne: (() => { const n = parseFloat(body.prix_personne); return (isNaN(n) || n < 0) ? 0 : Math.round(n * 100) / 100; })(),
    devise: 'eur',
    afficher_places: !!body.afficher_places,
    opt_infos_complementaires: !!body.opt_infos_complementaires,
    opt_liste_participants: body.opt_liste_participants === undefined ? true : !!body.opt_liste_participants,
    blocks: Array.isArray(body.blocks) ? body.blocks : [],
    page_acceptation: (body.page_acceptation && typeof body.page_acceptation === 'object') ? body.page_acceptation : {},
    page_declinaison: (body.page_declinaison && typeof body.page_declinaison === 'object') ? body.page_declinaison : {},
  };
}

async function handleAdminInvitationCreate(token, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  if (!String(body.sujet || '').trim()) return jsonResponseNoCache({ error: 'Le sujet est obligatoire' }, 400);
  let email = '';
  try { const a = await supabaseQuery('admins', `magic_token=eq.${token}&select=email&limit=1`, env); if (a && a[0]) email = a[0].email || ''; } catch (_) {}
  const data = Object.assign(_invInsertFromBody(body, admin, email), {
    statut: 'brouillon',
    cree_par_admin_id: admin.id,
    cree_par_nom: `${admin.prenom || ''} ${admin.nom || ''}`.trim() || null,
    cree_par_email: email || null,
  });
  try {
    const arr = await supabaseInsert_('invitations', data, env);
    const created = Array.isArray(arr) ? arr[0] : arr;
    logAudit_(admin.id, 'invitation.create', 'invitations', created.id, { sujet: data.sujet }, env);
    return jsonResponseNoCache({ ok: true, invitation: created });
  } catch (e) { return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500); }
}

async function handleAdminInvitationUpdate(token, invitationId, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const cur = await supabaseQuery('invitations', `id=eq.${invitationId}&select=statut&limit=1`, env);
  if (!cur || cur.length === 0) return jsonResponseNoCache({ error: 'Invitation introuvable' }, 404);
  if (cur[0].statut === 'envoye' || cur[0].statut === 'clos') return jsonResponseNoCache({ error: 'Invitation déjà envoyée, non modifiable' }, 400);
  const patch = Object.assign(_invInsertFromBody(body, admin, ''), { statut: 'brouillon', updated_at: new Date().toISOString() });
  if (!patch.sujet) return jsonResponseNoCache({ error: 'Le sujet est obligatoire' }, 400);
  delete patch.cree_par_admin_id; delete patch.cree_par_nom; delete patch.cree_par_email;
  try { await supabasePatch_('invitations', `id=eq.${invitationId}`, patch, env); return jsonResponseNoCache({ ok: true }); }
  catch (e) { return jsonResponseNoCache({ error: 'Erreur update', detail: e.message }, 500); }
}

async function handleAdminInvitationValidate(token, invitationId, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('invitations', `id=eq.${invitationId}&select=statut&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Invitation introuvable' }, 404);
  if (rows[0].statut === 'envoye') return jsonResponseNoCache({ error: 'Invitation déjà envoyée' }, 400);
  await supabasePatch_('invitations', `id=eq.${invitationId}`, { statut: 'valide', updated_at: new Date().toISOString() }, env);
  logAudit_(admin.id, 'invitation.validate', 'invitations', invitationId, {}, env);
  return jsonResponseNoCache({ ok: true, statut: 'valide' });
}

async function handleAdminInvitationTest(token, invitationId, env, ctx) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('invitations', `id=eq.${invitationId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Invitation introuvable' }, 404);
  const inv = rows[0];
  let toEmail = inv.cree_par_email || admin.email || '';
  if (!toEmail) { const a = await supabaseQuery('admins', `magic_token=eq.${token}&select=email&limit=1`, env); if (a && a[0]) toEmail = a[0].email || ''; }
  if (!toEmail || !toEmail.includes('@')) return jsonResponseNoCache({ error: 'Aucune adresse de test disponible' }, 400);
  const fakeDest = { token: 'apercu-test', contact_email: toEmail };
  const job = sendEmailViaResend(env, {
    to: toEmail, from: _invFrom(inv), subject: `[TEST] ${inv.sujet}`,
    html: renderInvitationEmail(inv, fakeDest), replyTo: inv.reply_to || inv.cree_par_email || EMAIL_REPLY_TO_CLUB,
  });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job); else await job;
  return jsonResponseNoCache({ ok: true, sent_to: toEmail });
}

async function _invBuildRecipients(env) {
  const contacts = await supabaseQuery('partenaire_contacts', 'select=email,nom,prenom,statut,partenaire_id&limit=2000', env);
  const seen = new Set();
  const out = [];
  (contacts || []).forEach(c => {
    const email = (c.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || c.statut === 'inactif' || seen.has(email)) return;
    seen.add(email);
    out.push({ contact_email: email, contact_nom: c.nom || '', contact_prenom: c.prenom || '', partenaire_id: c.partenaire_id || null });
  });
  return out;
}

async function handleAdminInvitationSend(token, invitationId, env, ctx) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('invitations', `id=eq.${invitationId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Invitation introuvable' }, 404);
  const inv = rows[0];
  if (inv.statut === 'envoye') return jsonResponseNoCache({ error: 'Cette invitation a déjà été envoyée' }, 400);
  if (inv.statut !== 'valide') return jsonResponseNoCache({ error: 'L\'invitation doit être validée avant envoi' }, 400);

  const recipients = await _invBuildRecipients(env);
  if (!recipients.length) return jsonResponseNoCache({ error: 'Aucun destinataire valide' }, 400);

  // résoudre les raisons sociales (pour affichage RSVP)
  let partMap = {};
  try {
    const parts = await supabaseQuery('partenaires', 'select=id,raison_sociale&limit=2000', env);
    (parts || []).forEach(p => { partMap[p.id] = p.raison_sociale; });
  } catch (_) {}

  const destRows = recipients.map(r => ({
    invitation_id: invitationId, token: _invToken(),
    contact_email: r.contact_email, contact_nom: r.contact_nom, contact_prenom: r.contact_prenom,
    partenaire_nom: r.partenaire_id ? (partMap[r.partenaire_id] || null) : null,
  }));
  let inserted;
  try { inserted = await supabaseInsert_('invitation_destinataires', destRows, env); }
  catch (e) { return jsonResponseNoCache({ error: 'Erreur création destinataires', detail: e.message }, 500); }

  const from = _invFrom(inv);
  const replyTo = inv.reply_to || inv.cree_par_email || EMAIL_REPLY_TO_CLUB;
  const job = (async () => {
    let ok = 0, fail = 0;
    for (const d of (inserted || destRows)) {
      try {
        const res = await sendEmailViaResend(env, { to: d.contact_email, from, subject: inv.sujet, html: renderInvitationEmail(inv, d), replyTo });
        if (res && res.ok) ok++; else fail++;
      } catch (_) { fail++; }
      await new Promise(rs => setTimeout(rs, 120));
    }
    console.log(`[Invitation ${invitationId}] ${ok} OK / ${fail} échecs / ${destRows.length}`);
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job); else await job;

  await supabasePatch_('invitations', `id=eq.${invitationId}`, {
    statut: 'envoye', envoye_le: new Date().toISOString(), nb_destinataires: destRows.length, updated_at: new Date().toISOString(),
  }, env);
  logAudit_(admin.id, 'invitation.send', 'invitations', invitationId, { nb: destRows.length }, env);
  return jsonResponseNoCache({ ok: true, statut: 'envoye', nb_destinataires: destRows.length });
}

async function handleAdminInvitationRelancer(token, invitationId, env, ctx) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('invitations', `id=eq.${invitationId}&select=*&limit=1`, env);
  if (!rows || rows.length === 0) return jsonResponseNoCache({ error: 'Invitation introuvable' }, 404);
  const inv = rows[0];
  if (inv.statut !== 'envoye') return jsonResponseNoCache({ error: 'Seules les invitations envoyées peuvent être relancées' }, 400);
  const dests = await supabaseQuery('invitation_destinataires', `invitation_id=eq.${invitationId}&reponse=is.null&select=*&limit=2000`, env);
  if (!dests || !dests.length) return jsonResponseNoCache({ ok: true, nb_relances: 0, message: 'Tout le monde a répondu' });
  const n = await _invSendRelances(inv, dests, env, ctx, 'relance');
  await supabasePatch_('invitations', `id=eq.${invitationId}`, { relance_envoyee_le: new Date().toISOString(), updated_at: new Date().toISOString() }, env);
  logAudit_(admin.id, 'invitation.relancer', 'invitations', invitationId, { nb: n }, env);
  return jsonResponseNoCache({ ok: true, nb_relances: n });
}

async function _invSendRelances(inv, dests, env, ctx, mode) {
  const from = _invFrom(inv);
  const replyTo = inv.reply_to || inv.cree_par_email || EMAIL_REPLY_TO_CLUB;
  const prefix = mode === 'rappel' ? 'Rappel — ' : 'Relance — ';
  const job = (async () => {
    for (const d of dests) {
      try {
        await sendEmailViaResend(env, { to: d.contact_email, from, subject: prefix + inv.sujet, html: renderInvitationEmail(inv, d), replyTo });
      } catch (_) {}
      await new Promise(rs => setTimeout(rs, 120));
    }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job); else await job;
  return dests.length;
}

// ---- Pages publiques RSVP ----
function _invPublicShell(title, bodyHtml) {
  return new Response(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
    <style>
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#FAF7F2;color:#0A1628;display:grid;place-items:center;min-height:100vh;padding:24px}
    .c{background:#fff;border:1px solid #E5DED1;border-radius:18px;max-width:520px;width:100%;overflow:hidden;box-shadow:0 12px 40px rgba(10,22,40,.10)}
    .hd{background:linear-gradient(135deg,#11203a,#0A1628);padding:24px 28px;color:#fff}
    .hd .s{width:40px;height:40px;border-radius:10px;background:#C8932B;color:#0A1628;display:grid;place-items:center;font-family:Georgia,serif;font-weight:700;font-size:20px}
    .hd .e{color:#E8C977;font-size:10px;font-weight:700;letter-spacing:2px;margin-top:14px}
    .hd h1{font-family:Georgia,serif;font-weight:500;font-size:24px;margin:6px 0 0;line-height:1.15}
    .bd{padding:24px 28px}
    .row{font-size:14px;color:#4A5568;line-height:1.7;margin:0 0 6px}
    .row b{color:#0A1628}
    .places{background:#FAF3DF;border:1px solid #E8C977;border-radius:10px;padding:10px 14px;font-size:13px;color:#0A1628;margin:14px 0;text-align:center;font-weight:600}
    label.l{display:block;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8A8478;font-weight:700;margin:16px 0 6px}
    select,textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #E5DED1;border-radius:8px;font-size:14px;font-family:inherit;background:#fff}
    .choice{display:flex;gap:10px;margin:6px 0 4px}
    .choice label{flex:1;border:1px solid #E5DED1;border-radius:10px;padding:12px;text-align:center;cursor:pointer;font-weight:600;font-size:14px}
    .choice input{display:none}
    .choice input:checked+span{display:block}
    .choice label.sel{border-color:#C8932B;background:#FAF3DF}
    .btn{display:block;width:100%;box-sizing:border-box;margin-top:20px;background:#C8932B;color:#0A1628;border:none;border-radius:999px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
    .ft{padding:14px 28px;background:#FAF7F2;border-top:1px solid #E5DED1;text-align:center;font-size:11px;color:#8A8478}
    </style></head><body><div class="c">${bodyHtml}</div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

function _invHeader(inv, eyebrow) {
  return `<div class="hd"><div class="s">S</div><div class="e">${escEmail(eyebrow || 'INVITATION')}</div><h1>${escEmail(inv.theme || inv.sujet || 'Invitation')}</h1></div>`;
}
function _invDetailsRows(inv) {
  const lieu = [inv.lieu_prelude, inv.lieu_adresse, [inv.lieu_cp, inv.lieu_ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  let h = '';
  if (inv.date_event) h += `<div class="row"><b>Date :</b> ${escEmail(inv.date_event)}${inv.heure ? ' · ' + escEmail(inv.heure) : ''}</div>`;
  if (lieu) h += `<div class="row"><b>Lieu :</b> ${escEmail(lieu)}</div>`;
  if (inv.reponse_avant) h += `<div class="row"><b>Réponse souhaitée avant le :</b> ${escEmail(_invDateFr(inv.reponse_avant))}</div>`;
  return h;
}

async function handleInvitationPublicPage(url, env) {
  const token = (url.searchParams.get('t') || '').trim();
  const pre = (url.searchParams.get('r') || '').trim();
  if (!token) return _invPublicShell('Lien invalide', `<div class="hd"><div class="s">S</div><h1>Lien invalide</h1></div><div class="bd"><p class="row">Ce lien d'invitation est incomplet.</p></div>`);
  const drows = await supabaseQuery('invitation_destinataires', `token=eq.${token}&select=*&limit=1`, env);
  if (!drows || !drows.length) return _invPublicShell('Lien invalide', `<div class="hd"><div class="s">S</div><h1>Lien invalide</h1></div><div class="bd"><p class="row">Ce lien d'invitation n'est pas reconnu.</p></div>`);
  const dest = drows[0];
  const irows = await supabaseQuery('invitations', `id=eq.${dest.invitation_id}&select=*&limit=1`, env);
  if (!irows || !irows.length) return _invPublicShell('Invitation close', `<div class="hd"><div class="s">S</div><h1>Invitation introuvable</h1></div><div class="bd"><p class="row">Cette invitation n'est plus disponible.</p></div>`);
  const inv = irows[0];

  let placesHtml = '';
  if (inv.afficher_places && inv.max_participants > 0) {
    const all = await supabaseQuery('invitation_destinataires', `invitation_id=eq.${inv.id}&reponse=eq.present&select=nb_personnes&limit=2000`, env);
    const used = (all || []).reduce((s, d) => s + (d.nb_personnes || 1), 0);
    const rest = Math.max(0, inv.max_participants - used);
    placesHtml = `<div class="places">${rest > 0 ? `Il reste ${rest} place${rest > 1 ? 's' : ''}` : 'Événement complet'}</div>`;
  }

  const presentSel = (pre === 'oui' || dest.reponse === 'present');
  const isPaidEvent = inv.est_payant && Number(inv.prix_personne) > 0;
  let payInfoHtml = '';
  if (isPaidEvent) {
    payInfoHtml = (dest.statut_paiement === 'paye')
      ? `<div class="places" style="background:#EAF3DE;color:#3A8264;">✓ Participation déjà réglée${dest.montant_paye ? ` (${Number(dest.montant_paye).toFixed(2)} €)` : ''}. Merci !</div>`
      : `<div class="places">Participation : ${Number(inv.prix_personne).toFixed(2)} € / personne · paiement sécurisé Stripe</div>`;
  }
  const absentSel = (pre === 'non' || dest.reponse === 'absent');
  const nbOptions = Array.from({ length: 10 }, (_, i) => i + 1).map(n => `<option value="${n}" ${(dest.nb_personnes || 1) === n ? 'selected' : ''}>${n}</option>`).join('');
  const greet = dest.contact_prenom ? `Bonjour ${escEmail(dest.contact_prenom)},` : 'Bonjour,';
  const already = dest.reponse ? `<div class="row" style="font-style:italic;color:#3A8264;margin-top:8px;">Vous avez déjà répondu (${dest.reponse === 'present' ? 'présent' : 'absent'}). Vous pouvez modifier ci-dessous.</div>` : '';

  const body = `${_invHeader(inv, 'VOTRE INVITATION')}
    <div class="bd">
      <p class="row">${greet}</p>
      ${_invDetailsRows(inv)}
      ${placesHtml}
      ${payInfoHtml}
      ${already}
      <form method="POST" action="/invitation/repondre">
        <input type="hidden" name="token" value="${escEmail(token)}">
        <label class="l">Votre réponse</label>
        <div class="choice">
          <label id="lbl-oui" class="${presentSel ? 'sel' : ''}"><input type="radio" name="reponse" value="present" ${presentSel ? 'checked' : ''} onclick="document.getElementById('lbl-oui').classList.add('sel');document.getElementById('lbl-non').classList.remove('sel');document.getElementById('pp').style.display='block';">✓ Je participe</label>
          <label id="lbl-non" class="${absentSel ? 'sel' : ''}"><input type="radio" name="reponse" value="absent" ${absentSel ? 'checked' : ''} onclick="document.getElementById('lbl-non').classList.add('sel');document.getElementById('lbl-oui').classList.remove('sel');document.getElementById('pp').style.display='none';">✕ Je ne pourrai pas</label>
        </div>
        <div id="pp" style="display:${presentSel ? 'block' : 'none'};">
          ${inv.opt_liste_participants ? `<label class="l">Combien serez-vous ?</label><select name="nb_personnes">${nbOptions}</select>` : ''}
        </div>
        ${inv.opt_infos_complementaires ? `<label class="l">Informations complémentaires (optionnel)</label><textarea name="commentaire" rows="3">${escEmail(dest.commentaire || '')}</textarea>` : ''}
        <button class="btn" type="submit">${isPaidEvent ? 'Participer et payer' : 'Valider mon inscription'}</button>
      </form>
    </div>
    <div class="ft">Spacer's Toulouse Volley · Business Club</div>`;
  return _invPublicShell(escEmail(inv.sujet || 'Invitation'), body);
}

async function handleInvitationPublicRepondre(request, env) {
  let form;
  try { form = await request.formData(); } catch (_) { return _invPublicShell('Erreur', `<div class="hd"><div class="s">S</div><h1>Erreur</h1></div><div class="bd"><p class="row">Formulaire invalide.</p></div>`); }
  const token = String(form.get('token') || '').trim();
  let reponse = String(form.get('reponse') || '').trim();
  let nb = parseInt(form.get('nb_personnes') || '1', 10); if (isNaN(nb) || nb < 1) nb = 1;
  const commentaire = String(form.get('commentaire') || '').trim().slice(0, 1000);
  if (!token || (reponse !== 'present' && reponse !== 'absent')) {
    return _invPublicShell('Réponse incomplète', `<div class="hd"><div class="s">S</div><h1>Réponse incomplète</h1></div><div class="bd"><p class="row">Merci de choisir une réponse.</p></div>`);
  }
  const drows = await supabaseQuery('invitation_destinataires', `token=eq.${token}&select=*&limit=1`, env);
  if (!drows || !drows.length) return _invPublicShell('Lien invalide', `<div class="hd"><div class="s">S</div><h1>Lien invalide</h1></div><div class="bd"><p class="row">Lien non reconnu.</p></div>`);
  const dest = drows[0];
  const irows = await supabaseQuery('invitations', `id=eq.${dest.invitation_id}&select=*&limit=1`, env);
  const inv = irows && irows[0];
  if (!inv) return _invPublicShell('Invitation close', `<div class="hd"><div class="s">S</div><h1>Invitation introuvable</h1></div><div class="bd"></div>`);

  // contrôle des places (si plafond et nouvelle présence)
  if (reponse === 'present' && inv.max_participants > 0) {
    const all = await supabaseQuery('invitation_destinataires', `invitation_id=eq.${inv.id}&reponse=eq.present&select=token,nb_personnes&limit=2000`, env);
    let used = (all || []).reduce((s, d) => s + (d.nb_personnes || 1), 0);
    const prev = (all || []).find(d => d.token === token);
    if (prev) used -= (prev.nb_personnes || 1); // on retire son ancienne contribution
    if (used + nb > inv.max_participants) {
      const rest = Math.max(0, inv.max_participants - used);
      return _invPublicShell('Événement complet', `${_invHeader(inv, 'INVITATION')}<div class="bd"><div class="places">Désolé, il ne reste que ${rest} place${rest > 1 ? 's' : ''}.</div><p class="row">Vous pouvez <a href="${PUBLIC_BASE_URL}/invitation?t=${encodeURIComponent(token)}" style="color:#C8932B;">revenir en arrière</a> et ajuster le nombre de participants.</p></div>`);
    }
  }

  // Événement payant : présence → flux de paiement Stripe (sinon comportement normal)
  if (reponse === 'present' && inv.est_payant && Number(inv.prix_personne) > 0) {
    if (dest.statut_paiement === 'paye') {
      return new Response(null, { status: 303, headers: { Location: `${PUBLIC_BASE_URL}/invitation/paye?t=${encodeURIComponent(token)}` } });
    }
    return await _invStartPayment(inv, dest, token, nb, commentaire, env);
  }

  try {
    await supabasePatch_('invitation_destinataires', `token=eq.${token}`, {
      reponse, nb_personnes: reponse === 'present' ? nb : 1, commentaire: commentaire || null, repondu_le: new Date().toISOString(),
    }, env);
  } catch (e) { return _invPublicShell('Erreur', `<div class="hd"><div class="s">S</div><h1>Erreur</h1></div><div class="bd"><p class="row">Enregistrement impossible, réessayez.</p></div>`); }

  const pages = {
    present: inv.page_acceptation || {},
    absent: inv.page_declinaison || {},
  };
  const cfg = pages[reponse] || {};
  if (reponse === 'present') {
    const titre = cfg.titre || 'Votre présence est confirmée !';
    const texte = cfg.texte || `Merci ${escEmail(dest.contact_prenom || '')}, nous avons bien noté votre participation${inv.opt_liste_participants ? ` (${nb} personne${nb > 1 ? 's' : ''})` : ''}. À très bientôt !`;
    return _invPublicShell(escEmail(titre), `${_invHeader(inv, 'PRÉSENCE CONFIRMÉE')}<div class="bd"><h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 10px;color:#3A8264;">${escEmail(titre)}</h1><p class="row">${escEmail(texte)}</p>${_invDetailsRows(inv)}</div><div class="ft">Spacer's Toulouse Volley · Business Club</div>`);
  } else {
    const titre = cfg.titre || 'Nous sommes navrés de votre choix';
    const texte = cfg.texte || 'Peut-être à une autre fois. Merci de nous avoir prévenus.';
    return _invPublicShell(escEmail(titre), `${_invHeader(inv, 'RÉPONSE ENREGISTRÉE')}<div class="bd"><h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 10px;">${escEmail(titre)}</h1><p class="row">${escEmail(texte)}</p></div><div class="ft">Spacer's Toulouse Volley · Business Club</div>`);
  }
}

// ============================================================================
//  STRIPE — Paiement des invitations payantes (Checkout + webhook)
// ============================================================================

async function _invStartPayment(inv, dest, token, nb, commentaire, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return _invPublicShell('Paiement indisponible', `${_invHeader(inv, 'INVITATION')}<div class="bd"><p class="row">Le paiement en ligne n'est pas encore activé. Merci de contacter le Business Club.</p></div><div class="ft">Spacer's Toulouse Volley · Business Club</div>`);
  }
  // contrôle des places (présence payante = on réserve la place)
  if (inv.max_participants > 0) {
    const all = await supabaseQuery('invitation_destinataires', `invitation_id=eq.${inv.id}&reponse=eq.present&select=token,nb_personnes&limit=2000`, env);
    let used = (all || []).reduce((s, d) => s + (d.nb_personnes || 1), 0);
    const prev = (all || []).find(d => d.token === token);
    if (prev) used -= (prev.nb_personnes || 1);
    if (used + nb > inv.max_participants) {
      const rest = Math.max(0, inv.max_participants - used);
      return _invPublicShell('Événement complet', `${_invHeader(inv, 'INVITATION')}<div class="bd"><div class="places">Désolé, il ne reste que ${rest} place${rest > 1 ? 's' : ''}.</div></div>`);
    }
  }
  // enregistre la réponse en attente de paiement
  try {
    await supabasePatch_('invitation_destinataires', `token=eq.${token}`, {
      reponse: 'present', nb_personnes: nb, commentaire: commentaire || null,
      repondu_le: new Date().toISOString(), statut_paiement: 'en_attente',
    }, env);
  } catch (_) {}

  const unitAmount = Math.round(Number(inv.prix_personne) * 100);
  const currency = (inv.devise || 'eur').toLowerCase();
  const base = PUBLIC_BASE_URL;
  let session;
  try {
    session = await stripeCreateCheckoutSession(env, {
      currency, unitAmount, quantity: nb,
      productName: `${inv.sujet} — participation`,
      customerEmail: dest.contact_email || null,
      successUrl: `${base}/invitation/paye?t=${encodeURIComponent(token)}`,
      cancelUrl: `${base}/invitation?t=${encodeURIComponent(token)}`,
      metadata: { token, invitation_id: inv.id, nb: String(nb) },
    });
  } catch (e) {
    return _invPublicShell('Paiement indisponible', `${_invHeader(inv, 'INVITATION')}<div class="bd"><p class="row">Impossible d'initialiser le paiement (${escEmail(e.message)}). Réessayez plus tard.</p></div><div class="ft">Spacer's Toulouse Volley · Business Club</div>`);
  }
  if (session && session.id) {
    await supabasePatch_('invitation_destinataires', `token=eq.${token}`, { stripe_session_id: session.id }, env).catch(() => {});
  }
  if (session && session.url) {
    return new Response(null, { status: 303, headers: { Location: session.url } });
  }
  return _invPublicShell('Paiement indisponible', `${_invHeader(inv, 'INVITATION')}<div class="bd"><p class="row">Le paiement n'a pas pu démarrer. Réessayez.</p></div></div>`);
}

async function stripeCreateCheckoutSession(env, { currency, unitAmount, quantity, productName, customerEmail, successUrl, cancelUrl, metadata }) {
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  params.set('line_items[0][quantity]', String(quantity || 1));
  params.set('line_items[0][price_data][currency]', currency || 'eur');
  params.set('line_items[0][price_data][unit_amount]', String(unitAmount));
  params.set('line_items[0][price_data][product_data][name]', String(productName || 'Participation'));
  if (customerEmail) params.set('customer_email', customerEmail);
  for (const [k, v] of Object.entries(metadata || {})) params.set(`metadata[${k}]`, String(v));
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `Stripe ${res.status}`);
  return data;
}

async function verifyStripeSignature(secret, payload, sigHeader) {
  try {
    if (!sigHeader) return false;
    let t = null; const v1s = [];
    sigHeader.split(',').forEach(part => {
      const idx = part.indexOf('=');
      if (idx < 0) return;
      const k = part.slice(0, idx).trim(); const v = part.slice(idx + 1).trim();
      if (k === 't') t = v; else if (k === 'v1') v1s.push(v);
    });
    if (!t || !v1s.length) return false;
    // tolérance d'horodatage : 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(t, 10)) > 300) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
    const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
    return v1s.some(v1 => {
      if (v1.length !== hex.length) return false;
      let diff = 0;
      for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
      return diff === 0;
    });
  } catch (e) { return false; }
}

async function handleStripeWebhook(request, env, ctx) {
  const raw = await request.text();
  const sig = request.headers.get('stripe-signature') || '';
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response('webhook secret manquant', { status: 500 });
  const ok = await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, raw, sig);
  if (!ok) return new Response('signature invalide', { status: 400 });
  let event;
  try { event = JSON.parse(raw); } catch { return new Response('json invalide', { status: 400 }); }

  if (event.type === 'checkout.session.completed') {
    const s = event.data && event.data.object ? event.data.object : {};
    const token = s.metadata && s.metadata.token;
    if (token) {
      const patch = {
        statut_paiement: 'paye',
        montant_paye: (s.amount_total != null) ? (s.amount_total / 100) : null,
        stripe_payment_intent: s.payment_intent || null,
        paye_le: new Date().toISOString(),
      };
      const p = supabasePatch_('invitation_destinataires', `token=eq.${token}`, patch, env)
        .catch(e => console.error('[StripeWebhook] patch error:', e.message));
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p;
      console.log(`[StripeWebhook] checkout.session.completed → token=${token}, montant=${patch.montant_paye}`);
    }
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function handleInvitationPaidPage(url, env) {
  const token = (url.searchParams.get('t') || '').trim();
  let dest = null, inv = null;
  if (token) {
    const drows = await supabaseQuery('invitation_destinataires', `token=eq.${token}&select=*&limit=1`, env);
    if (drows && drows[0]) {
      dest = drows[0];
      const irows = await supabaseQuery('invitations', `id=eq.${dest.invitation_id}&select=*&limit=1`, env);
      inv = irows && irows[0];
    }
  }
  if (!inv) return _invPublicShell('Merci', `<div class="hd"><div class="s">S</div><h1>Merci</h1></div><div class="bd"><p class="row">Votre paiement a bien été pris en compte.</p></div>`);
  const paid = dest && dest.statut_paiement === 'paye';
  const titre = paid ? 'Paiement confirmé !' : 'Paiement reçu';
  const texte = paid
    ? `Merci ${escEmail(dest.contact_prenom || '')}, votre participation est confirmée et votre paiement enregistré. À très bientôt !`
    : `Merci ${escEmail(dest && dest.contact_prenom || '')}, votre paiement est en cours de confirmation. Votre place est réservée — vous recevrez la validation d'ici quelques instants.`;
  return _invPublicShell(escEmail(titre), `${_invHeader(inv, 'PARTICIPATION CONFIRMÉE')}<div class="bd"><h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 10px;color:#3A8264;">${escEmail(titre)}</h1><p class="row">${escEmail(texte)}</p>${_invDetailsRows(inv)}</div><div class="ft">Spacer's Toulouse Volley · Business Club</div>`);
}

// ---- Cron : relances & rappels automatiques ----
async function runInvitationRelances(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const today = new Date().toISOString().slice(0, 10);
  let invs = [];
  try { invs = await supabaseQuery('invitations', `statut=eq.envoye&select=*&limit=500`, env); } catch (_) { return; }
  for (const inv of (invs || [])) {
    try {
      // Relance aux non-répondants le jour de date_relance
      if (inv.date_relance && String(inv.date_relance).slice(0, 10) === today && !inv.relance_envoyee_le) {
        const dests = await supabaseQuery('invitation_destinataires', `invitation_id=eq.${inv.id}&reponse=is.null&select=*&limit=2000`, env);
        if (dests && dests.length) await _invSendRelances(inv, dests, env, null, 'relance');
        await supabasePatch_('invitations', `id=eq.${inv.id}`, { relance_envoyee_le: new Date().toISOString() }, env);
      }
      // Rappel aux présents le jour de date_rappel
      if (inv.date_rappel && String(inv.date_rappel).slice(0, 10) === today && !inv.rappel_envoye_le) {
        const dests = await supabaseQuery('invitation_destinataires', `invitation_id=eq.${inv.id}&reponse=eq.present&select=*&limit=2000`, env);
        if (dests && dests.length) await _invSendRelances(inv, dests, env, null, 'rappel');
        await supabasePatch_('invitations', `id=eq.${inv.id}`, { rappel_envoye_le: new Date().toISOString() }, env);
      }
    } catch (e) { console.log('[Cron invitation]', inv.id, e.message); }
  }
}

// ============================================================================
//  SPRINT B.3 — Board partagé entre partenaires + réponses aux publications
// ============================================================================
// ============================================================================
//  ANNUAIRE PARTENAIRES (networking B2B)
// ============================================================================

async function handlePartnerAnnuaire(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const rows = await supabaseQuery('partenaires',
    `interne=eq.false&select=id,raison_sociale,secteur,taille,ville,adresse,code_postal,site_web,email_societe,logo_b64,niveau,type_partenariat,expertise,representant,representant_fonction,representant_email,representant_tel,representant_linkedin,representant_photo_b64,latitude,longitude&order=raison_sociale.asc&limit=500`,
    env);
  const fiches = (rows || []).map(p => ({
    id: p.id,
    is_mine: p.id === partner.partenaire_id,
    raison_sociale: p.raison_sociale || '',
    secteur: p.secteur || '',
    taille: p.taille || '',
    type_partenariat: p.type_partenariat || '',
    expertise: p.expertise || '',
    ville: p.ville || '',
    adresse: p.adresse || '',
    code_postal: p.code_postal || '',
    site_web: p.site_web || '',
    email_societe: p.email_societe || '',
    logo_b64: p.logo_b64 || null,
    niveau: p.niveau || '',
    representant: p.representant || '',
    representant_fonction: p.representant_fonction || '',
    representant_email: p.representant_email || '',
    representant_tel: p.representant_tel || '',
    representant_linkedin: p.representant_linkedin || '',
    representant_photo_b64: p.representant_photo_b64 || null,
    latitude: p.latitude,
    longitude: p.longitude,
  }));
  return jsonResponseNoCache({ fiches, count: fiches.length });
}

// ===== Mise en relation (networking) — suggestions + demandes (warm intro) =====

// Suggestions "à découvrir" : exclut soi-même, l'entité interne et les partenaires déjà sollicités.
// Score business : +2 expertise commune, +1 même ville, +1 secteur complémentaire (différent).
async function handlePartnerSuggestions(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const meId = partner.partenaire_id;
  const meRows = await supabaseQuery('partenaires', `id=eq.${meId}&select=secteur,ville,expertise&limit=1`, env);
  const me = (meRows && meRows[0]) || {};
  const myTags = (me.expertise || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const all = await supabaseQuery('partenaires',
    `interne=eq.false&id=neq.${meId}&select=id,raison_sociale,secteur,ville,logo_b64,expertise,representant,representant_fonction&order=raison_sociale.asc&limit=500`, env) || [];
  const reqs = await supabaseQuery('mises_en_relation', `demandeur_partenaire_id=eq.${meId}&select=cible_partenaire_id`, env) || [];
  const already = new Set(reqs.map(r => r.cible_partenaire_id));
  const scored = all.filter(p => !already.has(p.id)).map(p => {
    let score = 0, reason = 'À découvrir';
    const tags = (p.expertise || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const shared = tags.filter(t => myTags.includes(t));
    if (shared.length) { score += 2; reason = 'Expertise commune : ' + shared[0]; }
    if (me.ville && p.ville && me.ville.toLowerCase() === p.ville.toLowerCase()) { score += 1; if (score < 2) reason = 'Même ville : ' + p.ville; }
    if (me.secteur && p.secteur && me.secteur.toLowerCase() !== p.secteur.toLowerCase()) { score += 1; if (score === 1) reason = 'Secteur complémentaire'; }
    return { p, score, reason };
  });
  scored.sort((a, b) => (b.score - a.score) || (Math.random() - 0.5));
  const top = scored.slice(0, 3).map(({ p, reason }) => ({
    id: p.id, raison_sociale: p.raison_sociale, secteur: p.secteur || '', ville: p.ville || '',
    logo_b64: p.logo_b64 || null, representant: p.representant || '', representant_fonction: p.representant_fonction || '', reason,
  }));
  return jsonResponseNoCache({ suggestions: top, count: top.length });
}

// Le partenaire demande au club une mise en relation (warm intro) avec un autre partenaire.
async function handlePartnerIntroRequest(token, body, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const cible = String(body.cible_partenaire_id || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(cible)) return jsonResponseNoCache({ error: 'Cible invalide' }, 400);
  if (cible === partner.partenaire_id) return jsonResponseNoCache({ error: 'Impossible de se demander soi-même' }, 400);
  const cibleRows = await supabaseQuery('partenaires', `id=eq.${cible}&interne=eq.false&select=id,raison_sociale&limit=1`, env);
  if (!cibleRows || !cibleRows.length) return jsonResponseNoCache({ error: 'Partenaire cible introuvable' }, 404);
  const existing = await supabaseQuery('mises_en_relation',
    `demandeur_partenaire_id=eq.${partner.partenaire_id}&cible_partenaire_id=eq.${cible}&statut=in.(nouvelle,en_cours)&select=id&limit=1`, env);
  if (existing && existing.length) return jsonResponseNoCache({ error: 'Demande déjà en cours pour ce partenaire', already: true }, 409);
  const message = (body.message == null ? '' : String(body.message)).trim().slice(0, 1000) || null;
  try {
    await supabaseInsert_('mises_en_relation', {
      demandeur_partenaire_id: partner.partenaire_id,
      demandeur_contrat_id: partner.contrat_id || null,
      cible_partenaire_id: cible,
      message,
      statut: 'nouvelle',
    }, env);
  } catch (e) { return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500); }
  try { await notifyAdminsNewIntro_(env, { demandeur: partner.raison_sociale, cible: cibleRows[0].raison_sociale, message }); } catch (_) { }
  return jsonResponseNoCache({ ok: true });
}

async function notifyAdminsNewIntro_(env, { demandeur, cible, message }) {
  const admins = await supabaseQuery('admins', `actif=eq.true&select=email&limit=10`, env) || [];
  const to = admins.map(a => a.email).filter(Boolean);
  if (!to.length) return;
  const html = emailLayout('Mise en relation', 'Nouvelle demande', `${escEmail(demandeur)} → ${escEmail(cible)}`,
    `<p><b>${escEmail(demandeur)}</b> souhaite être mis en relation avec <b>${escEmail(cible)}</b>.</p>${message ? `<p style="color:#555;font-style:italic;">« ${escEmail(message)} »</p>` : ''}<p>Traite la demande dans Pilote → <b>Mises en relation</b>.</p>`);
  for (const addr of to) { try { await sendEmailViaResend(env, { to: addr, subject: `Demande de mise en relation — ${demandeur}`, html }); } catch (_) { } }
}

// Le partenaire voit l'état de ses propres demandes (pour griser les boutons déjà sollicités).
async function handlePartnerMesIntros(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const rows = await supabaseQuery('mises_en_relation',
    `demandeur_partenaire_id=eq.${partner.partenaire_id}&select=cible_partenaire_id,statut,created_at&order=created_at.desc&limit=200`, env) || [];
  return jsonResponseNoCache({ intros: rows });
}

// Admin : liste des demandes de mise en relation (avec noms/contacts résolus).
async function handleAdminIntrosList(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'unauthorized' }, 401);
  const rows = await supabaseQuery('mises_en_relation',
    `select=id,message,statut,note_admin,created_at,traite_at,traite_par,demandeur_partenaire_id,cible_partenaire_id&order=created_at.desc&limit=500`, env) || [];
  const ids = [...new Set(rows.flatMap(r => [r.demandeur_partenaire_id, r.cible_partenaire_id]).filter(Boolean))];
  let byId = {};
  if (ids.length) {
    const parts = await supabaseQuery('partenaires', `id=in.(${ids.join(',')})&select=id,raison_sociale,representant,representant_email,representant_tel`, env) || [];
    byId = Object.fromEntries(parts.map(p => [p.id, p]));
  }
  const intros = rows.map(r => ({
    id: r.id, message: r.message || '', statut: r.statut, note_admin: r.note_admin || '',
    created_at: r.created_at, traite_at: r.traite_at, traite_par: r.traite_par || '',
    demandeur: byId[r.demandeur_partenaire_id] || { raison_sociale: '?' },
    cible: byId[r.cible_partenaire_id] || { raison_sociale: '?' },
  }));
  return jsonResponseNoCache({ intros, count: intros.length });
}

// Admin : met à jour le statut/la note d'une demande.
async function handleAdminIntroUpdate(token, id, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'unauthorized' }, 401);
  if (!/^[0-9a-f-]{36}$/.test(id)) return jsonResponseNoCache({ error: 'id invalide' }, 400);
  const allowed = ['nouvelle', 'en_cours', 'realisee', 'refusee'];
  const statut = allowed.includes(body.statut) ? body.statut : null;
  const patch = {};
  if (statut) patch.statut = statut;
  if (body.note_admin !== undefined) patch.note_admin = body.note_admin ? String(body.note_admin).slice(0, 1000) : null;
  if (statut && statut !== 'nouvelle') { patch.traite_at = new Date().toISOString(); patch.traite_par = `${admin.prenom || ''} ${admin.nom || ''}`.trim() || null; }
  if (!Object.keys(patch).length) return jsonResponseNoCache({ error: 'rien à mettre à jour' }, 400);
  try { await supabasePatch_('mises_en_relation', `id=eq.${id}`, patch, env); return jsonResponseNoCache({ ok: true }); }
  catch (e) { return jsonResponseNoCache({ error: 'Erreur', detail: e.message }, 500); }
}

// ===== Success stories (preuve sociale) — soumises par les partenaires, validées par le club =====

async function resolvePartenairesByIds_(ids, env, withLogo) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  const sel = withLogo ? 'id,raison_sociale,secteur,logo_b64' : 'id,raison_sociale,secteur';
  const parts = await supabaseQuery('partenaires', `id=in.(${uniq.join(',')})&select=${sel}`, env) || [];
  return Object.fromEntries(parts.map(p => [p.id, p]));
}

async function handlePartnerSuccessStories(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const published = await supabaseQuery('success_stories',
    `statut=eq.publiee&select=id,titre,temoignage,montant,created_at,demandeur_partenaire_id,partenaire_cible_id&order=created_at.desc&limit=100`, env) || [];
  const mine = await supabaseQuery('success_stories',
    `demandeur_partenaire_id=eq.${partner.partenaire_id}&select=id,titre,temoignage,montant,statut,created_at,partenaire_cible_id&order=created_at.desc&limit=50`, env) || [];
  const realizedReqs = await supabaseQuery('mises_en_relation',
    `demandeur_partenaire_id=eq.${partner.partenaire_id}&statut=eq.realisee&select=cible_partenaire_id&order=created_at.desc`, env) || [];
  const byId = await resolvePartenairesByIds_(
    [...published.flatMap(s => [s.demandeur_partenaire_id, s.partenaire_cible_id]), ...mine.map(s => s.partenaire_cible_id), ...realizedReqs.map(r => r.cible_partenaire_id)], env, true);
  const mapStory = s => ({
    id: s.id, titre: s.titre || '', temoignage: s.temoignage || '', montant: s.montant != null ? Number(s.montant) : null,
    statut: s.statut || 'publiee', created_at: s.created_at,
    demandeur: s.demandeur_partenaire_id ? (byId[s.demandeur_partenaire_id] || { raison_sociale: '?' }) : null,
    cible: s.partenaire_cible_id ? (byId[s.partenaire_cible_id] || { raison_sociale: '?' }) : null,
  });
  const seen = new Set(); const realized_partners = [];
  for (const r of realizedReqs) { const p = byId[r.cible_partenaire_id]; if (p && !seen.has(p.id)) { seen.add(p.id); realized_partners.push({ id: p.id, raison_sociale: p.raison_sociale }); } }
  return jsonResponseNoCache({
    published: published.map(mapStory),
    mine: mine.map(s => ({ ...mapStory(s), demandeur: null })),
    realized_partners,
  });
}

async function handlePartnerSuccessStoryCreate(token, body, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const titre = (body.titre == null ? '' : String(body.titre)).trim().slice(0, 160);
  const temoignage = (body.temoignage == null ? '' : String(body.temoignage)).trim().slice(0, 2000);
  if (!titre || !temoignage) return jsonResponseNoCache({ error: 'Titre et témoignage requis' }, 400);
  let cible = String(body.cible_partenaire_id || '').trim(); if (cible && !/^[0-9a-f-]{36}$/.test(cible)) cible = '';
  let intro_id = String(body.intro_id || '').trim(); if (intro_id && !/^[0-9a-f-]{36}$/.test(intro_id)) intro_id = '';
  let montant = null;
  if (body.montant != null && body.montant !== '') { const n = Number(body.montant); if (isFinite(n) && n >= 0) montant = n; }
  try {
    await supabaseInsert_('success_stories', {
      demandeur_partenaire_id: partner.partenaire_id,
      partenaire_cible_id: cible || null,
      intro_id: intro_id || null,
      titre, temoignage, montant, statut: 'en_attente',
    }, env);
  } catch (e) { return jsonResponseNoCache({ error: 'Erreur création', detail: e.message }, 500); }
  try { await notifyAdminsNewStory_(env, { auteur: partner.raison_sociale, titre }); } catch (_) { }
  return jsonResponseNoCache({ ok: true });
}

async function notifyAdminsNewStory_(env, { auteur, titre }) {
  const admins = await supabaseQuery('admins', `actif=eq.true&select=email&limit=10`, env) || [];
  const to = admins.map(a => a.email).filter(Boolean); if (!to.length) return;
  const html = emailLayout('Success story', 'Nouvelle réussite à valider', escEmail(auteur),
    `<p><b>${escEmail(auteur)}</b> a partagé une réussite : « ${escEmail(titre)} ».</p><p>À valider dans Pilote → <b>Success stories</b>.</p>`);
  for (const addr of to) { try { await sendEmailViaResend(env, { to: addr, subject: `Success story à valider — ${auteur}`, html }); } catch (_) { } }
}

async function handleAdminSuccessStoriesList(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'unauthorized' }, 401);
  const rows = await supabaseQuery('success_stories',
    `select=id,titre,temoignage,montant,statut,note_admin,created_at,traite_at,traite_par,demandeur_partenaire_id,partenaire_cible_id&order=created_at.desc&limit=500`, env) || [];
  const byId = await resolvePartenairesByIds_(rows.flatMap(r => [r.demandeur_partenaire_id, r.partenaire_cible_id]), env, false);
  const stories = rows.map(r => ({
    id: r.id, titre: r.titre || '', temoignage: r.temoignage || '', montant: r.montant != null ? Number(r.montant) : null,
    statut: r.statut, note_admin: r.note_admin || '', created_at: r.created_at, traite_at: r.traite_at, traite_par: r.traite_par || '',
    demandeur: byId[r.demandeur_partenaire_id] || { raison_sociale: '?' },
    cible: r.partenaire_cible_id ? (byId[r.partenaire_cible_id] || { raison_sociale: '?' }) : null,
  }));
  return jsonResponseNoCache({ stories, count: stories.length });
}

async function handleAdminSuccessStoryUpdate(token, id, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'unauthorized' }, 401);
  if (!/^[0-9a-f-]{36}$/.test(id)) return jsonResponseNoCache({ error: 'id invalide' }, 400);
  const allowed = ['en_attente', 'publiee', 'refusee'];
  const statut = allowed.includes(body.statut) ? body.statut : null;
  const patch = {};
  if (statut) patch.statut = statut;
  if (body.note_admin !== undefined) patch.note_admin = body.note_admin ? String(body.note_admin).slice(0, 1000) : null;
  if (statut && statut !== 'en_attente') { patch.traite_at = new Date().toISOString(); patch.traite_par = `${admin.prenom || ''} ${admin.nom || ''}`.trim() || null; }
  if (!Object.keys(patch).length) return jsonResponseNoCache({ error: 'rien à mettre à jour' }, 400);
  try { await supabasePatch_('success_stories', `id=eq.${id}`, patch, env); return jsonResponseNoCache({ ok: true }); }
  catch (e) { return jsonResponseNoCache({ error: 'Erreur', detail: e.message }, 500); }
}

async function handlePartnerFicheGet(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const rows = await supabaseQuery('partenaires',
    `id=eq.${partner.partenaire_id}&select=id,raison_sociale,siren,siret,secteur,taille,adresse,code_postal,ville,site_web,email_societe,logo_b64,niveau,expertise,representant,representant_fonction,representant_email,representant_tel,representant_linkedin,representant_photo_b64&limit=1`,
    env);
  if (!rows || !rows.length) return jsonResponseNoCache({ error: 'Fiche introuvable' }, 404);
  return jsonResponseNoCache({ fiche: rows[0] });
}

// Géocodage via l'API Adresse de l'État (BAN) — gratuit, France, sans clé.
async function geocodeBAN_(q) {
  try {
    if (!q) return null;
    const res = await fetch(`https://api-adresse.data.gouv.fr/search/?limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'SpacersBusinessClub/1.0 (contact@spacerstoulouse.fr)' } });
    if (!res.ok) return null;
    const data = await res.json();
    const feat = data && data.features && data.features[0];
    if (feat && feat.geometry && Array.isArray(feat.geometry.coordinates)) {
      const [lon, lat] = feat.geometry.coordinates;
      if (isFinite(lat) && isFinite(lon)) return { lat, lon };
    }
  } catch (_) { }
  return null;
}

// Backfill : géocode par lots de 20 les partenaires ayant une ville mais pas encore de coordonnées.
// Déclenchable en ouvrant l'URL ; relancer jusqu'à "more": false.
async function handleAdminGeocodeBackfill(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'unauthorized' }, 401);
  const rows = await supabaseQuery('partenaires',
    `latitude=is.null&ville=not.is.null&select=id,adresse,code_postal,ville&limit=20`, env);
  let geocoded = 0, failed = 0;
  for (const p of (rows || [])) {
    const q = [p.adresse, p.code_postal, p.ville].filter(Boolean).join(' ');
    const geo = await geocodeBAN_(q);
    if (geo) {
      try { await supabasePatch_('partenaires', `id=eq.${p.id}`, { latitude: geo.lat, longitude: geo.lon }, env); geocoded++; }
      catch (_) { failed++; }
    } else { failed++; }
  }
  const batch = rows ? rows.length : 0;
  return jsonResponseNoCache({
    ok: true, batch, geocoded, failed, more: batch === 20,
    note: batch === 20 ? 'Lot de 20 traité — relance la même URL pour le lot suivant.' : "Terminé : plus d'adresses à géocoder.",
  });
}

async function handlePartnerFicheUpdate(token, body, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const str = (v, max) => { const s = (v == null ? '' : String(v)).trim(); return s ? s.slice(0, max || 300) : null; };
  const patch = {
    secteur: str(body.secteur, 120),
    taille: str(body.taille, 40),
    adresse: str(body.adresse, 300),
    code_postal: str(body.code_postal, 20),
    ville: str(body.ville, 120),
    site_web: str(body.site_web, 300),
    email_societe: str(body.email_societe, 200),
    siret: str(body.siret, 20),
    expertise: str(body.expertise, 500),
    representant: str(body.representant, 160),
    representant_fonction: str(body.representant_fonction, 160),
    representant_email: str(body.representant_email, 200),
    representant_tel: str(body.representant_tel, 40),
    representant_linkedin: str(body.representant_linkedin, 300),
  };
  // Images : ne toucher que si le champ est fourni (string = nouvelle/actuelle, null = effacer)
  if (body.logo_b64 !== undefined) patch.logo_b64 = body.logo_b64 ? String(body.logo_b64).slice(0, 1500000) : null;
  if (body.representant_photo_b64 !== undefined) patch.representant_photo_b64 = body.representant_photo_b64 ? String(body.representant_photo_b64).slice(0, 1500000) : null;
  // Géocodage à la sauvegarde : on calcule lat/lng une seule fois ici (pas en direct sur la carte).
  const addrStr = [patch.adresse, patch.code_postal, patch.ville].filter(Boolean).join(' ');
  if (addrStr) {
    const geo = await geocodeBAN_(addrStr);
    if (geo) { patch.latitude = geo.lat; patch.longitude = geo.lon; }
  } else {
    patch.latitude = null; patch.longitude = null;
  }
  try {
    await supabasePatch_('partenaires', `id=eq.${partner.partenaire_id}`, patch, env);
    return jsonResponseNoCache({ ok: true, geocoded: patch.latitude != null });
  } catch (e) { return jsonResponseNoCache({ error: 'Erreur mise à jour', detail: e.message }, 500); }
}

// --- Auto-remplissage depuis le SIRET (API publique recherche-entreprises.api.gouv.fr, sans clé) ---
function nafSectionLabel_(naf) {
  const d = parseInt(String(naf || '').replace(/\D/g, '').slice(0, 2), 10);
  if (!d) return '';
  const map = [
    [1, 3, 'Agriculture, sylviculture et pêche'],
    [5, 9, 'Industries extractives'],
    [10, 33, 'Industrie manufacturière'],
    [35, 35, "Production et distribution d'électricité et de gaz"],
    [36, 39, 'Eau, assainissement et gestion des déchets'],
    [41, 43, 'Construction'],
    [45, 47, 'Commerce et réparation automobile'],
    [49, 53, 'Transports et entreposage'],
    [55, 56, 'Hébergement et restauration'],
    [58, 63, 'Information et communication'],
    [64, 66, "Activités financières et d'assurance"],
    [68, 68, 'Activités immobilières'],
    [69, 75, 'Activités spécialisées, scientifiques et techniques'],
    [77, 82, 'Services administratifs et de soutien'],
    [84, 84, 'Administration publique'],
    [85, 85, 'Enseignement'],
    [86, 88, 'Santé humaine et action sociale'],
    [90, 93, 'Arts, spectacles et activités récréatives'],
    [94, 96, 'Autres activités de services'],
    [97, 98, 'Activités des ménages en tant employeurs'],
    [99, 99, 'Activités extra-territoriales'],
  ];
  for (const row of map) { if (d >= row[0] && d <= row[1]) return row[2]; }
  return '';
}

async function lookupSiret_(q, env) {
  const clean = String(q || '').replace(/\s/g, '');
  if (!/^\d{9}$/.test(clean) && !/^\d{14}$/.test(clean)) {
    return { error: 'Numéro SIRET (14 chiffres) ou SIREN (9 chiffres) attendu' };
  }
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(clean)}&per_page=1`;
  let resp;
  try {
    resp = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'SpacersBusinessClub/1.0' } });
  } catch (e) { return { error: 'Service annuaire entreprises indisponible' }; }
  if (!resp.ok) return { error: `Service annuaire entreprises : erreur ${resp.status}` };
  let data;
  try { data = await resp.json(); } catch (e) { return { error: 'Réponse illisible du service' }; }
  const r = (data.results && data.results[0]) || null;
  if (!r) return { error: 'Aucune entreprise trouvée pour ce numéro' };
  const s = r.siege || {};
  const naf = s.activite_principale || r.activite_principale || '';
  const libelle = s.libelle_activite_principale || r.libelle_activite_principale || '';
  const secteur = libelle || nafSectionLabel_(naf) || naf || '';
  const adresseVoie = [s.numero_voie, s.type_voie, s.libelle_voie].filter(Boolean).join(' ').trim();
  let adresse = adresseVoie;
  if (!adresse && s.adresse) adresse = String(s.adresse).replace(/\s*\d{5}\s+.*$/, '').trim();
  return {
    raison_sociale: r.nom_raison_sociale || r.nom_complet || '',
    siren: r.siren || '',
    siret: s.siret || (clean.length === 14 ? clean : ''),
    naf,
    secteur,
    adresse: adresse || (s.adresse || ''),
    code_postal: s.code_postal || '',
    ville: s.libelle_commune || '',
  };
}

async function handlePartnerSiretLookup(token, searchParams, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const out = await lookupSiret_(searchParams.get('q'), env);
  return jsonResponseNoCache(out, out.error ? 422 : 200);
}

async function handleAdminSiretLookup(token, searchParams, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const out = await lookupSiret_(searchParams.get('q'), env);
  return jsonResponseNoCache(out, out.error ? 422 : 200);
}

// Complète en masse le secteur (+ CP/ville manquants) de tous les partenaires depuis leur SIREN/SIRET
async function handleAdminEnrichSecteurs(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('partenaires',
    `select=id,raison_sociale,secteur,siret,siren,code_postal,ville&limit=500`, env);
  const results = [];
  for (const p of (rows || [])) {
    const hasSecteur = p.secteur && String(p.secteur).trim();
    const key = (p.siret && String(p.siret).trim()) || (p.siren && String(p.siren).trim());
    if (hasSecteur || !key) { results.push({ raison_sociale: p.raison_sociale, skipped: true }); continue; }
    const out = await lookupSiret_(key, env);
    if (out.error || !out.secteur) { results.push({ raison_sociale: p.raison_sociale, error: out.error || 'secteur introuvable' }); continue; }
    const patch = { secteur: out.secteur };
    if (out.code_postal && !p.code_postal) patch.code_postal = out.code_postal;
    if (out.ville && !p.ville) patch.ville = out.ville;
    try {
      await supabasePatch_('partenaires', `id=eq.${p.id}`, patch, env);
      results.push({ raison_sociale: p.raison_sociale, secteur: out.secteur });
    } catch (e) { results.push({ raison_sociale: p.raison_sociale, error: e.message }); }
  }
  logAudit_(admin.id, 'partenaires.enrich_secteurs', 'partenaires', null, {}, env);
  return jsonResponseNoCache({ ok: true, updated: results.filter(r => r.secteur).length, results });
}

// ============================================================================
//  ACTUALITÉS DU CLUB (posts LinkedIn / réseaux sociaux)
// ============================================================================
async function handlePartnerSocialFeed(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const rows = await supabaseQuery('social_posts',
    `visible=eq.true&order=published_at.desc&limit=50&select=id,source,url,contenu,image_b64,image_url,auteur,published_at`,
    env);
  const posts = (rows || []).map(p => ({
    id: p.id,
    source: p.source || 'linkedin',
    url: p.url || '',
    contenu: p.contenu || '',
    image: p.image_b64 || p.image_url || null,
    auteur: p.auteur || 'Spacers Toulouse Volley',
    published_at: p.published_at || null,
  }));
  return jsonResponseNoCache({ posts, count: posts.length });
}

async function handleAdminSocialList(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('social_posts',
    `order=published_at.desc&limit=300&select=id,source,url,contenu,image_b64,image_url,auteur,published_at,visible,created_at`,
    env);
  return jsonResponseNoCache({ posts: rows || [] });
}

async function handleAdminSocialUpsert(token, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  if (body.id && !/^[0-9a-f-]{36}$/i.test(String(body.id))) return jsonResponseNoCache({ error: 'id invalide' }, 400);
  const str = (v, max) => { const s = (v == null ? '' : String(v)).trim(); return s ? s.slice(0, max || 5000) : null; };
  const rec = {
    source: str(body.source, 40) || 'linkedin',
    url: str(body.url, 600),
    contenu: str(body.contenu, 6000),
    auteur: str(body.auteur, 160) || 'Spacers Toulouse Volley',
    visible: body.visible === false ? false : true,
  };
  if (body.published_at) { const d = new Date(body.published_at); if (!isNaN(d.getTime())) rec.published_at = d.toISOString(); }
  if (body.image_b64 !== undefined) rec.image_b64 = body.image_b64 ? String(body.image_b64).slice(0, 1500000) : null;
  if (body.image_url !== undefined) rec.image_url = str(body.image_url, 600);
  try {
    if (body.id) {
      await supabasePatch_('social_posts', `id=eq.${body.id}`, rec, env);
      logAudit_(admin.id, 'social.update', 'social_posts', body.id, {}, env);
      return jsonResponseNoCache({ ok: true, id: body.id });
    }
    if (!rec.published_at) rec.published_at = new Date().toISOString();
    const created = await supabaseInsert_('social_posts', rec, env);
    const id = Array.isArray(created) ? (created[0] && created[0].id) : (created && created.id);
    logAudit_(admin.id, 'social.create', 'social_posts', id, {}, env);
    return jsonResponseNoCache({ ok: true, id });
  } catch (e) { return jsonResponseNoCache({ error: 'Erreur enregistrement', detail: e.message }, 500); }
}

async function handleAdminSocialDelete(token, id, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/social_posts?id=eq.${id}`, { method: 'DELETE', headers: supabaseHeaders(env) });
    logAudit_(admin.id, 'social.delete', 'social_posts', id, {}, env);
    return jsonResponseNoCache({ ok: true });
  } catch (e) { return jsonResponseNoCache({ error: 'Erreur suppression', detail: e.message }, 500); }
}

function stripHtml_(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Ingestion automatique (Make.com / RSS) — protégée par SOCIAL_INGEST_SECRET, dédoublonnée par url
async function handleSocialIngest(request, body, env) {
  const secret = request.headers.get('x-ingest-secret') || new URL(request.url).searchParams.get('secret') || '';
  if (!env.SOCIAL_INGEST_SECRET || secret !== env.SOCIAL_INGEST_SECRET) {
    return jsonResponseNoCache({ error: 'Unauthorized' }, 401);
  }
  const str = (v, max) => { const s = (v == null ? '' : String(v)).trim(); return s ? s.slice(0, max || 6000) : null; };
  const rec = {
    source: str(body.source, 40) || 'linkedin',
    url: str(body.url, 600),
    contenu: str(stripHtml_(body.contenu), 6000),
    image_url: str(body.image_url, 600),
    auteur: str(body.auteur, 160) || 'Spacers Toulouse Volley',
    visible: body.visible === false ? false : true,
  };
  if (body.published_at) { const d = new Date(body.published_at); if (!isNaN(d.getTime())) rec.published_at = d.toISOString(); }
  if (!rec.published_at) rec.published_at = new Date().toISOString();
  if (!rec.url && !rec.contenu) return jsonResponseNoCache({ error: 'url ou contenu requis' }, 400);
  try {
    if (rec.url) {
      const existing = await supabaseQuery('social_posts', `url=eq.${encodeURIComponent(rec.url)}&select=id&limit=1`, env);
      if (existing && existing.length) {
        await supabasePatch_('social_posts', `id=eq.${existing[0].id}`, rec, env);
        return jsonResponseNoCache({ ok: true, action: 'updated', id: existing[0].id });
      }
    }
    const created = await supabaseInsert_('social_posts', rec, env);
    const id = Array.isArray(created) ? (created[0] && created[0].id) : (created && created.id);
    return jsonResponseNoCache({ ok: true, action: 'created', id });
  } catch (e) { return jsonResponseNoCache({ error: 'Erreur ingestion', detail: e.message }, 500); }
}

async function handlePartnerBoard(token, queryParams, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const typeFilter = queryParams.get('type');
  const nowIso = new Date().toISOString();
  let filters = ['statut=eq.publie'];
  if (typeFilter && PUB_TYPES.includes(typeFilter)) filters.push(`type=eq.${typeFilter}`);
  filters.push(`or=(date_expiration.is.null,date_expiration.gt.${nowIso})`);
  filters.push('select=id,type,titre,description,categorie,data,date_publication,date_expiration,reponses_count,contrat_id,partenaire_id,created_at,partenaires(raison_sociale)');
  filters.push('order=date_publication.desc.nullslast');
  filters.push('limit=150');

  const rows = await supabaseQuery('publications', filters.join('&'), env);

  let mesReponses = new Set();
  try {
    const reps = await supabaseQuery('reponses_publications', `contrat_id=eq.${partner.contrat_id}&select=publication_id&limit=500`, env);
    (reps || []).forEach(r => mesReponses.add(r.publication_id));
  } catch (_) {}

  const publications = (rows || []).map(p => ({
    id: p.id, type: p.type, titre: p.titre, description: p.description || '',
    categorie: p.categorie || '', data: p.data || {},
    partenaire: (p.partenaires && p.partenaires.raison_sociale) || 'Partenaire',
    date_publication: p.date_publication, reponses_count: p.reponses_count || 0,
    is_mine: p.contrat_id === partner.contrat_id,
    deja_repondu: mesReponses.has(p.id),
  }));
  return jsonResponseNoCache({ publications, meta: { generated_at: nowIso } });
}

async function handlePartnerPublicationRespond(token, pubId, body, env, ctx) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const message = String(body.message || '').trim();
  if (!message) return jsonResponseNoCache({ error: 'Le message est obligatoire' }, 400);

  const rows = await supabaseQuery('publications', `id=eq.${pubId}&select=id,statut,contrat_id,partenaire_id,titre,type,contact_email&limit=1`, env);
  if (!rows || !rows.length) return jsonResponseNoCache({ error: 'Publication introuvable' }, 404);
  const pub = rows[0];
  if (pub.statut !== 'publie') return jsonResponseNoCache({ error: 'Cette annonce n\'est plus disponible' }, 400);
  if (pub.contrat_id === partner.contrat_id) return jsonResponseNoCache({ error: 'Vous ne pouvez pas répondre à votre propre annonce' }, 400);

  const repNom = String(body.contact_nom || partner.representant || '').trim() || null;
  const repEmail = String(body.contact_email || '').trim() || null;
  const insertData = {
    publication_id: pubId,
    contrat_id: partner.contrat_id,
    partenaire_id: partner.partenaire_id,
    partenaire_nom: partner.raison_sociale || null,
    contact_nom: repNom,
    contact_email: repEmail,
    message,
  };
  try {
    await supabaseInsert_('reponses_publications', insertData, env);
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur enregistrement', detail: e.message }, 500);
  }

  try {
    const all = await supabaseQuery('reponses_publications', `publication_id=eq.${pubId}&select=id`, env);
    await supabasePatch_('publications', `id=eq.${pubId}`, { reponses_count: (all || []).length }, env);
  } catch (_) {}

  // Notification email à l'auteur de l'annonce (non bloquant)
  const notify = (async () => {
    try {
      let authorEmail = (pub.contact_email || '').trim();
      if (!authorEmail && pub.partenaire_id) {
        const contacts = await supabaseQuery('partenaire_contacts', `partenaire_id=eq.${pub.partenaire_id}&select=email&limit=5`, env);
        const c = (contacts || []).find(x => x.email && x.email.includes('@'));
        if (c) authorEmail = c.email.trim();
      }
      if (!authorEmail || !authorEmail.includes('@')) return;
      await sendEmailViaResend(env, {
        to: authorEmail,
        from: EMAIL_FROM,
        replyTo: repEmail || EMAIL_REPLY_TO_CLUB,
        subject: `Nouvelle réponse à votre annonce — ${pub.titre}`,
        html: renderReponseNotifEmail(pub, { partenaire_nom: partner.raison_sociale, contact_nom: repNom, contact_email: repEmail, message }),
      });
    } catch (_) {}
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(notify); else await notify;

  return jsonResponseNoCache({ ok: true, message: 'Votre réponse a été transmise au partenaire.' });
}

function renderReponseNotifEmail(pub, rep) {
  const typeLabel = { forum: 'Forum', proposition: 'Proposition', echange: 'Demande de service' }[pub.type] || 'Annonce';
  const contactLine = [rep.contact_nom, rep.contact_email].filter(Boolean).map(escEmail).join(' · ');
  return `<!doctype html><html><body style="margin:0;background:#FAF7F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#FAF7F2;padding:24px 0;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;background:#fff;border:1px solid #E5DED1;border-radius:16px;overflow:hidden;">
      <tr><td style="background:linear-gradient(135deg,#11203a,#0A1628);padding:24px 30px;">
        <div style="color:#E8C977;font-size:11px;font-weight:700;letter-spacing:2px;">NOUVELLE RÉPONSE · ${escEmail(typeLabel)}</div>
        <div style="color:#fff;font-family:Georgia,serif;font-size:22px;margin-top:6px;">${escEmail(pub.titre)}</div>
      </td></tr>
      <tr><td style="padding:24px 30px;">
        <p style="font-size:14px;color:#4A5568;line-height:1.7;margin:0 0 14px;"><strong style="color:#0A1628;">${escEmail(rep.partenaire_nom || 'Un partenaire')}</strong> a répondu à votre annonce sur le réseau partenaires :</p>
        <div style="background:#FAF7F2;border-left:3px solid #C8932B;border-radius:8px;padding:14px 16px;font-size:14px;color:#0A1628;line-height:1.6;white-space:pre-wrap;">${escEmail(rep.message || '')}</div>
        ${contactLine ? `<p style="font-size:13px;color:#C8932B;margin:14px 0 0;">Contact : ${contactLine}</p>` : ''}
        <p style="font-size:13px;color:#8A8478;margin:18px 0 0;line-height:1.6;">Vous pouvez répondre directement à cet email pour entrer en contact${rep.contact_email ? '' : ' avec l\'équipe du club'}.</p>
      </td></tr>
      <tr><td style="background:#FAF7F2;border-top:1px solid #E5DED1;padding:14px 30px;text-align:center;font-size:11px;color:#8A8478;">Spacer's Toulouse Volley · Business Club</td></tr>
    </table>
  </td></tr></table>
  </body></html>`;
}

async function handlePartnerPublicationReponses(token, pubId, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);

  const rows = await supabaseQuery('publications', `id=eq.${pubId}&select=id,contrat_id,titre,type&limit=1`, env);
  if (!rows || !rows.length) return jsonResponseNoCache({ error: 'Publication introuvable' }, 404);
  const pub = rows[0];
  if (pub.contrat_id !== partner.contrat_id) return jsonResponseNoCache({ error: 'Accès refusé' }, 403);

  const reps = await supabaseQuery('reponses_publications', `publication_id=eq.${pubId}&select=partenaire_nom,contact_nom,contact_email,message,created_at&order=created_at.desc&limit=200`, env);
  return jsonResponseNoCache({ publication: { id: pub.id, titre: pub.titre, type: pub.type }, reponses: reps || [] });
}

// ============================================================================
//  SPRINT TICKIE — Rencontres (matchs) + allocations places VIP
//  Push Tickie en STUB (branché une fois l'API provider confirmée).
// ============================================================================

const SAISON_ACTIVE_TICKIE = '2026-2027';

// Stub : sera branché plus tard pour créer l'event Tickie + attribuer le contingent.
async function pushRencontreToTickie_(rencontreId, env) {
  // TODO Tickie :
  //  1) créer/retrouver l'event Tickie -> rencontres.tickie_event_id
  //  2) pour chaque rencontre_allocations : attribuer le contingent -> tickie_allocation_id
  // En attente des réponses provider (allocation par compte/match via API + fenêtre d'ouverture).
  return { stub: true, message: 'Push Tickie non branché (en attente API provider)' };
}

// --- ADMIN : liste des rencontres de la saison + stats d'allocations ---
async function handleAdminRencontresList(token, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const rows = await supabaseQuery('rencontres',
    `saison=eq.${SAISON_ACTIVE_TICKIE}&select=id,adversaire,competition,date_match,date_ouverture,lieu,statut,tickie_event_id&order=date_match.asc&limit=200`,
    env);

  const ids = (rows || []).map(r => r.id);
  const statsByRen = {};
  if (ids.length) {
    const allocs = await supabaseQuery('rencontre_allocations',
      `rencontre_id=in.(${ids.join(',')})&select=rencontre_id,nb_places,nb_retires`, env);
    for (const a of (allocs || [])) {
      const k = a.rencontre_id;
      if (!statsByRen[k]) statsByRen[k] = { nb_partenaires: 0, total_places: 0, total_retires: 0 };
      statsByRen[k].nb_partenaires += 1;
      statsByRen[k].total_places += Number(a.nb_places || 0);
      statsByRen[k].total_retires += Number(a.nb_retires || 0);
    }
  }

  const rencontres = (rows || []).map(r => ({
    id: r.id,
    adversaire: r.adversaire || '',
    competition: r.competition || '',
    date_match: r.date_match,
    date_ouverture: r.date_ouverture,
    lieu: r.lieu || 'domicile',
    statut: r.statut || 'brouillon',
    tickie_event_id: r.tickie_event_id || null,
    stats: statsByRen[r.id] || { nb_partenaires: 0, total_places: 0, total_retires: 0 },
  }));
  return jsonResponseNoCache({ saison: SAISON_ACTIVE_TICKIE, count: rencontres.length, rencontres });
}

// --- ADMIN : créer une rencontre (J-15 auto si date_ouverture absente) ---
async function handleAdminRencontreCreate(token, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const adversaire = String(body.adversaire || '').trim();
  if (!adversaire) return jsonResponseNoCache({ error: 'Adversaire obligatoire' }, 400);
  const dateMatch = String(body.date_match || '').trim();
  if (!dateMatch) return jsonResponseNoCache({ error: 'Date du match obligatoire' }, 400);

  let dateOuverture = body.date_ouverture ? String(body.date_ouverture).trim() : null;
  if (!dateOuverture) {
    const d = new Date(dateMatch);
    if (!isNaN(d.getTime())) { d.setDate(d.getDate() - 15); dateOuverture = d.toISOString(); }
  }

  const insertData = {
    saison: SAISON_ACTIVE_TICKIE,
    adversaire,
    competition: body.competition ? String(body.competition).trim() : null,
    date_match: dateMatch,
    date_ouverture: dateOuverture,
    lieu: body.lieu ? String(body.lieu).trim() : 'domicile',
    statut: 'brouillon',
    notes: body.notes ? String(body.notes).trim() : null,
  };
  try {
    const arr = await supabaseInsert_('rencontres', insertData, env);
    return jsonResponseNoCache({ ok: true, rencontre: Array.isArray(arr) ? arr[0] : arr });
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur création rencontre', detail: e.message }, 500);
  }
}

// --- ADMIN : ouvrir une rencontre = générer les allocations depuis les packs VIP ---
async function handleAdminRencontreOuvrir(token, rid, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);

  const renRows = await supabaseQuery('rencontres', `id=eq.${rid}&select=id,saison,statut&limit=1`, env);
  if (!renRows || !renRows.length) return jsonResponseNoCache({ error: 'Rencontre introuvable' }, 404);
  const ren = renRows[0];

  const contrats = await supabaseQuery('contrats',
    `saison=eq.${ren.saison}&select=id,partenaire_id,packs_places(id,alloues)`, env);

  const existing = await supabaseQuery('rencontre_allocations', `rencontre_id=eq.${rid}&select=contrat_id`, env);
  const deja = new Set((existing || []).map(a => a.contrat_id));

  const toInsert = [];
  for (const c of (contrats || [])) {
    if (deja.has(c.id)) continue;
    const pack = Array.isArray(c.packs_places) ? c.packs_places[0] : c.packs_places;
    const nb = pack ? Number(pack.alloues || 0) : 0;
    if (nb <= 0) continue;
    toInsert.push({
      rencontre_id: rid,
      contrat_id: c.id,
      partenaire_id: c.partenaire_id,
      pack_id: pack ? pack.id : null,
      nb_places: nb,
      statut: 'ouverte',
    });
  }

  let created = 0;
  if (toInsert.length) {
    const arr = await supabaseInsert_('rencontre_allocations', toInsert, env);
    created = Array.isArray(arr) ? arr.length : 0;
  }

  await supabasePatch_('rencontres', `id=eq.${rid}`,
    { statut: 'ouverte', updated_at: new Date().toISOString() }, env);

  const tickie = await pushRencontreToTickie_(rid, env);
  return jsonResponseNoCache({ ok: true, allocations_creees: created, statut: 'ouverte', tickie });
}

// --- ADMIN : fermer une rencontre (masque côté partenaire) ---
async function handleAdminRencontreFermer(token, rid, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  await supabasePatch_('rencontres', `id=eq.${rid}`,
    { statut: 'fermee', updated_at: new Date().toISOString() }, env);
  return jsonResponseNoCache({ ok: true, statut: 'fermee' });
}

// --- ADMIN : allocations d'une rencontre (avec raison sociale) ---
async function handleAdminRencontreAllocations(token, rid, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const rows = await supabaseQuery('rencontre_allocations',
    `rencontre_id=eq.${rid}&select=id,contrat_id,partenaire_id,nb_places,nb_retires,statut,tickie_allocation_id,partenaires(raison_sociale)&order=nb_places.desc`,
    env);
  const allocations = (rows || []).map(a => ({
    id: a.id,
    contrat_id: a.contrat_id,
    partenaire_id: a.partenaire_id,
    raison_sociale: a.partenaires?.raison_sociale || '',
    nb_places: Number(a.nb_places || 0),
    nb_retires: Number(a.nb_retires || 0),
    statut: a.statut || '',
  }));
  return jsonResponseNoCache({ rencontre_id: rid, count: allocations.length, allocations });
}

// --- ADMIN : ajuster une allocation (places / retirées / statut) ---
async function handleAdminAllocationUpdate(token, aid, body, env) {
  const admin = await authAdmin_(token, env);
  if (!admin) return jsonResponseNoCache({ error: 'Invalid admin token' }, 401);
  const patch = {};
  if (body.nb_places != null)  patch.nb_places  = Math.max(0, parseInt(body.nb_places, 10) || 0);
  if (body.nb_retires != null) patch.nb_retires = Math.max(0, parseInt(body.nb_retires, 10) || 0);
  if (body.statut) patch.statut = String(body.statut).trim();
  if (Object.keys(patch).length === 0) return jsonResponseNoCache({ error: 'Rien à mettre à jour' }, 400);
  patch.updated_at = new Date().toISOString();
  try {
    const arr = await supabasePatch_('rencontre_allocations', `id=eq.${aid}`, patch, env);
    return jsonResponseNoCache({ ok: true, allocation: Array.isArray(arr) ? arr[0] : arr });
  } catch (e) {
    return jsonResponseNoCache({ error: 'Erreur MAJ allocation', detail: e.message }, 500);
  }
}

// --- PARTENAIRE : mes places VIP sur les rencontres ouvertes ---
async function handlePartnerPlaces(token, env) {
  const partner = await authPartner_(token, env);
  if (!partner) return jsonResponseNoCache({ error: 'Invalid partner token' }, 401);
  const rows = await supabaseQuery('rencontre_allocations',
    `contrat_id=eq.${partner.contrat_id}&select=id,nb_places,nb_retires,statut,tickie_allocation_id,rencontres(id,adversaire,competition,date_match,date_ouverture,statut,tickie_event_id)&order=created_at.desc`,
    env);
  const places = (rows || [])
    .filter(a => a.rencontres && a.rencontres.statut === 'ouverte')
    .map(a => ({
      allocation_id: a.id,
      adversaire: a.rencontres.adversaire || '',
      competition: a.rencontres.competition || '',
      date_match: a.rencontres.date_match,
      nb_places: Number(a.nb_places || 0),
      nb_retires: Number(a.nb_retires || 0),
      tickie_event_id: a.rencontres.tickie_event_id || null,
      tickie_url: null, // rempli quand le provider aura confirmé l'espace de retrait
    }))
    .sort((x, y) => new Date(x.date_match) - new Date(y.date_match));
  return jsonResponseNoCache({ contrat_id: partner.contrat_id, count: places.length, places });
}
