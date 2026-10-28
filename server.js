'use strict';
/*
 * Star Discussion — serveur
 * Aucune dépendance : il suffit de Node.js 18 ou plus récent.
 *   node server.js
 * Comptes (e-mail + mot de passe), vérification de l'e-mail par code à 6 chiffres,
 * mot de passe oublié, chat en temps réel (Server-Sent Events), bots exécutés côté serveur,
 * permissions vérifiées côté serveur.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

/* ---------- Configuration (.env) ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (_) { /* pas de .env : valeurs par défaut */ }
const ENV = process.env;
const PORT = +ENV.PORT || 3000;
const APP_NAME = ENV.APP_NAME || 'Star Discussion';
let DATA_DIR = ENV.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); }
catch (e) { console.warn(`Dossier de données "${DATA_DIR}" inaccessible (${e.code}). Utilisation du dossier local "data" : les comptes seront perdus au prochain redémarrage.`); DATA_DIR = path.join(__dirname, 'data'); fs.mkdirSync(DATA_DIR, { recursive: true }); }
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_EMAIL = (ENV.ADMIN_EMAIL || '').trim().toLowerCase();
const CODE_TTL = 10 * 60 * 1000;          // un code est valable 10 minutes
const CODE_COOLDOWN = 60 * 1000;          // 1 renvoi par minute
const CODE_MAX_TRIES = 5;
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 jours

/* ---------- Utilitaires ---------- */
const uid = () => crypto.randomBytes(6).toString('base64url');
const now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'salon';
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;
const USER_RE = /^[\p{L}\p{N}_.\- ]{2,24}$/u;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  try {
    const [, salt, hash] = stored.split('$');
    const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
  } catch (_) { return false; }
}

/* ---------- Données de départ ---------- */
const PERMS = ['admin', 'channels', 'roles', 'bots', 'creators', 'redm', 'fivem', 'kick', 'ban', 'send', 'voice', 'everyone'];
function seedState() {
  const R = (id, name, color, p) => ({ id, name, color, perms: Object.fromEntries(PERMS.map(k => [k, p.includes('*') || p.includes(k)])) });
  const C = (id, name, type, cat, topic = '') => ({ id, name, type, cat, topic });
  const t = now();
  return {
    roles: [R('r_fond', 'Fondateur', '#F5B841', ['*']), R('r_admin', 'Admin', '#F2545B', ['admin']), R('r_modo', 'Modérateur', '#6B95FF', ['channels', 'kick', 'send', 'voice', 'redm', 'fivem', 'creators']), R('r_crea', 'Créateur TikTok', '#FF5FA8', ['send', 'voice']), R('r_vip', 'VIP', '#3DD68C', ['send', 'voice']), R('r_membre', 'Membre', '#9499C6', ['send', 'voice'])],
    members: [],
    cats: [{ id: 'k1', name: 'Accueil' }, { id: 'k2', name: 'Agence' }, { id: 'k3', name: 'Vocaux' }],
    channels: [C('bienvenue', 'bienvenue', 'text', 'k1', 'Les nouveaux arrivent ici'), C('annonces', 'annonces', 'text', 'k1', 'Infos officielles'), C('regles', 'règles', 'text', 'k1', 'À lire avant tout'), C('general', 'général', 'text', 'k2', 'Discussion libre'), C('planning', 'planning-lives', 'text', 'k2', 'Qui est en live et quand'), C('bugs', 'support-bugs', 'text', 'k2', 'Signalez un souci sur RedM, FiveM ou l\'app'), C('v1', 'Salon vocal', 'voice', 'k3'), C('v2', 'Réunion agence', 'voice', 'k3')],
    messages: { regles: [{ id: uid(), bot: 'b1', ts: t, embed: { title: 'Règles du serveur', desc: '1. Respect de tous les membres.\n2. Pas de pub sans accord du staff.\n3. Une journée de live est validée à partir d\'1 h.\n4. Les bugs RedM/FiveM se signalent dans #support-bugs.', color: '#F5B841' } }] },
    bots: [{
      id: 'b1', name: 'StarBot', color: '#F5B841', prefix: '!', status: 'Veille sur le serveur', enabled: true,
      commands: [
        { id: uid(), on: true, trigger: 'salut', type: 'prefix', desc: 'Dire bonjour', role: '', actions: [{ id: uid(), kind: 'reply', value: 'Salut {user} ! Tape !help pour voir toutes mes commandes.' }] },
        { id: uid(), on: true, trigger: 'de', type: 'prefix', desc: 'Lancer un dé', role: '', actions: [{ id: uid(), kind: 'dice', value: 6 }] },
        { id: uid(), on: true, trigger: '8ball', type: 'prefix', desc: 'Pose une question au destin', role: '', actions: [{ id: uid(), kind: 'random', value: 'Oui|Non|Peut-être|Sans aucun doute|Redemande plus tard', value2: '{user}, la boule magique répond : **{result}**' }] },
        { id: uid(), on: true, trigger: 'sondage', type: 'prefix', desc: '!sondage Question | Choix 1 | Choix 2', role: '', actions: [{ id: uid(), kind: 'poll', value: 'On fait un live commun ce soir ?' }] },
        { id: uid(), on: true, trigger: 'clear', type: 'prefix', desc: 'Supprimer les derniers messages', role: 'r_modo', actions: [{ id: uid(), kind: 'clear', value: 5 }] },
        { id: uid(), on: true, trigger: 'annonce', type: 'prefix', desc: 'Publier dans #annonces', role: 'r_admin', actions: [{ id: uid(), kind: 'sendTo', channel: 'annonces', value: '**Annonce de {user}** : {args}' }, { id: uid(), kind: 'reply', value: 'Annonce publiée dans #annonces.' }] }
      ],
      welcome: { on: true, channel: 'bienvenue', text: 'Bienvenue {user} sur **{server}** ! Lis #règles et présente-toi.', role: 'r_membre' },
      automod: { on: true, words: 'arnaque, free diamonds', warn: '{user}, ton message a été supprimé : mot interdit.', action: 'delete' },
      levels: { on: true, channel: '', text: 'GG {user}, tu passes niveau **{level}** !' },
      schedules: []
    }],
    creators: [],
    servers: {
      redm: { name: 'Serveur RedM', ip: '0.0.0.0:30120', status: 'online', whitelist: true, crisis: false, maintMsg: '', slots: 64, online: 0, players: [], incidents: [], log: [] },
      fivem: { name: 'Serveur FiveM', ip: '0.0.0.0:30120', status: 'online', whitelist: true, crisis: false, maintMsg: '', slots: 128, online: 0, players: [], incidents: [], log: [] }
    },
    voice: {}, banned: [], audit: [],
    settings: { serverName: APP_NAME, validHours: 1, rate: 0.005, backstageUrl: 'https://live-backstage.tiktok.com/' }
  };
}

/* ---------- Stockage (fichier JSON, écriture atomique) ---------- */
let DB;
try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) { DB = null; }
if (!DB || !DB.S) DB = { users: [], sessions: {}, S: seedState() };
fs.mkdirSync(DATA_DIR, { recursive: true });
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB));
    fs.renameSync(tmp, DB_FILE);
  }, 300);
}
const S = () => DB.S;

/* ---------- Envoi d'e-mails (client SMTP intégré) ---------- */
const mailConfigured = () => !!ENV.SMTP_HOST;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
function smtpSend({ to, subject, text, html }) {
  return new Promise((resolve, reject) => {
    const host = ENV.SMTP_HOST, port = +ENV.SMTP_PORT || 465;
    const implicitTLS = ENV.SMTP_SECURE ? ENV.SMTP_SECURE === 'true' : port === 465;
    const from = ENV.MAIL_FROM || `${APP_NAME} <${ENV.SMTP_USER}>`;
    const fromAddr = (from.match(/<([^>]+)>/) || [, from])[1].trim();
    let sock, buf = '', lines = [];
    const replies = [], waiters = [];
    const feed = d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) {
          const r = { code: +line.slice(0, 3), text: lines.join('\n') }; lines = [];
          waiters.length ? waiters.shift()(r) : replies.push(r);
        }
      }
    };
    const attach = s => { sock = s; s.on('data', feed); s.on('error', fail); s.setTimeout(20000, () => fail(new Error('Le serveur SMTP ne répond pas'))); };
    let done = false;
    const fail = e => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} reject(e); };
    const read = () => new Promise(r => replies.length ? r(replies.shift()) : waiters.push(r));
    const cmd = async (c, ok) => {
      if (c != null) sock.write(c + '\r\n');
      const r = await read();
      if (!ok.includes(r.code)) throw new Error('SMTP : ' + r.text.split('\n').pop());
      return r;
    };
    (async () => {
      attach(implicitTLS ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
      await cmd(null, [220]);
      let ehlo = await cmd('EHLO star-discussion', [250]);
      if (!implicitTLS && /STARTTLS/i.test(ehlo.text) && ENV.SMTP_STARTTLS !== 'false') {
        await cmd('STARTTLS', [220]);
        sock.removeAllListeners('data'); sock.removeAllListeners('error'); sock.setTimeout(0);
        const secure = tls.connect({ socket: sock, servername: host });
        await new Promise((r, j) => { secure.once('secureConnect', r); secure.once('error', j); });
        attach(secure);
        ehlo = await cmd('EHLO star-discussion', [250]);
      }
      if (ENV.SMTP_USER) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(b64(ENV.SMTP_USER), [334]);
        await cmd(b64(ENV.SMTP_PASS || ''), [235]);
      }
      await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      const boundary = 'sd_' + uid();
      const enc = s => b64(s).replace(/.{76}/g, '$&\r\n');
      const msg = [
        `From: ${from.replace(/^([^<]+)</, (m, n) => `=?UTF-8?B?${b64(n.trim())}?= <`)}`,
        `To: <${to}>`,
        `Subject: =?UTF-8?B?${b64(subject)}?=`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${uid()}.${now()}@${fromAddr.split('@')[1] || 'star-discussion'}>`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', enc(text),
        `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', enc(html),
        `--${boundary}--`, ''
      ].join('\r\n');
      sock.write(msg + '\r\n.\r\n');
      await cmd(null, [250]);
      sock.write('QUIT\r\n'); done = true; sock.end(); resolve();
    })().catch(fail);
  });
}
async function sendCodeMail(user, code, kind) {
  const what = kind === 'reset' ? 'réinitialiser ton mot de passe' : 'vérifier ton adresse e-mail';
  const subject = kind === 'reset' ? `${code} — ton code pour changer de mot de passe` : `${code} — ton code de vérification ${APP_NAME}`;
  const text = `Salut ${user.username},\n\nVoici ton code pour ${what} sur ${APP_NAME} : ${code}\n\nIl est valable 10 minutes. Si tu n'as rien demandé, ignore cet e-mail.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1d33">
<h2 style="margin:0 0 12px">${APP_NAME}</h2><p>Salut ${user.username.replace(/[<>&]/g, '')},</p><p>Voici ton code pour ${what} :</p>
<p style="font-size:34px;letter-spacing:10px;font-weight:bold;background:#f4f1fa;padding:16px;text-align:center;border-radius:12px">${code}</p>
<p style="color:#666">Il est valable 10 minutes. Si tu n'as rien demandé, ignore cet e-mail.</p></div>`;
  if (!mailConfigured()) {
    console.log(`\n[MODE TEST — SMTP non configuré] Code pour ${user.email} (${kind}) : ${code}\n`);
    return;
  }
  await smtpSend({ to: user.email, subject, text, html });
}
async function issueCode(user, kind) {
  if (user.code && user.code.kind === kind && now() - user.code.sent < CODE_COOLDOWN) {
    const wait = Math.ceil((CODE_COOLDOWN - (now() - user.code.sent)) / 1000);
    const e = new Error(`Attends ${wait} s avant de demander un nouveau code.`); e.status = 429; throw e;
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = uid();
  user.code = { h: sha(code + salt), salt, kind, exp: now() + CODE_TTL, tries: 0, sent: now() };
  saveDB();
  try { await sendCodeMail(user, code, kind); }
  catch (err) {
    console.error('Échec de l\'envoi de l\'e-mail :', err.message);
    user.code.sent = 0; saveDB();
    const e = new Error('Impossible d\'envoyer l\'e-mail pour le moment. Réessaie dans quelques minutes.'); e.status = 502; throw e;
  }
}
function checkCode(user, kind, code) {
  const c = user.code;
  if (!c || c.kind !== kind) return 'Aucun code en attente. Demande un nouveau code.';
  if (now() > c.exp) return 'Ce code a expiré. Demande un nouveau code.';
  if (c.tries >= CODE_MAX_TRIES) return 'Trop d\'essais. Demande un nouveau code.';
  c.tries++; saveDB();
  const ok = crypto.timingSafeEqual(Buffer.from(sha(String(code).trim() + c.salt)), Buffer.from(c.h));
  if (!ok) return `Code incorrect. ${CODE_MAX_TRIES - c.tries} essai(s) restant(s).`;
  user.code = null; saveDB();
  return null;
}

/* ---------- Sessions ---------- */
function createSession(res, req, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  DB.sessions[sha(token)] = { uid: user.id, exp: now() + SESSION_TTL };
  saveDB();
  const secure = ENV.COOKIE_SECURE === 'true' || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `sd_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`);
}
function sessionUser(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sd_session=([^;]+)/);
  if (!m) return null;
  const s = DB.sessions[sha(m[1])];
  if (!s || s.exp < now()) return null;
  const u = DB.users.find(x => x.id === s.uid);
  if (u?.builtin && !ENV.ADMIN_PASSWORD) return null;
  return u && u.verified && !u.banned ? u : null;
}
function dropSessions(userId) { for (const k in DB.sessions) if (DB.sessions[k].uid === userId) delete DB.sessions[k]; saveDB(); }

/* ---------- Modèle ---------- */
const mem = id => S().members.find(m => m.id === id);
const role = id => S().roles.find(r => r.id === id);
const chan = id => S().channels.find(c => c.id === id);
const can = (m, p) => !!m && m.roles.some(id => { const r = role(id); return r && (r.perms.admin || r.perms[p]); });
const isFounder = m => !!m && m.roles.includes('r_fond');
function audit(t) { const a = S().audit; a.unshift({ t, ts: now() }); a.length = Math.min(a.length, 300); }
function post(ch, msg) { const M = S().messages; (M[ch] ||= []).push({ id: uid(), ts: now(), ...msg }); if (M[ch].length > 300) M[ch].splice(0, M[ch].length - 300); return M[ch][M[ch].length - 1]; }
function fill(t, ctx) {
  return String(t || '').replace(/\{random:(\d+)-(\d+)\}/g, (_, a, b) => +a + Math.floor(Math.random() * (b - a + 1))).replace(/\{(\w+)\}/g, (m, k) => ({ user: '@' + (ctx.user?.name || ''), username: ctx.user?.name || '', channel: '#' + (chan(ctx.ch)?.name || ''), server: S().settings.serverName, members: S().members.length, args: ctx.args || '', date: new Date().toLocaleDateString('fr-FR'), time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: ENV.TZ || 'Europe/Paris' }), level: ctx.level ?? '', result: ctx.result ?? '', random: 1 + Math.floor(Math.random() * 100) }[k] ?? m));
}
function ensureMember(user) {
  let m = mem(user.id);
  if (m) { if (m.name !== user.username) m.name = user.username; return m; }
  const st = S();
  const hasFounder = st.members.some(x => x.roles.includes('r_fond'));
  m = { id: user.id, name: user.username, roles: [], xp: 0, level: 0 };
  if (user.tiktok) m.tiktok = publicTikTok(user.tiktok);
  if (!hasFounder || (ADMIN_EMAIL && user.email === ADMIN_EMAIL)) m.roles.push('r_fond');
  st.members.push(m);
  audit(`${m.name} a rejoint le serveur`);
  for (const b of st.bots) {
    if (!b.enabled || !b.welcome?.on) continue;
    if (b.welcome.role && role(b.welcome.role) && b.welcome.role !== 'r_fond' && !m.roles.includes(b.welcome.role)) m.roles.push(b.welcome.role);
    if (chan(b.welcome.channel)) post(b.welcome.channel, { bot: b.id, text: fill(b.welcome.text, { user: m, ch: b.welcome.channel }) });
  }
  if (!m.roles.length) m.roles.push(role('r_membre') ? 'r_membre' : st.roles[st.roles.length - 1].id);
  saveDB();
  return m;
}
function removeMember(t, reason, ban) {
  const st = S();
  st.members = st.members.filter(x => x.id !== t.id);
  for (const k in st.voice) st.voice[k] = st.voice[k].filter(x => x !== t.id);
  if (ban) {
    st.banned.push({ id: t.id, name: t.name, reason: reason || '', ts: now() });
    const u = DB.users.find(x => x.id === t.id); if (u) { u.banned = true; dropSessions(u.id); }
  }
  closeStreams(t.id, ban ? 'banned' : 'kicked');
  audit(`${t.name} ${ban ? 'banni' : 'expulsé'}${reason ? ' (' + reason + ')' : ''}`);
}

/* ---------- Moteur des bots (exécuté côté serveur) ---------- */
const say = (b, ch, content) => post(ch, { bot: b.id, ...content });
function findTarget(args) { const mm = String(args || '').match(/@([\p{L}\p{N}_.\-]+)/u); return mm ? S().members.find(x => x.name.toLowerCase() === mm[1].toLowerCase()) : null; }
function matchCmd(b, c, t) {
  const low = t.toLowerCase(), tr = String(c.trigger || '').toLowerCase().trim(); if (!tr) return null;
  if (c.type === 'prefix') { const first = low.split(/\s+/)[0]; return first === (b.prefix + tr).toLowerCase() ? { args: t.slice(first.length).trim() } : null; }
  if (c.type === 'exact') return low.trim() === tr ? { args: '' } : null;
  return low.includes(tr) ? { args: t } : null;
}
function execActions(b, c, ch, author, args, msg) {
  const ctx = { user: author, ch, args }; const st = S();
  for (const a of c.actions || []) {
    switch (a.kind) {
      case 'reply': say(b, ch, { text: fill(a.value, ctx) }); break;
      case 'embed': say(b, ch, { embed: { title: fill(a.value, ctx), desc: fill(a.value2, ctx), color: a.color || b.color } }); break;
      case 'random': { const o = String(a.value || '').split('|').map(s => s.trim()).filter(Boolean); const r = o[Math.floor(Math.random() * o.length)] || '…'; say(b, ch, { text: fill(a.value2 || '{result}', { ...ctx, result: r }) }); break; }
      case 'dice': { const n = Math.max(2, +a.value || 6); say(b, ch, { text: `@${author.name} lance un dé à ${n} faces : **${1 + Math.floor(Math.random() * n)}**` }); break; }
      case 'giveRole': case 'removeRole': {
        const t = a.target === 'author' ? author : findTarget(args); const r = role(a.value);
        if (!t || !r) { say(b, ch, { text: t ? 'Rôle introuvable, vérifie la commande.' : 'Mentionne un membre, par exemple @pseudo.' }); break; }
        if (r.id === 'r_fond' || isFounder(t) && a.kind === 'removeRole') { say(b, ch, { text: 'Ce rôle ne peut pas être modifié par un bot.' }); break; }
        if (a.kind === 'giveRole') { if (!t.roles.includes(r.id)) t.roles.push(r.id); say(b, ch, { text: `Rôle **${r.name}** donné à @${t.name}.` }); }
        else { t.roles = t.roles.filter(x => x !== r.id); say(b, ch, { text: `Rôle **${r.name}** retiré à @${t.name}.` }); }
        audit(`${b.name} : rôle ${r.name} ${a.kind === 'giveRole' ? 'ajouté à' : 'retiré de'} ${t.name} (par ${author.name})`); break;
      }
      case 'kick': case 'ban': {
        const t = findTarget(args); const perm = a.kind;
        if (!can(author, perm)) { say(b, ch, { text: `@${author.name}, tu n'as pas la permission de ${perm === 'ban' ? 'bannir' : 'expulser'}.` }); break; }
        if (!t || t.id === author.id || isFounder(t)) { say(b, ch, { text: 'Mentionne le membre visé (le fondateur ne peut pas être visé).' }); break; }
        removeMember(t, fill(a.value, ctx), a.kind === 'ban');
        say(b, ch, { text: `@${t.name} a été ${a.kind === 'ban' ? 'banni' : 'expulsé'}.${a.value ? ' Raison : ' + fill(a.value, ctx) : ''}` }); break;
      }
      case 'clear': { const arr = st.messages[ch] || []; const nArg = parseInt(args); const k = Math.min(100, isNaN(nArg) ? Math.max(1, +a.value || 5) : Math.max(1, nArg)); arr.splice(Math.max(0, arr.length - (k + 1))); say(b, ch, { text: `${k} messages supprimés par @${author.name}.` }); break; }
      case 'createChannel': { const raw = fill(a.value || args || 'nouveau-salon', ctx); const voice = a.value2 === 'voice'; const nm = voice ? clean(raw, 40) : slug(raw).slice(0, 40); st.channels.push({ id: uid(), name: nm, type: voice ? 'voice' : 'text', cat: a.cat || st.cats[st.cats.length - 1]?.id, topic: '' }); say(b, ch, { text: `Salon **${nm}** créé.` }); audit(`${b.name} a créé le salon ${nm}`); break; }
      case 'poll': { const parts = (args || fill(a.value, ctx)).split('|').map(s => s.trim()).filter(Boolean); let o = parts.slice(1, 11); if (o.length < 2) o = ['Oui', 'Non']; say(b, ch, { poll: { q: parts[0] || 'Sondage', opts: o.map(l => ({ l, v: [] })) } }); break; }
      case 'sendTo': if (chan(a.channel)?.type === 'text') say(b, a.channel, { text: fill(a.value, ctx) }); break;
      case 'deleteTrigger': if (msg) st.messages[ch] = (st.messages[ch] || []).filter(x => x.id !== msg.id); break;
    }
  }
}
function runBots(ch, msg, author) {
  const t = msg.text.trim(); const st = S();
  for (const b of st.bots) {
    if (!b.enabled) continue;
    if (b.automod?.on && !can(author, 'admin')) {
      const ws = String(b.automod.words || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
      if (ws.some(w => t.toLowerCase().includes(w))) {
        st.messages[ch] = st.messages[ch].filter(x => x.id !== msg.id);
        say(b, ch, { text: fill(b.automod.warn, { user: author, ch }) });
        audit(`${b.name} a supprimé un message de ${author.name} (auto-modération)`);
        if (b.automod.action === 'kick' && !isFounder(author)) removeMember(author, 'auto-modération', false);
        return;
      }
    }
    if (b.levels?.on) {
      author.xp = (author.xp || 0) + 10 + Math.floor(Math.random() * 6);
      const lv = Math.floor(Math.sqrt(author.xp / 50));
      if (lv > (author.level || 0)) { author.level = lv; say(b, chan(b.levels.channel) ? b.levels.channel : ch, { text: fill(b.levels.text, { user: author, ch, level: lv }) }); }
    }
    if (t.toLowerCase() === b.prefix + 'help') {
      say(b, ch, { embed: { title: `Commandes de ${b.name}`, desc: b.commands.filter(c => c.on).map(c => `**${c.type === 'prefix' ? b.prefix + c.trigger : '« ' + c.trigger + ' »'}** : ${c.desc || '—'}${c.role ? ' (' + (role(c.role)?.name || '') + ')' : ''}`).join('\n') || 'Aucune commande.', color: b.color } });
      continue;
    }
    for (const c of b.commands || []) {
      if (!c.on) continue; const m = matchCmd(b, c, t); if (!m) continue;
      if (c.role && !author.roles.includes(c.role) && !can(author, 'admin')) { say(b, ch, { text: `@${author.name}, il faut le rôle **${role(c.role)?.name}** pour utiliser cette commande.` }); break; }
      execActions(b, c, ch, author, m.args, msg);
      if (c.type !== 'contains') break;
    }
  }
}
setInterval(() => {
  let changed = false; const n = now();
  for (const b of S().bots) {
    if (!b.enabled) continue;
    for (const s of b.schedules || []) {
      if (s.on && chan(s.channel) && n - (s.last || 0) >= Math.max(1, +s.every || 60) * 60000) { say(b, s.channel, { text: fill(s.text, { user: { name: b.name }, ch: s.channel }) }); s.last = n; changed = true; }
    }
  }
  if (changed) { saveDB(); broadcast(); }
}, 15000);

/* ---------- Temps réel (Server-Sent Events) ---------- */
const streams = new Set(); // {res, uid}
function publicState() {
  const st = S(); const online = new Set([...streams].map(s => s.uid));
  return { ...st, members: st.members.map(m => ({ ...m, status: online.has(m.id) ? 'online' : 'offline' })) };
}
let bTimer = null;
function broadcast() {
  clearTimeout(bTimer);
  bTimer = setTimeout(() => {
    const data = `event: sync\ndata: ${JSON.stringify(publicState())}\n\n`;
    for (const s of streams) s.res.write(data);
  }, 40);
}
function closeStreams(userId, reason) {
  for (const s of [...streams]) if (s.uid === userId) { s.res.write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`); s.res.end(); streams.delete(s); }
}
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 25000);

/* ---------- Actions des membres ---------- */
const KEYPERM = { roles: 'roles', cats: 'channels', channels: 'channels', bots: 'bots', creators: 'creators', settings: 'admin', redm: 'redm', fivem: 'fivem' };
function applyPatch(m, patch) {
  const st = S();
  for (const [k, v] of Object.entries(patch || {})) {
    const perm = KEYPERM[k];
    if (!perm) throw new Error('Modification inconnue.');
    if (!can(m, perm)) throw new Error('Tu n\'as pas la permission pour cette modification.');
    if (['roles', 'cats', 'channels', 'bots', 'creators'].includes(k) && !Array.isArray(v)) throw new Error('Données invalides.');
    if (['settings', 'redm', 'fivem'].includes(k) && (typeof v !== 'object' || !v || Array.isArray(v))) throw new Error('Données invalides.');
    if (k === 'roles') {
      const before = JSON.stringify(st.roles.find(r => r.id === 'r_fond'));
      const fond = v.find(r => r && r.id === 'r_fond');
      if (!fond) throw new Error('Le rôle Fondateur ne peut pas être supprimé.');
      if (JSON.stringify(fond) !== before && !isFounder(m)) throw new Error('Seul le fondateur peut modifier le rôle Fondateur.');
      for (const p of PERMS) fond.perms[p] = true;
      const ids = new Set(v.map(r => r.id));
      for (const x of st.members) x.roles = x.roles.filter(r => ids.has(r));
      st.roles = v.map(r => ({ id: clean(r.id, 20), name: clean(r.name, 32) || 'Rôle', color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#9499C6', perms: Object.fromEntries(PERMS.map(p => [p, !!r.perms?.[p]])) }));
      audit(`${m.name} a modifié les rôles`);
    } else if (k === 'channels') {
      if (!v.some(c => c.type === 'text')) throw new Error('Il faut garder au moins un salon textuel.');
      const ids = new Set(v.map(c => c.id));
      for (const id of Object.keys(st.messages)) if (!ids.has(id)) delete st.messages[id];
      for (const id of Object.keys(st.voice)) if (!ids.has(id)) delete st.voice[id];
      st.channels = v.map(c => ({ id: clean(c.id, 20), name: clean(c.name, 40) || 'salon', type: c.type === 'voice' ? 'voice' : 'text', cat: clean(c.cat, 20), topic: clean(c.topic, 200) }));
    } else if (k === 'cats') {
      if (!v.length) throw new Error('Il faut au moins une catégorie.');
      st.cats = v.map(c => ({ id: clean(c.id, 20), name: clean(c.name, 40) || 'Catégorie' }));
    } else if (k === 'settings') {
      st.settings = { serverName: clean(v.serverName, 40) || APP_NAME, validHours: Math.max(0, +v.validHours || 0), rate: Math.max(0, +v.rate || 0), backstageUrl: clean(v.backstageUrl, 500) };
    } else if (k === 'redm' || k === 'fivem') {
      const d = { name: 'Serveur', ip: '', status: 'online', whitelist: true, crisis: false, maintMsg: '', slots: 64, online: 0 };
      st.servers[k] = { ...d, ...v, status: ['online', 'maintenance', 'closed'].includes(v.status) ? v.status : 'online', players: Array.isArray(v.players) ? v.players : [], incidents: Array.isArray(v.incidents) ? v.incidents : [], log: Array.isArray(v.log) ? v.log.slice(0, 150) : [] };
    } else {
      st[k] = v;
    }
  }
  if (JSON.stringify(patch).length > 900000) throw new Error('Données trop volumineuses.');
}
function action(user, a) {
  const st = S(); const m = mem(user.id);
  if (!m) throw new Error('Tu ne fais plus partie du serveur. Recharge la page pour revenir.');
  switch (a.type) {
    case 'send': {
      const c = chan(a.ch); const text = clean(a.text, 2000).trim();
      if (!c || c.type !== 'text') throw new Error('Salon introuvable.');
      if (!text) return;
      if (!can(m, 'send')) throw new Error('Ton rôle ne permet pas d\'écrire.');
      if (/@everyone/.test(text) && !can(m, 'everyone')) throw new Error('Il faut la permission @everyone.');
      const msg = post(c.id, { author: m.id, text });
      runBots(c.id, msg, m); break;
    }
    case 'vote': {
      const msg = (st.messages[a.ch] || []).find(x => x.id === a.m); if (!msg?.poll) return;
      const i = +a.i; if (!msg.poll.opts[i]) return;
      const had = msg.poll.opts[i].v.includes(m.id); msg.poll.opts.forEach(o => o.v = o.v.filter(x => x !== m.id)); if (!had) msg.poll.opts[i].v.push(m.id); break;
    }
    case 'delMsg': {
      const msg = (st.messages[a.ch] || []).find(x => x.id === a.m); if (!msg) return;
      if (msg.author !== m.id && !can(m, 'admin')) throw new Error('Tu ne peux supprimer que tes messages.');
      st.messages[a.ch] = st.messages[a.ch].filter(x => x.id !== a.m); break;
    }
    case 'voice': {
      for (const k in st.voice) st.voice[k] = st.voice[k].filter(x => x !== m.id);
      if (a.ch) { if (chan(a.ch)?.type !== 'voice') throw new Error('Salon vocal introuvable.'); if (!can(m, 'voice')) throw new Error('Ton rôle ne permet pas le vocal.'); (st.voice[a.ch] ||= []).push(m.id); }
      break;
    }
    case 'memberRoles': {
      if (!can(m, 'roles')) throw new Error('Il faut la permission « Gérer les rôles ».');
      const t = mem(a.id); if (!t) throw new Error('Membre introuvable.');
      const roles = (a.roles || []).filter(r => role(r));
      if ((roles.includes('r_fond') !== isFounder(t)) && !isFounder(m)) throw new Error('Seul le fondateur peut donner ou retirer le rôle Fondateur.');
      if (isFounder(t) && !roles.includes('r_fond') && st.members.filter(isFounder).length < 2) throw new Error('Le serveur doit garder au moins un fondateur.');
      t.roles = [...new Set(roles)]; audit(`${m.name} a modifié les rôles de ${t.name}`); break;
    }
    case 'kick': case 'ban': {
      if (!can(m, a.type)) throw new Error('Tu n\'as pas cette permission.');
      const t = mem(a.id); if (!t || t.id === m.id) throw new Error('Membre introuvable.');
      if (isFounder(t)) throw new Error('Le fondateur ne peut pas être expulsé ni banni.');
      removeMember(t, clean(a.reason, 200) || (a.type === 'ban' ? `par ${m.name}` : ''), a.type === 'ban'); break;
    }
    case 'unban': {
      if (!can(m, 'ban')) throw new Error('Tu n\'as pas cette permission.');
      const x = st.banned.find(b => b.id === a.id); if (!x) return;
      st.banned = st.banned.filter(b => b !== x); const u = DB.users.find(y => y.id === x.id); if (u) u.banned = false;
      audit(`${x.name} débanni par ${m.name}`); break;
    }
    case 'state': applyPatch(m, a.patch); break;
    case 'myLive': case 'delMyLive': {
      const u = DB.users.find(x => x.id === user.id);
      if (!u?.tiktok?.handle) throw new Error('Connecte d\'abord ton TikTok dans l\'onglet Connexions.');
      const d = String(a.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) throw new Error('Date invalide.');
      if (Date.parse(d) > now() + 36 * 3600 * 1000) throw new Error('Tu ne peux pas saisir un live dans le futur.');
      let c = st.creators.find(x => String(x.handle).toLowerCase() === u.tiktok.handle.toLowerCase());
      if (!c) {
        c = { id: uid(), name: u.tiktok.name || u.username, handle: u.tiktok.handle, agent: '', followers: u.tiktok.followers || 0, since: new Date().toISOString().slice(0, 10), notes: '', logs: {}, goals: { days: 20, hours: 40, diamonds: 150000 }, member: u.id };
        st.creators.push(c); audit(`${m.name} a été ajouté aux créateurs (@${c.handle})`);
      }
      c.member = u.id; c.logs ||= {};
      if (a.type === 'delMyLive') { delete c.logs[d]; break; }
      const hours = Math.round(Math.min(24, Math.max(0, +a.hours || 0)) * 100) / 100;
      const prev = c.logs[d] || {};
      c.logs[d] = { hours, diamonds: Math.max(0, Math.round(+a.diamonds || 0)), matches: Math.max(0, Math.round(+a.matches || 0)), followers: Math.max(0, Math.round(+a.followers || 0)), viewers: prev.viewers || 0, by: m.id };
      break;
    }
    default: throw new Error('Action inconnue.');
  }
  saveDB(); broadcast();
}

/* ---------- HTTP ---------- */
const hits = new Map();
function limited(req, key, max = 30, win = 10 * 60 * 1000) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = key + '|' + ip; const arr = (hits.get(k) || []).filter(t => now() - t < win); arr.push(now()); hits.set(k, arr);
  return arr.length > max;
}
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 1_000_000) { reject(Object.assign(new Error('Requête trop volumineuse.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (_) { reject(Object.assign(new Error('JSON invalide.'), { status: 400 })); } });
  req.on('error', reject);
});
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const findUser = email => DB.users.find(u => !u.builtin && u.email === String(email || '').trim().toLowerCase());
const publicUser = u => ({ id: u.id, email: u.email, username: u.username });

const routes = {
  'POST /api/signup': async (req, res, b) => {
    if (limited(req, 'signup', 10)) throw err('Trop de tentatives, réessaie plus tard.', 429);
    const email = String(b.email || '').trim().toLowerCase(); const username = String(b.username || '').trim(); const pw = String(b.password || '');
    if (!EMAIL_RE.test(email)) throw err('Adresse e-mail invalide.');
    if (!USER_RE.test(username)) throw err('Le pseudo doit faire 2 à 24 caractères (lettres, chiffres, espace, . _ -).');
    if (pw.length < 8 || pw.length > 200) throw err('Le mot de passe doit faire au moins 8 caractères.');
    let u = findUser(email);
    if (u && u.verified) throw err('Un compte existe déjà avec cet e-mail. Connecte-toi.', 409);
    if (u?.banned) throw err('Ce compte est banni.', 403);
    if (DB.users.some(x => x !== u && x.username.toLowerCase() === username.toLowerCase())) throw err('Ce pseudo est déjà pris.', 409);
    if (!u) { u = { id: uid(), email, username, hash: '', verified: false, banned: false, createdAt: now(), code: null }; DB.users.push(u); }
    u.username = username; u.hash = hashPassword(pw); saveDB();
    await issueCode(u, 'verify');
    send(res, 200, { ok: true, email, devMode: !mailConfigured() });
  },
  'POST /api/verify': async (req, res, b) => {
    if (limited(req, 'verify', 40)) throw err('Trop de tentatives, réessaie plus tard.', 429);
    const u = findUser(b.email); if (!u) throw err('Compte introuvable.', 404);
    if (u.banned) throw err('Ce compte est banni.', 403);
    if (u.verified) throw err('Cet e-mail est déjà vérifié. Connecte-toi.', 409);
    const e = checkCode(u, 'verify', b.code); if (e) throw err(e);
    u.verified = true; saveDB(); ensureMember(u); createSession(res, req, u); broadcast();
    send(res, 200, { ok: true, user: publicUser(u) });
  },
  'POST /api/resend': async (req, res, b) => {
    if (limited(req, 'resend', 10)) throw err('Trop de demandes, réessaie plus tard.', 429);
    const u = findUser(b.email); const kind = b.kind === 'reset' ? 'reset' : 'verify';
    if (u && !u.banned && (kind === 'reset' || !u.verified)) await issueCode(u, kind);
    send(res, 200, { ok: true });
  },
  'POST /api/login': async (req, res, b) => {
    if (limited(req, 'login', 20)) throw err('Trop de tentatives, réessaie dans quelques minutes.', 429);
    const adminLogin = (ENV.ADMIN_LOGIN || 'admin').toLowerCase();
    if (ENV.ADMIN_PASSWORD && String(b.email || '').trim().toLowerCase() === adminLogin) {
      const given = sha(String(b.password || '')), real = sha(ENV.ADMIN_PASSWORD);
      if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(real))) throw err('E-mail ou mot de passe incorrect.', 401);
      let a = DB.users.find(x => x.id === 'admin');
      if (!a) { a = { id: 'admin', email: adminLogin, username: ENV.ADMIN_NAME || 'Admin', hash: '', verified: true, banned: false, createdAt: now(), code: null, builtin: true }; DB.users.push(a); }
      a.verified = true; a.banned = false; a.username = ENV.ADMIN_NAME || a.username;
      const m = ensureMember(a); if (!m.roles.includes('r_fond')) m.roles.unshift('r_fond');
      saveDB(); createSession(res, req, a); broadcast();
      return send(res, 200, { ok: true, user: publicUser(a) });
    }
    const u = findUser(b.email);
    if (!u || !checkPassword(String(b.password || ''), u.hash)) throw err('E-mail ou mot de passe incorrect.', 401);
    if (u.banned) throw err('Ce compte est banni du serveur.', 403);
    if (!u.verified) { try { await issueCode(u, 'verify'); } catch (e) { if (e.status !== 429) throw e; } return send(res, 200, { needVerify: true, email: u.email, devMode: !mailConfigured() }); }
    ensureMember(u); createSession(res, req, u);
    send(res, 200, { ok: true, user: publicUser(u) });
  },
  'POST /api/forgot': async (req, res, b) => {
    if (limited(req, 'forgot', 8)) throw err('Trop de demandes, réessaie plus tard.', 429);
    const u = findUser(b.email);
    if (u && !u.banned) { try { await issueCode(u, 'reset'); } catch (e) { if (e.status === 502) throw e; } }
    send(res, 200, { ok: true, devMode: !mailConfigured() });
  },
  'POST /api/reset': async (req, res, b) => {
    if (limited(req, 'reset', 20)) throw err('Trop de tentatives, réessaie plus tard.', 429);
    const u = findUser(b.email); if (!u || u.banned) throw err('Code incorrect.');
    const pw = String(b.password || ''); if (pw.length < 8 || pw.length > 200) throw err('Le mot de passe doit faire au moins 8 caractères.');
    const e = checkCode(u, 'reset', b.code); if (e) throw err(e);
    u.hash = hashPassword(pw); u.verified = true; dropSessions(u.id); saveDB();
    ensureMember(u); createSession(res, req, u);
    send(res, 200, { ok: true, user: publicUser(u) });
  },
  'POST /api/logout': async (req, res) => {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)sd_session=([^;]+)/); if (m) { delete DB.sessions[sha(m[1])]; saveDB(); }
    res.setHeader('Set-Cookie', 'sd_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'); send(res, 200, { ok: true });
  },
  'GET /api/me': async (req, res) => { const u = sessionUser(req); if (!u) throw err('Non connecté.', 401); send(res, 200, { user: publicUser(u) }); },
  'POST /api/password': async (req, res, b) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    if (!checkPassword(String(b.old || ''), u.hash)) throw err('Mot de passe actuel incorrect.');
    if (String(b.password || '').length < 8) throw err('Le nouveau mot de passe doit faire au moins 8 caractères.');
    u.hash = hashPassword(String(b.password)); dropSessions(u.id); createSession(res, req, u); saveDB();
    send(res, 200, { ok: true });
  },
  'POST /api/rename': async (req, res, b) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    const name = String(b.username || '').trim(); if (!USER_RE.test(name)) throw err('Le pseudo doit faire 2 à 24 caractères.');
    if (DB.users.some(x => x !== u && x.username.toLowerCase() === name.toLowerCase())) throw err('Ce pseudo est déjà pris.', 409);
    u.username = name; const m = mem(u.id); if (m) m.name = name; saveDB(); broadcast(); send(res, 200, { ok: true });
  },
  'POST /api/action': async (req, res, b) => {
    const u = sessionUser(req); if (!u) throw err('Session expirée, reconnecte-toi.', 401);
    if (limited(req, 'action:' + u.id, 240, 60 * 1000)) throw err('Doucement ! Trop d\'actions d\'affilée.', 429);
    try { action(u, b); } catch (e) { e.status = e.status || 400; throw e; }
    send(res, 200, { ok: true });
  },
  'GET /api/stream': async (req, res) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    ensureMember(u);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ me: u.id })}\n\n`);
    const s = { res, uid: u.id }; streams.add(s);
    res.write(`event: sync\ndata: ${JSON.stringify(publicState())}\n\n`);
    broadcast();
    req.on('close', () => {
      streams.delete(s);
      if (![...streams].some(x => x.uid === u.id)) { for (const k in S().voice) S().voice[k] = S().voice[k].filter(x => x !== u.id); }
      broadcast();
    });
  }
};

/* ---------- TikTok : profil public + connexion des comptes ---------- */
const TT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const ttConfigured = () => !!(ENV.TIKTOK_CLIENT_KEY && ENV.TIKTOK_CLIENT_SECRET);
const baseUrl = req => ENV.PUBLIC_URL ? ENV.PUBLIC_URL.replace(/\/$/, '') : `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
async function fetchTikTokProfile(handle) {
  const h = String(handle || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_.]{2,30}$/.test(h)) throw err('Pseudo TikTok invalide.');
  let r;
  try { r = await fetch('https://www.tiktok.com/@' + encodeURIComponent(h) + '?lang=fr', { headers: { 'User-Agent': TT_UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8', Accept: 'text/html' }, signal: AbortSignal.timeout(12000) }); }
  catch (_) { throw err('TikTok ne répond pas, réessaie dans un moment.', 502); }
  if (r.status === 404) throw err(`Le compte @${h} n'existe pas.`, 404);
  if (!r.ok) throw err('TikTok refuse la lecture pour le moment, réessaie plus tard.', 502);
  const html = await r.text();
  let info = null;
  const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) { try { info = JSON.parse(m[1]).__DEFAULT_SCOPE__['webapp.user-detail'].userInfo; } catch (_) { info = null; } }
  if (!info?.user) {
    const m2 = html.match(/<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (m2) { try { const j = JSON.parse(m2[1]); const u = Object.values(j.UserModule?.users || {})[0]; const st = Object.values(j.UserModule?.stats || {})[0]; if (u) info = { user: u, stats: st || {} }; } catch (_) { /* format inconnu */ } }
  }
  if (!info?.user?.uniqueId) throw err(`Profil @${h} introuvable ou illisible pour le moment.`, 404);
  const u = info.user, s = info.stats || info.statsV2 || {};
  return { found: true, handle: u.uniqueId, nickname: u.nickname || u.uniqueId, bio: u.signature || '', verified: !!u.verified, avatar: u.avatarThumb || u.avatarMedium || '', followers: +s.followerCount || 0, following: +s.followingCount || 0, likes: +(s.heartCount ?? s.heart) || 0, videos: +s.videoCount || 0 };
}
function publicTikTok(t) { return t ? { handle: t.handle, name: t.name, avatar: t.avatar, bio: t.bio, verified: t.verified, followers: t.followers, following: t.following, likes: t.likes, videos: t.videos, method: t.method, linkedAt: t.linkedAt, updatedAt: t.updatedAt } : null; }
function linkTikTok(user, p, method, tokens) {
  const other = DB.users.find(x => x !== user && x.tiktok && x.tiktok.handle.toLowerCase() === p.handle.toLowerCase());
  if (other) throw err(`Le compte @${p.handle} est déjà connecté à un autre membre.`, 409);
  user.tiktok = { handle: p.handle, name: p.nickname, avatar: p.avatar, bio: p.bio, verified: p.verified, followers: p.followers, following: p.following, likes: p.likes, videos: p.videos, method, linkedAt: user.tiktok?.linkedAt || now(), updatedAt: now(), tokens: tokens || user.tiktok?.tokens || null };
  user.ttPending = null;
  const m = mem(user.id); if (m) m.tiktok = publicTikTok(user.tiktok);
  const c = S().creators.find(x => String(x.handle).toLowerCase() === p.handle.toLowerCase());
  if (c) { c.followers = p.followers; c.tt = { nickname: p.nickname, following: p.following, likes: p.likes, videos: p.videos, bio: p.bio, verified: p.verified, at: now() }; c.member = user.id; }
  saveDB(); broadcast();
}
async function ttToken(params) {
  const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: ENV.TIKTOK_CLIENT_KEY, client_secret: ENV.TIKTOK_CLIENT_SECRET, ...params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw err('TikTok a refusé la connexion : ' + (j.error_description || j.error || r.status), 502);
  return { access: j.access_token, refresh: j.refresh_token, exp: now() + (j.expires_in || 86400) * 1000, refreshExp: now() + (j.refresh_expires_in || 0) * 1000, openId: j.open_id, scope: j.scope };
}
async function ttUserInfo(tok) {
  const fields = 'open_id,avatar_url,display_name,username,bio_description,is_verified,follower_count,following_count,likes_count,video_count';
  const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=' + fields, { headers: { Authorization: 'Bearer ' + tok.access }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  const u = j.data?.user;
  if (!r.ok || !u) throw err('Impossible de lire le profil TikTok : ' + (j.error?.message || r.status), 502);
  return { handle: u.username || u.display_name, nickname: u.display_name || u.username, bio: u.bio_description || '', verified: !!u.is_verified, avatar: u.avatar_url || '', followers: +u.follower_count || 0, following: +u.following_count || 0, likes: +u.likes_count || 0, videos: +u.video_count || 0 };
}
Object.assign(routes, {
  'POST /api/tiktok': async (req, res, b) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    if (limited(req, 'tt:' + u.id, 40)) throw err('Trop de demandes TikTok, réessaie dans quelques minutes.', 429);
    send(res, 200, await fetchTikTokProfile(b.handle));
  },
  'GET /api/connections': async (req, res) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    const p = u.ttPending && u.ttPending.exp > now() ? { handle: u.ttPending.handle, code: u.ttPending.code } : null;
    send(res, 200, { tiktok: publicTikTok(u.tiktok), pending: p, oauth: ttConfigured() });
  },
  'POST /api/tiktok/bio/start': async (req, res, b) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    const h = String(b.handle || '').trim().replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '').replace(/^@/, '').split(/[/?#\s]/)[0];
    if (!/^[A-Za-z0-9_.]{2,30}$/.test(h)) throw err('Pseudo TikTok invalide.');
    if (DB.users.some(x => x !== u && x.tiktok?.handle.toLowerCase() === h.toLowerCase())) throw err(`Le compte @${h} est déjà connecté à un autre membre.`, 409);
    u.ttPending = { handle: h, code: 'STAR-' + crypto.randomBytes(3).toString('hex').toUpperCase(), exp: now() + 30 * 60 * 1000 };
    saveDB(); send(res, 200, { handle: h, code: u.ttPending.code });
  },
  'POST /api/tiktok/bio/check': async (req, res) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    if (limited(req, 'ttcheck:' + u.id, 20)) throw err('Trop de vérifications, attends quelques minutes.', 429);
    const p = u.ttPending; if (!p || p.exp < now()) throw err('Le code a expiré. Recommence la connexion.');
    const prof = await fetchTikTokProfile(p.handle);
    if (!prof.bio.toUpperCase().includes(p.code)) throw err(`Le code ${p.code} n'apparaît pas encore dans la bio de @${prof.handle}. Enregistre ta bio sur TikTok puis réessaie (la mise à jour peut prendre une minute).`);
    linkTikTok(u, prof, 'bio');
    audit(`${u.username} a connecté son TikTok @${prof.handle}`);
    send(res, 200, { tiktok: publicTikTok(u.tiktok) });
  },
  'GET /api/tiktok/oauth/start': async (req, res) => {
    const u = sessionUser(req); if (!u) { res.writeHead(302, { Location: '/' }); return res.end(); }
    if (!ttConfigured()) { res.writeHead(302, { Location: '/?tiktok=error&msg=' + encodeURIComponent('La connexion TikTok officielle n\'est pas configurée sur ce serveur.') }); return res.end(); }
    const state = crypto.randomBytes(16).toString('base64url');
    u.ttState = { v: state, exp: now() + 10 * 60 * 1000 }; saveDB();
    const q = new URLSearchParams({ client_key: ENV.TIKTOK_CLIENT_KEY, scope: 'user.info.basic,user.info.profile,user.info.stats', response_type: 'code', redirect_uri: baseUrl(req) + '/api/tiktok/oauth/callback', state });
    res.writeHead(302, { Location: 'https://www.tiktok.com/v2/auth/authorize/?' + q }); res.end();
  },
  'GET /api/tiktok/oauth/callback': async (req, res) => {
    const back = (ok, msg) => { res.writeHead(302, { Location: `/?tiktok=${ok ? 'ok' : 'error'}${msg ? '&msg=' + encodeURIComponent(msg) : ''}` }); res.end(); };
    const u = sessionUser(req); if (!u) return back(false, 'Session expirée, reconnecte-toi puis recommence.');
    const url = new URL(req.url, 'http://x'); const st = url.searchParams.get('state'); const code = url.searchParams.get('code');
    if (url.searchParams.get('error')) return back(false, 'Connexion TikTok annulée.');
    if (!u.ttState || u.ttState.exp < now() || st !== u.ttState.v || !code) return back(false, 'Lien de connexion invalide ou expiré, recommence.');
    u.ttState = null;
    try {
      const tok = await ttToken({ code, grant_type: 'authorization_code', redirect_uri: baseUrl(req) + '/api/tiktok/oauth/callback' });
      const prof = await ttUserInfo(tok);
      linkTikTok(u, prof, 'oauth', tok); audit(`${u.username} a connecté son TikTok @${prof.handle}`);
      back(true);
    } catch (e) { back(false, e.message); }
  },
  'POST /api/tiktok/refresh': async (req, res) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    if (!u.tiktok) throw err('Aucun compte TikTok connecté.');
    if (limited(req, 'ttref:' + u.id, 20)) throw err('Trop d\'actualisations, réessaie dans quelques minutes.', 429);
    let prof;
    if (u.tiktok.method === 'oauth' && u.tiktok.tokens && ttConfigured()) {
      let tok = u.tiktok.tokens;
      if (tok.exp < now() + 60000) { tok = await ttToken({ grant_type: 'refresh_token', refresh_token: tok.refresh }); }
      prof = await ttUserInfo(tok); linkTikTok(u, prof, 'oauth', tok);
    } else { prof = await fetchTikTokProfile(u.tiktok.handle); linkTikTok(u, prof, u.tiktok.method || 'bio'); }
    send(res, 200, { tiktok: publicTikTok(u.tiktok) });
  },
  'POST /api/tiktok/unlink': async (req, res) => {
    const u = sessionUser(req); if (!u) throw err('Non connecté.', 401);
    if (u.tiktok?.method === 'oauth' && u.tiktok.tokens?.access && ttConfigured()) {
      fetch('https://open.tiktokapis.com/v2/oauth/revoke/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: ENV.TIKTOK_CLIENT_KEY, client_secret: ENV.TIKTOK_CLIENT_SECRET, token: u.tiktok.tokens.access }) }).catch(() => {});
    }
    const h = u.tiktok?.handle; u.tiktok = null; u.ttPending = null; const m = mem(u.id); if (m) delete m.tiktok;
    saveDB(); broadcast(); if (h) audit(`${u.username} a déconnecté son TikTok @${h}`);
    send(res, 200, { ok: true });
  }
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Origine refusée.' });
    }
    try { const body = req.method === 'POST' ? await readBody(req) : {}; await route(req, res, body); }
    catch (e) { if (!res.headersSent) send(res, e.status || 400, { error: e.message || 'Erreur.' }); if (!e.status) console.error(e); }
    return;
  }
  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Introuvable.' });
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
server.listen(PORT, () => {
  console.log(`${APP_NAME} est lancé sur http://localhost:${PORT}`);
  if (!mailConfigured()) console.log('SMTP non configuré : les codes de vérification s\'affichent ici, dans la console (mode test).');
});
process.on('SIGINT', () => { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(DB)); process.exit(0); });
process.on('SIGTERM', () => { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(DB)); process.exit(0); });
