'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// FamilyCare SMTP email support - no external npm dependencies.
const net = require('net');
const tls = require('tls');

function mailEnabled() {
  return String(process.env.MAIL_ENABLED || '').toLowerCase() === 'true';
}
function inferSmtp(email) {
  const address = String(email || '').trim().toLowerCase();
  const domain = (address.split('@')[1] || '').trim();
  if (domain === 'gmail.com' || domain === 'googlemail.com') return { host:'smtp.gmail.com', port:587, secure:false, provider:'Gmail' };
  if (domain === 'yahoo.com' || domain === 'yahoo.ro' || domain === 'ymail.com') return { host:'smtp.mail.yahoo.com', port:587, secure:false, provider:'Yahoo' };
  if (['outlook.com','hotmail.com','live.com','msn.com'].includes(domain)) return { host:'smtp.office365.com', port:587, secure:false, provider:'Outlook' };
  if (domain) return { host:'smtp.' + domain, port:587, secure:false, provider:domain };
  return { host:process.env.SMTP_HOST || '', port:Number(process.env.SMTP_PORT || 587), secure:String(process.env.SMTP_SECURE || '').toLowerCase()==='true', provider:'manual' };
}
function isActiveMailValue(v) {
  const x = String(v ?? '').trim().toLowerCase();
  return !['nu','no','false','0','inactiv','inactive','off'].includes(x);
}
function mailSecretKey() {
  const secret = String(process.env.MAIL_SECRET_KEY || '');
  return secret ? crypto.createHash('sha256').update(secret, 'utf8').digest() : null;
}
function encryptMailSecret(value) {
  const key = mailSecretKey();
  if (!key) throw new Error('MAIL_SECRET_KEY trebuie configurată pentru salvarea securizată a parolei SMTP.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['enc','v1',iv.toString('base64url'),tag.toString('base64url'),encrypted.toString('base64url')].join(':');
}
function decryptMailSecret(value) {
  const raw = String(value || '');
  if (!raw.startsWith('enc:v1:')) return raw;
  const key = mailSecretKey();
  if (!key) throw new Error('MAIL_SECRET_KEY lipsește; parola SMTP salvată nu poate fi decriptată.');
  const parts = raw.split(':');
  if (parts.length !== 5) throw new Error('Secret SMTP invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64url'));
  decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
}
async function mailCfg(headerCode='') {
  let dbCfg = null;
  try {
    const sql = `select coalesce((
      select payload::text
      from ${dqIdent(PGSCHEMA)}.config_record
      where section_key='mail-settings'${headerCode ? ` and payload->>'HeaderCode'=${dollar(headerCode)}` : ''}
      order by id desc
      limit 1
    ), '{}');`;
    dbCfg = JSON.parse(await runPsql(sql) || '{}');
  } catch (_) { dbCfg = null; }

  const uiEmail = dbCfg && (dbCfg.Email || dbCfg['Email expeditor'] || dbCfg.Username || dbCfg.User || dbCfg['Adresă email']);
  const storedSecret = dbCfg && (dbCfg['Secret SMTP'] || dbCfg['Parolă'] || dbCfg.Parola || dbCfg.Password || dbCfg['Parolă aplicație'] || dbCfg['App password']);
  const uiPass = storedSecret ? decryptMailSecret(storedSecret) : '';
  if (uiEmail && uiPass) {
    const inferred = inferSmtp(uiEmail);
    const active = isActiveMailValue(dbCfg.Activ ?? dbCfg.Active ?? 'da');
    return {
      enabled: active,
      host: inferred.host,
      port: inferred.port,
      secure: inferred.secure,
      user: String(uiEmail).trim(),
      pass: String(uiPass).trim(),
      from: 'FamilyCare <' + String(uiEmail).trim() + '>',
      provider: inferred.provider,
      source: 'interfață'
    };
  }

  return {
    enabled: mailEnabled(),
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    provider: 'environment',
    source: 'sistem'
  };
}
function normalizeEmailList(value) {
  return String(value || '').split(/[;,\s]+/).map(x => x.trim()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
}
function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = data => {
      buf += data.toString('utf8');
      const lines = buf.split(/\r?\n/).filter(Boolean);
      if (lines.length && /^\d{3} /.test(lines[lines.length - 1])) cleanup(resolve, buf);
    };
    const onError = err => cleanup(reject, err);
    const cleanup = (fn, val) => { socket.off('data', onData); socket.off('error', onError); fn(val); };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}
async function smtpCmd(socket, cmd, expect) {
  if (cmd) socket.write(cmd + '\r\n');
  const res = await smtpRead(socket);
  const code = Number(String(res).slice(0,3));
  const allowed = Array.isArray(expect) ? expect : [expect];
  if (expect && !allowed.includes(code)) throw new Error('SMTP ' + code + ': ' + String(res).trim());
  return res;
}
function smtpConnect(cfg) {
  return new Promise((resolve, reject) => {
    const opts = { host: cfg.host, port: cfg.port, servername: cfg.host };
    const socket = cfg.secure ? tls.connect(opts, () => resolve(socket)) : net.connect(opts, () => resolve(socket));
    socket.setTimeout(20000, () => { try { socket.destroy(); } catch(_) {} reject(new Error('SMTP timeout')); });
    socket.once('error', reject);
  });
}
function startTls(socket, cfg) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: cfg.host }, () => resolve(secure));
    secure.once('error', reject);
  });
}
function mimeMessage({from,to,subject,text}) {
  const encSubject = '=?UTF-8?B?' + Buffer.from(String(subject || ''), 'utf8').toString('base64') + '?=';
  return [
    'From: ' + from,
    'To: ' + to.join(', '),
    'Subject: ' + encSubject,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(text || '')
  ].join('\r\n').replace(/\r?\n\./g, '\r\n..');
}
async function sendMailSMTP({to, subject, text, headerCode=''}) {
  const cfg = await mailCfg(headerCode);
  const recipients = normalizeEmailList(to);
  if (!cfg.enabled) return { ok:false, skipped:true, reason:'MAIL_ENABLED=false' };
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.from) return { ok:false, skipped:true, reason:'SMTP incomplet' };
  if (!recipients.length) return { ok:false, skipped:true, reason:'Fără destinatari' };
  let socket = await smtpConnect(cfg);
  try {
    await smtpCmd(socket, null, 220);
    await smtpCmd(socket, 'EHLO familycare.local', 250);
    if (!cfg.secure && cfg.port !== 465) {
      await smtpCmd(socket, 'STARTTLS', 220);
      socket = await startTls(socket, cfg);
      await smtpCmd(socket, 'EHLO familycare.local', 250);
    }
    await smtpCmd(socket, 'AUTH LOGIN', 334);
    await smtpCmd(socket, Buffer.from(cfg.user).toString('base64'), 334);
    await smtpCmd(socket, Buffer.from(cfg.pass).toString('base64'), 235);
    const fromEmail = (String(cfg.from).match(/<([^>]+)>/) || [null, cfg.from])[1];
    await smtpCmd(socket, 'MAIL FROM:<' + fromEmail + '>', 250);
    for (const r of recipients) await smtpCmd(socket, 'RCPT TO:<' + r + '>', [250,251]);
    await smtpCmd(socket, 'DATA', 354);
    socket.write(mimeMessage({ from: cfg.from, to: recipients, subject, text }) + '\r\n.\r\n');
    await smtpCmd(socket, null, 250);
    try { await smtpCmd(socket, 'QUIT', 221); } catch(_) {}
    return { ok:true, recipients };
  } finally {
    try { socket.end(); } catch(_) {}
  }
}
async function logEmailStatus(kind, recipients, subject, message, status, detail, headerCode='') {
  try {
    const payload = JSON.stringify({ Tip:kind, Către:recipients, Subiect:subject, Mesaj:message, Status:status, Detalii:detail || '', Data:new Date().toISOString(), ...(headerCode?{HeaderCode:headerCode}:{}) });
    await runPsql(`insert into ${dqIdent(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('email-outbox', ${dollar(payload)}::jsonb, 10);`);
  } catch(_) {}
}
async function sendAndLog(kind, recipients, subject, message, headerCode='') {
  if (!normalizeEmailList(recipients).length) return { ok:false, skipped:true, reason:'Fără destinatari' };
  try {
    const result = await sendMailSMTP({ to:recipients, subject, text:message, headerCode });
    await logEmailStatus(kind, recipients, subject, message, result.ok ? 'trimis' : 'neexpediat', result.reason || '', headerCode);
    return result;
  } catch (e) {
    await logEmailStatus(kind, recipients, subject, message, 'eșuat', e.message || String(e), headerCode);
    return { ok:false, error:e.message || String(e) };
  }
}


const PORT = Number(process.env.PORT || 31000);
const HOST = process.env.HOST || ((process.env.RENDER || process.env.NODE_ENV === 'production') ? '0.0.0.0' : '127.0.0.1');
const ROOT = __dirname;
const PGSCHEMA = process.env.PGSCHEMA || 'familycare';
const PSQL_BIN = process.env.PSQL_BIN || 'psql';
const HTTPS_ENABLED = String(process.env.HTTPS || '').toLowerCase() === 'true';
const TLS_PFX_PATH = process.env.TLS_PFX_PATH || path.join(ROOT, 'certs', 'familycare-local.pfx');
const TLS_PFX_PASSPHRASE = process.env.TLS_PFX_PASSPHRASE || 'familycare-local';
const PROTOCOL = HTTPS_ENABLED ? 'https' : 'http';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const ADMIN_NAME = String(process.env.ADMIN_NAME || 'Administrator FamilyCare');
// V1.0.94: superuser tehnic disponibil indiferent dacă există deja utilizatori în baza de date.
// Datele implicite pot fi suprascrise prin variabilele SUPERUSER_NAME și SUPERUSER_PASSWORD.
const SUPERUSER_NAME = String(process.env.SUPERUSER_NAME || 'camil.superadmin');
const SUPERUSER_PASSWORD = String(process.env.SUPERUSER_PASSWORD || 'FamilyCare#Camil2026!');
const passwordResetRequests = new Map();
// V1.0.94: login Main cu opțiune publică Utilizator nou pentru testare și onboarding.
// Pentru test fără autentificare se poate seta MAIN_AUTH_DISABLED=true, dar implicit login-ul este activ.
const MAIN_AUTH_DISABLED = ['true','1','yes','da'].includes(String(process.env.MAIN_AUTH_DISABLED || process.env.FAMILYCARE_AUTH_DISABLED || '').trim().toLowerCase());
const AUTH_REQUIRED = !MAIN_AUTH_DISABLED;
const ALLOW_PUBLIC_REGISTRATION = !['false','0','no','nu'].includes(String(process.env.ALLOW_PUBLIC_REGISTRATION || '').trim().toLowerCase());
const SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.SESSION_TTL_MINUTES || 480) * 60 * 1000);
const adminSessions = new Map();
const loginAttempts = new Map();
setInterval(()=>{const now=Date.now();for(const [token,state] of adminSessions){const expires=state&&typeof state==='object'?state.expires:state;if(!expires||expires<now)adminSessions.delete(token);}for(const [key,state] of loginAttempts){if((state.until&&state.until<now)||(!state.until&&state.first&&now-state.first>15*60*1000))loginAttempts.delete(key);}for(const [key,state] of passwordResetRequests){if(!state||state.expires<now)passwordResetRequests.delete(key);}},15*60*1000).unref();


function sameSecret(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requestIsSecure(req) {
  return HTTPS_ENABLED || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}
function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((out, part) => {
    const index = part.indexOf('=');
    if (index > 0) { const key=part.slice(0,index).trim(); const raw=part.slice(index + 1).trim(); try{out[key]=decodeURIComponent(raw);}catch(_){out[key]=raw;} }
    return out;
  }, {});
}
function sessionCookie(token, req, maxAgeSeconds) {
  const secure = requestIsSecure(req) ? '; Secure' : '';
  return `fc_main_session=${encodeURIComponent(token || '')}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${Math.max(0, maxAgeSeconds || 0)}`;
}
function getMainSessionState(req) {
  if (!AUTH_REQUIRED) return { authenticated:true, userName:ADMIN_NAME, headerCode:'', headerName:'', orgType:'' };
  const token = parseCookies(req).fc_main_session || '';
  const state = adminSessions.get(token);
  const expires = state && typeof state === 'object' ? state.expires : state;
  if (!expires || expires < Date.now()) {
    if (token) adminSessions.delete(token);
    return null;
  }
  const nextState = state && typeof state === 'object' ? { ...state, expires: Date.now() + SESSION_TTL_MS } : { expires: Date.now() + SESSION_TTL_MS, userName: ADMIN_NAME, headerCode:'', headerName:'', orgType:'' };
  adminSessions.set(token, nextState);
  return { authenticated:true, userName:nextState.userName || ADMIN_NAME, headerCode:nextState.headerCode || '', headerName:nextState.headerName || '', orgType:nextState.orgType || '', role:nextState.role || 'apartinator', branchCode:nextState.branchCode || '' };
}
function getMainScope(req) {
  const session = getMainSessionState(req) || {};
  return { session, headerCode:String(session.headerCode || '').trim(), branchCode:String(session.branchCode || '').trim() };
}
function authorizedMain(req) {
  return !!getMainSessionState(req);
}
function loginKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
function loginBlocked(req) {
  const key = loginKey(req);
  const state = loginAttempts.get(key);
  if (!state) return false;
  if (state.until && state.until > Date.now()) return true;
  if (state.until) loginAttempts.delete(key);
  return false;
}
function registerLoginFailure(req) {
  const key = loginKey(req);
  const state = loginAttempts.get(key) || { count:0, first:Date.now(), until:0 };
  if (Date.now() - state.first > 15 * 60 * 1000) { state.count = 0; state.first = Date.now(); }
  state.count += 1;
  if (state.count >= 5) state.until = Date.now() + 15 * 60 * 1000;
  loginAttempts.set(key, state);
}

function normalizePhone(value) {
  return String(value || '').replace(/[^0-9+]/g, '').trim();
}
function passwordHash(password, salt, iterations = 180000) {
  return crypto.pbkdf2Sync(String(password || ''), String(salt || ''), iterations, 32, 'sha256').toString('hex');
}
async function mainLoginUserCount() {
  try {
    const out = await runPsql(`select count(*) from ${dqIdent(PGSCHEMA)}.config_record where section_key='main-login-user';`);
    return Number(String(out || '0').trim() || 0);
  } catch (_) { return 0; }
}
async function findMainLoginUser(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return null;
  const normalized = normalizePhone(raw);
  // V1.0.94: un e-mail sau un nume de utilizator nu trebuie comparat cu un telefon gol.
  // Comparația cu Telefon se activează numai pentru valori care arată efectiv ca un număr de telefon.
  const isPhoneIdentifier = /^[+\d\s().-]+$/.test(raw) && normalized.replace(/\D/g, '').length >= 6;
  const phoneCondition = isPhoneIdentifier
    ? `or coalesce(payload->>'Telefon','')=${dollar(normalized)}`
    : '';
  try {
    const out = await runPsql(`select coalesce((select json_build_object('id',id,'payload',payload)::text
      from ${dqIdent(PGSCHEMA)}.config_record
      where section_key='main-login-user'
        and coalesce((payload->>'Activ')::boolean,true)=true
        and (
          lower(coalesce(payload->>'Nume',''))=lower(${dollar(raw)})
          or lower(coalesce(payload->>'Utilizator',''))=lower(${dollar(raw)})
          or lower(coalesce(payload->>'Email',''))=lower(${dollar(raw)})
          ${phoneCondition}
        )
      order by
        case when lower(coalesce(payload->>'Rol','')) in ('apartinator','admin','administrator','furnizor','family_member') or coalesce(payload->>'EntityCode',payload->>'Cod beneficiar','')='' then 0 else 1 end,
        id desc limit 1),'{}');`);
    const parsed = JSON.parse(out || '{}');
    return parsed && parsed.id ? parsed : null;
  } catch (_) { return null; }
}

async function restoreApartinatorPayloadIfNeeded(found, identifier) {
  if (!found || !found.payload) return found && found.payload || null;
  const payload = found.payload;
  const role = String(payload.Rol || '').trim().toLowerCase();
  const hasEntity = !!String(payload.EntityCode || payload['Cod beneficiar'] || '').trim();
  if (!hasEntity && role !== 'beneficiar' && role !== 'senior') return payload;
  const user = String(payload.Utilizator || payload.Nume || identifier || '').trim();
  const headerCode = String(payload.HeaderCode || payload['ID organizație'] || '').trim();
  if (!user || !headerCode || !found.id) return payload;
  try {
    const out = await runPsql(`with h as (
        select header_code, name, context_type
        from ${dqIdent(PGSCHEMA)}.care_header
        where coalesce(active,true)=true
          and header_code=${dollar(headerCode)}
          and lower(coalesce(coordinator_name,''))=lower(${dollar(user)})
        order by id desc
        limit 1
      ), upd as (
        update ${dqIdent(PGSCHEMA)}.config_record c
        set payload = (c.payload - 'EntityCode' - 'Cod beneficiar' - 'Beneficiar') || jsonb_build_object(
          'Rol','apartinator',
          'HeaderCode',(select header_code from h),
          'ID organizație',(select header_code from h),
          'Organizație / cont',(select name from h),
          'Organizatie',(select name from h),
          'Tip organizație',(select context_type from h),
          'CorectatApartinatorLa',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS')
        )
        where c.id=${Number(found.id)} and exists(select 1 from h)
        returning payload
      ) select coalesce((select payload::text from upd),'{}');`);
    const parsed = JSON.parse(String(out || '{}').split('\n').pop() || '{}');
    if (parsed && Object.keys(parsed).length) return parsed;
  } catch (_) {}
  return payload;
}

async function createMainLoginUser(body) {
  const name = String(body.name || body.Nume || body.user || body.Utilizator || '').trim();
  const phone = normalizePhone(body.phone || body.Telefon || '');
  const email = String(body.email || body.Email || '').trim().toLowerCase();
  const password = String(body.password || body.Parola || body['Parolă'] || '');
  const orgType = String(body.orgType || body['Tip organizație'] || 'familie_proprie').trim() || 'familie_proprie';
  if (!name) throw new Error('Completează utilizatorul.');
  if (!phone) throw new Error('Completează telefonul.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Completează o adresă de e-mail validă.');
  if (password.length < 6) throw new Error('Parola trebuie să aibă minimum 6 caractere pentru testare.');
  const existingByUser = await findMainLoginUser(name);
  if (existingByUser) throw new Error('Utilizatorul introdus există deja. Alege un alt nume de utilizator.');
  const existingByPhone = await findMainLoginUser(phone);
  if (existingByPhone) throw new Error('Numărul de telefon introdus este deja asociat unui cont.');
  const existingByEmail = await findMainLoginUser(email);
  if (existingByEmail) throw new Error('Adresa de e-mail introdusă este deja asociată unui cont. Folosește altă adresă sau opțiunea „Ai uitat parola?”.');

  // V1.0.94: fiecare utilizator/aparținător primește propria organizație și grup implicit.
  // Senior folosește aceste coduri ca să afișeze doar beneficiarii aparținătorului autentificat.
  const headerCode = makeCode('CH');
  const branchCode = makeCode('CB');
  const orgName = orgType === 'retea' ? ('Rețeaua ' + name) : (orgType === 'camin' ? ('Cămin ' + name) : ('Familia ' + name));
  const branchName = orgType === 'retea' || orgType === 'camin' ? 'Grup principal' : 'Familia mea';
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 180000;
  const payload = JSON.stringify({
    Nume:name,
    Utilizator:name,
    Telefon:phone,
    Email:email,
    'Tip organizație':orgType,
    HeaderCode:headerCode,
    'ID organizație':headerCode,
    Organizatie:orgName,
    'Organizație / cont':orgName,
    BranchCode:branchCode,
    'Grup / locație':branchName,
    Rol:'apartinator',
    Salt:salt,
    Iterations:iterations,
    Hash:passwordHash(password, salt, iterations),
    Activ:true,
    CreatLa:new Date().toISOString()
  });
  const sql = `with h_ins as (
      insert into ${dqIdent(PGSCHEMA)}.care_header(header_code,name,context_type,coordinator_name,description,active)
      values (${dollar(headerCode)}, ${dollar(orgName)}, ${dollar(orgType)}, ${dollar(name)}, 'Creat din login FamilyCare Main; folosit pentru legătura aparținător-beneficiari.', true)
      returning id, header_code, name
    ), b_ins as (
      insert into ${dqIdent(PGSCHEMA)}.care_branch(care_header_id,branch_code,name,branch_type,coordinator_name,city,description,sort_order,active)
      select id, ${dollar(branchCode)}, ${dollar(branchName)}, 'familie', ${dollar(name)}, '', 'Grup implicit creat la înregistrare.', 10, true from h_ins
      returning id, branch_code, name
    ), ins_user as (
      insert into ${dqIdent(PGSCHEMA)}.config_record(section_key,payload,sort_order)
      values ('main-login-user', ${dollar(payload)}::jsonb, 10)
      returning id
    )
    select json_build_object('ok',true,'id',(select id from ins_user),'headerCode',(select header_code from h_ins),'headerName',(select name from h_ins),'branchCode',(select branch_code from b_ins),'branchName',(select name from b_ins))::text;`;
  const out = await runPsql(sql);
  return JSON.parse(String(out || '{}').split('\n').pop() || '{}');
}

function openSessionFor(res, req, name, payload = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  adminSessions.set(token, {
    expires: Date.now() + SESSION_TTL_MS,
    userName: String(name || payload.Nume || payload.Utilizator || ADMIN_NAME),
    headerCode: String(payload.HeaderCode || payload['ID organizație'] || ''),
    headerName: String(payload['Organizație / cont'] || payload.Organizatie || payload['Organizatie'] || ''),
    orgType: String(payload['Tip organizație'] || ''),
    role: String(payload.Rol || 'apartinator'),
    branchCode: String(payload.BranchCode || '')
  });
  res.setHeader('Set-Cookie', sessionCookie(token, req, Math.floor(SESSION_TTL_MS / 1000)));
  return token;
}

async function enrichMainSessionFromDb(st) {
  if (!st || !st.authenticated || !AUTH_REQUIRED) return st;
  const userName = String(st.userName || '').trim();
  const headerCode = String(st.headerCode || '').trim();
  try {
    const out = await runPsql(`with login_payload as (
        select payload
        from ${dqIdent(PGSCHEMA)}.config_record
        where section_key='main-login-user'
          and coalesce((payload->>'Activ')::boolean,true)=true
          and (
            lower(coalesce(payload->>'Utilizator',''))=lower(${dollar(userName)})
            or lower(coalesce(payload->>'Nume',''))=lower(${dollar(userName)})
            or (${dollar(headerCode)}<>'' and coalesce(payload->>'HeaderCode',payload->>'ID organizație','')=${dollar(headerCode)})
          )
        order by case when lower(coalesce(payload->>'Utilizator',''))=lower(${dollar(userName)}) then 0 else 1 end, id desc
        limit 1
      ), h as (
        select h.header_code, h.name, h.context_type
        from ${dqIdent(PGSCHEMA)}.care_header h
        where coalesce(h.active,true)=true
          and h.header_code = coalesce((select payload->>'HeaderCode' from login_payload),(select payload->>'ID organizație' from login_payload),${dollar(headerCode)})
        order by h.id desc
        limit 1
      )
      select json_build_object(
        'userName', coalesce((select payload->>'Nume' from login_payload),(select payload->>'Utilizator' from login_payload),${dollar(userName)}),
        'headerCode', coalesce((select header_code from h), ''),
        'headerName', coalesce((select name from h), case when coalesce((select payload->>'HeaderCode' from login_payload),(select payload->>'ID organizație' from login_payload),${dollar(headerCode)})<>'' then 'Fără organizație activă' else ${dollar(st.headerName || '')} end),
        'orgType', coalesce((select context_type from h),(select payload->>'Tip organizație' from login_payload),${dollar(st.orgType || '')})
      )::text;`);
    const parsed = JSON.parse(out || '{}');
    return { ...st, userName: parsed.userName || st.userName, headerCode: parsed.headerCode || st.headerCode, headerName: parsed.headerName || st.headerName, orgType: parsed.orgType || st.orgType };
  } catch (_) { return st; }
}
async function handleMainAuthApi(req, res, url) {
  if (url.pathname === '/api/auth/session' && req.method === 'GET') {
    const hasUsers = (await mainLoginUserCount()) > 0;
    let st = getMainSessionState(req);
    st = await enrichMainSessionFromDb(st);
    const token = parseCookies(req).fc_main_session || '';
    if (token && st) res.setHeader('Set-Cookie', sessionCookie(token, req, Math.floor(SESSION_TTL_MS / 1000)));
    send(res, 200, JSON.stringify({ ok:true, authenticated:!!st, authRequired:AUTH_REQUIRED, registrationAllowed:ALLOW_PUBLIC_REGISTRATION, hasUsers, name:st&&st.userName||ADMIN_NAME, userName:st&&st.userName||ADMIN_NAME, headerCode:st&&st.headerCode||'', headerName:st&&st.headerName||'', orgType:st&&st.orgType||'', role:st&&st.role||'' }), 'application/json; charset=utf-8');
    return true;
  }
  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    if (!ALLOW_PUBLIC_REGISTRATION) { send(res, 403, JSON.stringify({ ok:false, error:'Crearea publică de conturi este dezactivată. Solicită administratorului activarea înregistrării.' }), 'application/json; charset=utf-8'); return true; }
    try {
      // V1.0.94: în perioada de testare, utilizatorul nou se poate crea direct din login,
      // inclusiv după ce există deja primul cont.
      const body = await readJson(req);
      const result = await createMainLoginUser(body);
      openSessionFor(res, req, body.name || body.Nume || body.user || ADMIN_NAME, { HeaderCode: result.headerCode || '', 'Organizație / cont': result.headerName || result.organizatie || '', 'Tip organizație': body.orgType || body['Tip organizație'] || '' });
      send(res, 200, JSON.stringify({ ok:true, ...result }), 'application/json; charset=utf-8');
      return true;
    } catch (e) { send(res, 400, JSON.stringify({ ok:false, error:e.message || 'Contul nu a putut fi creat.' }), 'application/json; charset=utf-8'); return true; }
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    if (!AUTH_REQUIRED) { send(res, 200, JSON.stringify({ ok:true, authRequired:false }), 'application/json; charset=utf-8'); return true; }
    if (loginBlocked(req)) { send(res, 429, JSON.stringify({ ok:false, error:'Prea multe încercări. Reîncearcă peste 15 minute.' }), 'application/json; charset=utf-8'); return true; }
    try {
      const body = await readJson(req);
      const suppliedIdentifier = String(body.identifier || body.user || body.phone || body.Telefon || '').trim();
      if (suppliedIdentifier.toLowerCase() === SUPERUSER_NAME.toLowerCase() && sameSecret(body.password || '', SUPERUSER_PASSWORD)) {
        loginAttempts.delete(loginKey(req));
        openSessionFor(res, req, 'Camil - Superuser', { Nume:'Camil - Superuser', Utilizator:SUPERUSER_NAME, Rol:'superuser' });
        send(res, 200, JSON.stringify({ ok:true, name:'Camil - Superuser', role:'superuser' }), 'application/json; charset=utf-8');
        return true;
      }
      const users = await mainLoginUserCount();
      if (!users && ADMIN_PASSWORD && sameSecret(body.password || '', ADMIN_PASSWORD)) {
        loginAttempts.delete(loginKey(req));
        openSessionFor(res, req, ADMIN_NAME, {});
        send(res, 200, JSON.stringify({ ok:true, name:ADMIN_NAME }), 'application/json; charset=utf-8');
        return true;
      }
      const found = await findMainLoginUser(body.identifier || body.user || body.phone || body.Telefon || '');
      let payload = found && found.payload ? found.payload : null;
      payload = await restoreApartinatorPayloadIfNeeded(found, body.identifier || body.user || body.phone || body.Telefon || '');
      const role = String(payload && payload.Rol || '').trim().toLowerCase();
      const beneficiaryAccount = role === 'beneficiar' || role === 'senior';
      const suppliedSecret = String(body.password || body.pin || '').trim();
      const passwordMatch = !!(payload && payload.Hash) && passwordHash(suppliedSecret, payload.Salt || '', Number(payload.Iterations || 180000)) === payload.Hash;
      const pinEnabled = String(payload && payload.PinActiv || '').toLowerCase() === 'true';
      const pinMatch = pinEnabled && /^\d{4}$/.test(suppliedSecret) && !!payload.PinHash && passwordHash(suppliedSecret, payload.PinSalt || '', Number(payload.PinIterations || 120000)) === payload.PinHash;
      if (!payload || (!passwordMatch && !pinMatch)) {
        registerLoginFailure(req);
        send(res, 401, JSON.stringify({ ok:false, error:'Utilizator/telefon, parolă sau PIN incorect.' }), 'application/json; charset=utf-8');
        return true;
      }
      if (beneficiaryAccount) {
        send(res, 403, JSON.stringify({ ok:false, error:'Acest cont aparține unui beneficiar și poate intra numai în FamilyCare Senior.' }), 'application/json; charset=utf-8');
        return true;
      }
      loginAttempts.delete(loginKey(req));
      openSessionFor(res, req, payload.Nume || ADMIN_NAME, payload);
      send(res, 200, JSON.stringify({ ok:true, name:payload.Nume || ADMIN_NAME, headerCode:payload.HeaderCode||'', headerName:payload['Organizație / cont']||payload.Organizatie||'' }), 'application/json; charset=utf-8');
      return true;
    } catch (e) { send(res, 400, JSON.stringify({ ok:false, error:e.message || 'Cerere invalidă.' }), 'application/json; charset=utf-8'); return true; }
  }

  if (url.pathname === '/api/admin/access-accounts' && req.method === 'GET') {
    const session = getMainSessionState(req);
    if (!session) { send(res, 401, JSON.stringify({ok:false,error:'Autentificare necesară.'}), 'application/json; charset=utf-8'); return true; }
    try {
      const scope = String(session.headerCode || '').trim();
      const role = String(session.role || '').toLowerCase();
      const scopeFilter = role === 'superuser' || !scope ? '' : ` and coalesce(payload->>'HeaderCode',payload->>'ID organizație','')=${dollar(scope)}`;
      const out = await runPsql(`select coalesce(json_agg(row_to_json(t))::text,'[]') from (
        select id,
          coalesce(payload->>'Beneficiar',payload->>'Nume',payload->>'Utilizator','Utilizator') as name,
          coalesce(payload->>'Utilizator',payload->>'Nume','') as username,
          coalesce(payload->>'Telefon','') as phone,
          coalesce(payload->>'Email','') as email,
          coalesce(payload->>'Rol','membru') as role,
          coalesce(payload->>'EntityCode',payload->>'Cod beneficiar','') as entity_code,
          case when coalesce(payload->>'Hash','')<>'' then true else false end as password_configured,
          case when lower(coalesce(payload->>'PinActiv','false'))='true' and coalesce(payload->>'PinHash','')<>'' then true else false end as pin_enabled
        from ${dqIdent(PGSCHEMA)}.config_record
        where section_key='main-login-user' and coalesce((payload->>'Activ')::boolean,true)=true${scopeFilter}
        order by lower(coalesce(payload->>'Rol','')), lower(coalesce(payload->>'Beneficiar',payload->>'Nume',payload->>'Utilizator',''))
      ) t;`);
      send(res, 200, out || '[]', 'application/json; charset=utf-8');
    } catch(e) { send(res, 500, JSON.stringify({ok:false,error:e.message||'Nu s-au putut încărca utilizatorii.'}), 'application/json; charset=utf-8'); }
    return true;
  }
  const accessMatch = url.pathname.match(/^\/api\/admin\/access-accounts\/(\d+)$/);
  if (accessMatch && req.method === 'PUT') {
    const session = getMainSessionState(req);
    if (!session) { send(res, 401, JSON.stringify({ok:false,error:'Autentificare necesară.'}), 'application/json; charset=utf-8'); return true; }
    try {
      const body = await readJson(req);
      const id = Number(accessMatch[1]);
      const password = String(body.password || '').trim();
      const pin = String(body.pin || '').trim();
      const pinEnabled = body.pinEnabled === true;
      const clearPin = body.clearPin === true;
      if (!password && !pin && body.pinEnabled === undefined && !clearPin) throw new Error('Completează parola nouă sau PIN-ul.');
      if (password && password.length < 8) throw new Error('Parola nouă trebuie să aibă minimum 8 caractere.');
      if (pin && !/^\d{4}$/.test(pin)) throw new Error('PIN-ul trebuie să conțină exact 4 cifre.');
      if (pin && (/^(\d)\1{3}$/.test(pin) || ['1234','4321','0123','9876'].includes(pin))) throw new Error('Alege un PIN mai sigur. Nu folosi cifre identice sau secvențe simple.');
      if (pinEnabled && !pin && !clearPin) {
        const chk = await runPsql(`select coalesce((select case when coalesce(payload->>'PinHash','')<>'' then '1' else '0' end from ${dqIdent(PGSCHEMA)}.config_record where id=${id} and section_key='main-login-user'),'0');`);
        if (String(chk||'0').trim() !== '1') throw new Error('Setează mai întâi un PIN din 4 cifre.');
      }
      const role = String(session.role || '').toLowerCase();
      const scope = String(session.headerCode || '').trim();
      const guard = role === 'superuser' || !scope ? '' : ` and coalesce(payload->>'HeaderCode',payload->>'ID organizație','')=${dollar(scope)}`;
      const pairs=[];
      if (clearPin) pairs.push(`'PinSalt','', 'PinIterations',0, 'PinHash','', 'PinActiv',false, 'PinActualizatLa',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS')`);
      if (password) {
        const salt=crypto.randomBytes(16).toString('hex'), iterations=180000;
        pairs.push(`'Salt',${dollar(salt)},'Iterations',${iterations},'Hash',${dollar(passwordHash(password,salt,iterations))},'ParolaResetataDeAdminLa',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS')`);
      }
      if (pin) {
        const salt=crypto.randomBytes(16).toString('hex'), iterations=120000;
        pairs.push(`'PinSalt',${dollar(salt)},'PinIterations',${iterations},'PinHash',${dollar(passwordHash(pin,salt,iterations))},'PinActiv',${pinEnabled?'true':'false'},'PinActualizatLa',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS')`);
      } else if (body.pinEnabled !== undefined) {
        pairs.push(`'PinActiv',${pinEnabled?'true':'false'}`);
      }
      const sql=`update ${dqIdent(PGSCHEMA)}.config_record set payload=payload || jsonb_build_object(${pairs.join(',')}), updated_at=now() where id=${id} and section_key='main-login-user'${guard} returning json_build_object('ok',true,'id',id)::text;`;
      const out=await runPsql(sql);
      if(!String(out||'').trim()) throw new Error('Utilizatorul nu a fost găsit sau nu aparține rețelei tale.');
      send(res,200,String(out).split('\n').pop(),'application/json; charset=utf-8');
    } catch(e) { send(res,400,JSON.stringify({ok:false,error:e.message||'Datele de acces nu au putut fi actualizate.'}),'application/json; charset=utf-8'); }
    return true;
  }

  if (url.pathname === '/api/auth/password-reset/request' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const identifier = String(body.identifier || body.user || body.email || '').trim();
      if (!identifier) throw new Error('Completează utilizatorul sau adresa de e-mail.');
      if (identifier.toLowerCase() === SUPERUSER_NAME.toLowerCase()) {
        send(res, 400, JSON.stringify({ ok:false, error:'Parola superuserului se modifică numai din variabila SUPERUSER_PASSWORD.' }), 'application/json; charset=utf-8');
        return true;
      }
      const found = await findMainLoginUser(identifier);
      const payload = found && found.payload ? found.payload : null;
      const email = String(payload && payload.Email || '').trim().toLowerCase();
      if (!payload || !email) {
        send(res, 200, JSON.stringify({ ok:true, message:'Dacă utilizatorul există și are e-mail configurat, vei primi un cod de verificare.' }), 'application/json; charset=utf-8');
        return true;
      }
      const code = String(crypto.randomInt(100000, 1000000));
      const requestId = crypto.randomBytes(18).toString('base64url');
      passwordResetRequests.set(requestId, { userId:Number(found.id), codeHash:crypto.createHash('sha256').update(code).digest('hex'), expires:Date.now()+15*60*1000, attempts:0 });
      const result = await sendAndLog('reset-parola', email, 'Cod resetare parolă FamilyCare', `Codul tău pentru resetarea parolei este: ${code}

Codul este valabil 15 minute. Dacă nu ai solicitat resetarea, ignoră acest mesaj.`, String(payload.HeaderCode || payload['ID organizație'] || ''));
      if (!result.ok) {
        passwordResetRequests.delete(requestId);
        throw new Error('E-mailul de resetare nu a putut fi trimis. Verifică setările de e-mail din FamilyCare.');
      }
      send(res, 200, JSON.stringify({ ok:true, requestId, maskedEmail:email.replace(/^(.{1,2}).*(@.*)$/,'$1***$2'), message:'Am trimis un cod de verificare pe e-mail.' }), 'application/json; charset=utf-8');
      return true;
    } catch (e) { send(res, 400, JSON.stringify({ ok:false, error:e.message || 'Resetarea nu a putut fi inițiată.' }), 'application/json; charset=utf-8'); return true; }
  }
  if (url.pathname === '/api/auth/password-reset/confirm' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const requestId = String(body.requestId || '').trim();
      const code = String(body.code || '').trim();
      const password = String(body.password || '');
      const state = passwordResetRequests.get(requestId);
      if (!state || state.expires < Date.now()) throw new Error('Cererea de resetare a expirat. Solicită un cod nou.');
      if (password.length < 8) throw new Error('Noua parolă trebuie să aibă minimum 8 caractere.');
      state.attempts += 1;
      if (state.attempts > 5) { passwordResetRequests.delete(requestId); throw new Error('Prea multe încercări. Solicită un cod nou.'); }
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      if (!sameSecret(codeHash, state.codeHash)) throw new Error('Codul de verificare este incorect.');
      const salt = crypto.randomBytes(16).toString('hex');
      const iterations = 180000;
      const hash = passwordHash(password, salt, iterations);
      await runPsql(`update ${dqIdent(PGSCHEMA)}.config_record set payload=payload || jsonb_build_object('Salt',${dollar(salt)},'Iterations',${iterations},'Hash',${dollar(hash)},'ParolaResetataLa',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS')) where id=${Number(state.userId)} and section_key='main-login-user';`);
      passwordResetRequests.delete(requestId);
      send(res, 200, JSON.stringify({ ok:true, message:'Parola a fost schimbată. Te poți autentifica.' }), 'application/json; charset=utf-8');
      return true;
    } catch (e) { send(res, 400, JSON.stringify({ ok:false, error:e.message || 'Parola nu a putut fi schimbată.' }), 'application/json; charset=utf-8'); return true; }
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'DELETE') {
    const token = parseCookies(req).fc_main_session || '';
    if (token) adminSessions.delete(token);
    res.setHeader('Set-Cookie', sessionCookie('', req, 0));
    send(res, 200, JSON.stringify({ ok:true }), 'application/json; charset=utf-8');
    return true;
  }
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};
const SENIOR_PORT = Number(process.env.SENIOR_PORT || 31001);
const SENIOR_BASE_URL = String(process.env.SENIOR_BASE_URL || '').replace(/\/$/, '');
function safeOrigin(value) { try { return new URL(value).origin; } catch (_) { return ''; } }
function seniorFrameSourcesFor(req) {
  const configured = safeOrigin(SENIOR_BASE_URL);
  let localSources = '';
  try {
    const hostname = new URL(PROTOCOL + '://' + String(req.headers.host || 'localhost')).hostname;
    if (/^[a-z0-9.:-]+$/i.test(hostname)) {
      const host = hostname.includes(':') ? '[' + hostname + ']' : hostname;
      localSources = ' http://' + host + ':' + SENIOR_PORT + ' https://' + host + ':' + SENIOR_PORT;
    }
  } catch (_) {}
  return (configured ? ' ' + configured : '') + localSources;
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'" + (res.familyCareSeniorFrameSources || '') + "; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
    ...(res.familyCareSecureRequest ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    ...extraHeaders
  });
  res.end(body);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const forwardedProto = String(req.headers['x-forwarded-proto'] || PROTOCOL).split(',')[0].trim();
    return parsed.protocol === forwardedProto + ':' && parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch (_) { return false; }
}

function sectionOk(section) {
  return /^[a-z0-9-]+$/.test(section || '');
}
function idOk(id) {
  return /^[0-9]+$/.test(String(id || ''));
}
function dqIdent(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}
function dollar(text) {
  let tag = 'fc';
  while (String(text).includes('$' + tag + '$')) tag += 'x';
  return '$' + tag + '$' + String(text) + '$' + tag + '$';
}

const SUBSCRIPTION_RULES = {
  Basic:{maxPatients:2,maxRecipients:1,features:['confirmations','missed-alerts','journal']},
  Family:{maxPatients:2,maxRecipients:3,features:['confirmations','missed-alerts','journal','family-notifications']},
  Premium:{maxPatients:4,maxRecipients:null,features:['confirmations','missed-alerts','journal','family-notifications','doctor-export']},
  Unlimited:{maxPatients:null,maxRecipients:null,features:['confirmations','missed-alerts','journal','family-notifications','doctor-export','multi-unit']}
};
async function getSubscriptionStatus(headerCode=''){
  const scope=String(headerCode||'').trim();
  const configScope=scope?` and (payload->>'HeaderCode'=${dollar(scope)} or (coalesce(payload->>'HeaderCode','')='' and (select count(*) from ${dqIdent(PGSCHEMA)}.care_header where coalesce(active,true)=true)=1))`:'';
  const entityScope=scope?` and care_header_id in (select id from ${dqIdent(PGSCHEMA)}.care_header where header_code=${dollar(scope)})`:'';
  let selection={};
  try{selection=JSON.parse(await runPsql(`select coalesce((select payload::text from ${dqIdent(PGSCHEMA)}.config_record where section_key='subscription-selection'${configScope} order by id desc limit 1),'{}');`)||'{}');}catch(_){}
  const plan=SUBSCRIPTION_RULES[selection.Plan]?selection.Plan:'Basic';
  const periodMonths=[1,3,6,12].includes(Number(selection['Perioadă luni']))?Number(selection['Perioadă luni']):1;
  let usage={beneficiaries:0,units:0};
  try{usage=JSON.parse(await runPsql(`select json_build_object('beneficiaries',(select count(*) from ${dqIdent(PGSCHEMA)}.managed_entity where coalesce(active,true)=true and coalesce(allows_senior_screen,true)=true${entityScope}),'units',(select count(*) from ${dqIdent(PGSCHEMA)}.care_branch where coalesce(active,true)=true${entityScope}))::text;`)||'{}');}catch(_){}
  return {ok:true,plan,periodMonths,price:selection['Preț']||'',...SUBSCRIPTION_RULES[plan],usage};
}
function limitedRecipients(value,status){
  const unique=[...new Set(String(value||'').split(/[;,\s]+/).map(x=>x.trim()).filter(Boolean))];
  return status.maxRecipients===null?unique.join(','):unique.slice(0,status.maxRecipients).join(',');
}
async function handleSubscriptionApi(req,res,url){
  if(url.pathname!=='/api/subscription/status')return false;
  if(req.method!=='GET'){send(res,405,'Method not allowed');return true}
  send(res,200,JSON.stringify(await getSubscriptionStatus(getMainScope(req).headerCode)),'application/json; charset=utf-8');
  return true;
}


// V1.0.70: configurările esențiale din Main sunt legate direct la tabelele reale citite de Senior.
// Nu mai salvăm persoane/ramificații doar generic în config_record.
const DIRECT_CONFIG_SECTIONS = new Set(['care-header','branches','care-persons','users','doctors','providers']);
function makeCode(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}
function activeSql(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ['nu','no','false','0','inactiv','inactive','off'].includes(v) ? 'false' : 'true';
}
function seniorScreenSql(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ['nu','no','false','0','inactiv','inactive','off'].includes(v) ? 'false' : 'true';
}
function firstHeaderCte(session = {}) {
  const scope = String(session.headerCode || '').trim();
  const scopeFilter = scope ? ` and header_code=${dollar(scope)}` : '';
  return `h0 as (select id from ${dqIdent(PGSCHEMA)}.care_header where coalesce(active,true)=true${scopeFilter} order by id limit 1),
    h_ins as (
      insert into ${dqIdent(PGSCHEMA)}.care_header(header_code,name,context_type,coordinator_name,description,active)
      select ${dollar(makeCode('CH'))}, 'FamilyCare', 'familie_proprie', '', 'Creat automat de FamilyCare Main', true
      where not exists(select 1 from h0)
      returning id
    ),
    h as (select id from h0 union all select id from h_ins limit 1)`;
}
function directConfigSelectSql(section, session = {}) {
  const q = dqIdent(PGSCHEMA);
  const scope = String(session.headerCode || '').trim();
  const headerFilter = scope ? ` and header_code=${dollar(scope)}` : '';
  const joinedHeaderFilter = scope ? ` and h.header_code=${dollar(scope)}` : '';
  if (section === 'care-header') return `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
    select id, 'care-header' as section_key,
      jsonb_build_object('Denumire',name,'Tip context',context_type,'Coordonator',coalesce(coordinator_name,''),'Detalii',coalesce(description,'')) as payload,
      id as sort_order
    from ${q}.care_header where coalesce(active,true)=true${headerFilter} order by id
  ) t;`;
  if (section === 'branches') return `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
    select b.id, 'branches' as section_key,
      jsonb_build_object('Organizație / cont',coalesce(h.name,''),'Denumire ramificație',b.name,'Tip',b.branch_type,'Oraș',coalesce(b.city,''),'Arie / județ / țară',coalesce(b.description,''),'Coordonator',coalesce(b.coordinator_name,'')) as payload,
      b.sort_order
    from ${q}.care_branch b
    left join ${q}.care_header h on h.id=b.care_header_id
    where coalesce(b.active,true)=true${joinedHeaderFilter} order by coalesce(h.name,''),b.sort_order,b.id
  ) t;`;
  if (section === 'care-persons') return `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
    select e.id, 'care-persons' as section_key,
      jsonb_build_object(
        'Organizație / cont',coalesce(h.name,''),
        'Denumire',e.display_name,
        'Tip entitate',e.entity_type,
        'Ramificație',coalesce(b.name,''),
        'Adresă / detalii',coalesce(e.address_notes,e.access_details,concat_ws(', ',e.country,e.city,e.street,e.street_no),''),
        'Responsabil',coalesce(e.notes,''),
        'Cod beneficiar',coalesce(e.entity_code,''),
        'Utilizator senior',coalesce(login.payload->>'Utilizator',''),
        'Telefon senior',coalesce(login.payload->>'Telefon',e.phone,''),
        'Aparținător',coalesce(login.payload->>'Organizație / cont',h.name,''),
        'Telefon contact familie 1',coalesce(contact.payload->>'Telefon principal',''),
        'Telefon contact familie 2',coalesce(contact.payload->>'Telefon secundar',''),
        'Telefon contact familie 3',coalesce(contact.payload->>'Telefon al treilea','')
      ) as payload,
      e.id as sort_order
    from ${q}.managed_entity e
    left join ${q}.care_branch b on b.id=e.care_branch_id
    left join ${q}.care_header h on h.id=e.care_header_id
    left join lateral (
      select payload from ${q}.config_record c
      where c.section_key='main-login-user'
        and coalesce(c.payload->>'EntityCode',c.payload->>'Cod beneficiar','')=e.entity_code
      order by c.id desc limit 1
    ) login on true
    left join lateral (
      select payload from ${q}.config_record c
      where c.section_key='family-contact'
        and coalesce(c.payload->>'EntityCode',c.payload->>'Cod entitate','')=e.entity_code
      order by c.id desc limit 1
    ) contact on true
    where coalesce(e.active,true)=true${joinedHeaderFilter}
    order by coalesce(h.name,''),coalesce(b.sort_order,9999),e.display_name,e.id
  ) t;`;
  if (section === 'users') return `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
    select id, 'users' as section_key,
      jsonb_build_object('Nume',display_name,'Email',coalesce(email,''),'Rol',role_key,'Domiciliu complet',coalesce(address_notes,concat_ws(', ',country,city,street,street_no),'')) as payload,
      id as sort_order
    from ${q}.app_user where coalesce(active,true)=true order by display_name,id
  ) t;`;
  if (section === 'doctors') return `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
    select id, 'doctors' as section_key,
      jsonb_build_object('Nume medic',full_name,'Specialitate',coalesce(specialty,''),'Telefon',coalesce(phone,''),'Domiciliu/cabinet',coalesce(clinic_name,address_notes,concat_ws(', ',country,city,street,street_no),'')) as payload,
      id as sort_order
    from ${q}.doctor where coalesce(active,true)=true order by full_name,id
  ) t;`;
  if (section === 'providers') return `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
    select id, 'providers' as section_key,
      jsonb_build_object('Denumire',name,'Tip furnizor',provider_type,'Telefon',coalesce(phone,''),'Adresă completă',coalesce(address_notes,concat_ws(', ',country,city,street,street_no),'')) as payload,
      id as sort_order
    from ${q}.provider where coalesce(active,true)=true order by name,id
  ) t;`;
  return null;
}

function beneficiaryLoginUserCtes(entityCteName, b, options = {}) {
  let user = String(b['Utilizator senior'] || b['Utilizator'] || '').trim();
  const phone = normalizePhone(b['Telefon senior'] || b['Telefon'] || '');
  if (!user && phone) user = phone;
  const password = String(b['Parolă senior'] || b['Parola senior'] || b['Parolă'] || b['Parola'] || '');
  const allowWithoutPassword = options.allowWithoutPassword === true;
  const hasAny = !!(user || phone || password);
  if (!hasAny) return '';
  if (!user || (!password && !allowWithoutPassword)) throw new Error('Pentru login beneficiar completează cel puțin Utilizator senior și Parolă senior. Telefonul este opțional.');
  if (password && password.length < 6) throw new Error('Parola senior trebuie să aibă minimum 6 caractere.');
  const q = dqIdent(PGSCHEMA);
  const hasPassword = !!password;
  const salt = hasPassword ? crypto.randomBytes(16).toString('hex') : '';
  const iterations = 180000;
  const hash = hasPassword ? passwordHash(password, salt, iterations) : '';
  const passwordPairs = hasPassword ? `,
        'Salt', ${dollar(salt)},
        'Iterations', ${iterations},
        'Hash', ${dollar(hash)}` : '';
  return `, scope_for_login as (
      select e.id, e.entity_code, e.display_name, h.header_code, h.name as header_name, h.context_type, b.branch_code, b.name as branch_name
      from ${entityCteName} e
      left join ${q}.care_header h on h.id=e.care_header_id
      left join ${q}.care_branch b on b.id=e.care_branch_id
      limit 1
    ), upd_login_user as (
      update ${q}.config_record u
      set payload = u.payload || jsonb_build_object(
        'Nume', ${dollar(user)},
        'Utilizator', ${dollar(user)},
        'Telefon', ${dollar(phone)},
        'Tip organizație', coalesce((select context_type from scope_for_login),'familie_proprie'),
        'HeaderCode', coalesce((select header_code from scope_for_login),''),
        'ID organizație', coalesce((select header_code from scope_for_login),''),
        'Organizație / cont', coalesce((select header_name from scope_for_login),''),
        'Organizatie', coalesce((select header_name from scope_for_login),''),
        'BranchCode', coalesce((select branch_code from scope_for_login),''),
        'Grup / locație', coalesce((select branch_name from scope_for_login),''),
        'EntityCode', coalesce((select entity_code from scope_for_login),''),
        'Cod beneficiar', coalesce((select entity_code from scope_for_login),''),
        'Beneficiar', coalesce((select display_name from scope_for_login),''),
        'Rol', 'beneficiar'${passwordPairs},
        'Activ', true,
        'ActualizatLa', to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS')
      )
      where u.section_key='main-login-user'
        and coalesce((u.payload->>'Activ')::boolean,true)=true
        and (
          coalesce(u.payload->>'EntityCode','')=coalesce((select entity_code from scope_for_login),'')
          or (
            coalesce(u.payload->>'EntityCode','')<>''
            and (
              (${dollar(phone)}<>'' and coalesce(u.payload->>'Telefon','')=${dollar(phone)})
              or lower(coalesce(u.payload->>'Utilizator',''))=lower(${dollar(user)})
            )
          )
        )
      returning id
    ), ins_login_user as (
      insert into ${q}.config_record(section_key,payload,sort_order)
      select 'main-login-user', jsonb_build_object(
        'Nume', ${dollar(user)},
        'Utilizator', ${dollar(user)},
        'Telefon', ${dollar(phone)},
        'Tip organizație', coalesce((select context_type from scope_for_login),'familie_proprie'),
        'HeaderCode', coalesce((select header_code from scope_for_login),''),
        'ID organizație', coalesce((select header_code from scope_for_login),''),
        'Organizație / cont', coalesce((select header_name from scope_for_login),''),
        'Organizatie', coalesce((select header_name from scope_for_login),''),
        'BranchCode', coalesce((select branch_code from scope_for_login),''),
        'Grup / locație', coalesce((select branch_name from scope_for_login),''),
        'EntityCode', coalesce((select entity_code from scope_for_login),''),
        'Cod beneficiar', coalesce((select entity_code from scope_for_login),''),
        'Beneficiar', coalesce((select display_name from scope_for_login),''),
        'Rol', 'beneficiar'${passwordPairs},
        'Activ', true,
        'CreatLa', to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS')
      )::jsonb, 10
      where not exists(select 1 from upd_login_user)
        and ${hasPassword ? 'true' : 'false'}
        and not exists (
          select 1 from ${q}.config_record u
          where u.section_key='main-login-user'
            and coalesce((u.payload->>'Activ')::boolean,true)=true
            and coalesce(u.payload->>'EntityCode',u.payload->>'Cod beneficiar','')=''
            and (
              lower(coalesce(u.payload->>'Utilizator',''))=lower(${dollar(user)})
              or (${dollar(phone)}<>'' and coalesce(u.payload->>'Telefon','')=${dollar(phone)})
            )
        )
      returning id
    )`;
}


function beneficiaryContactCtes(entityCteName, b, options = {}) {
  const q = dqIdent(PGSCHEMA);
  const p1 = normalizePhone(b['Telefon contact familie 1'] || b['Telefon aparținător'] || b['Telefon apartinator'] || b['Telefon principal familie'] || '');
  const p2 = normalizePhone(b['Telefon contact familie 2'] || b['Telefon secundar familie'] || '');
  const p3 = normalizePhone(b['Telefon contact familie 3'] || b['Telefon urgență familie'] || b['Telefon urgenta familie'] || '');
  const n1 = String(b['Nume contact familie 1'] || b['Nume aparținător'] || b['Aparținător'] || 'Contact principal').trim() || 'Contact principal';
  const n2 = String(b['Nume contact familie 2'] || 'Contact secundar').trim() || 'Contact secundar';
  const n3 = String(b['Nume contact familie 3'] || 'Contact rezervă').trim() || 'Contact rezervă';
  const msg = String(b['Mesaj implicit familie'] || 'Te rog să mă contactezi.').trim() || 'Te rog să mă contactezi.';
  const help = String(b['Mesaj ajutor familie'] || 'Am nevoie de ajutor. Te rog să mă contactezi urgent.').trim() || 'Am nevoie de ajutor. Te rog să mă contactezi urgent.';
  const hasAny = !!(p1 || p2 || p3);
  if (!hasAny) return '';
  return `, contact_scope as (
      select e.id, e.entity_code, e.display_name, h.header_code, h.name as header_name, b.branch_code, b.name as branch_name
      from ${entityCteName} e
      left join ${q}.care_header h on h.id=e.care_header_id
      left join ${q}.care_branch b on b.id=e.care_branch_id
      limit 1
    ), del_old_contact as (
      delete from ${q}.config_record c
      where c.section_key='family-contact'
        and coalesce(c.payload->>'EntityCode', c.payload->>'Cod entitate', '')=coalesce((select entity_code from contact_scope),'')
      returning id
    ), ins_family_contact as (
      insert into ${q}.config_record(section_key,payload,sort_order)
      select 'family-contact', jsonb_strip_nulls(jsonb_build_object(
        'Nume','Contact familie',
        'HeaderCode',coalesce((select header_code from contact_scope),''),
        'ID organizație',coalesce((select header_code from contact_scope),''),
        'Organizație / cont',coalesce((select header_name from contact_scope),''),
        'BranchCode',coalesce((select branch_code from contact_scope),''),
        'Grup / locație',coalesce((select branch_name from contact_scope),''),
        'EntityCode',coalesce((select entity_code from contact_scope),''),
        'Cod entitate',coalesce((select entity_code from contact_scope),''),
        'Beneficiar',coalesce((select display_name from contact_scope),''),
        'Nume principal',${dollar(n1)},
        'Telefon principal',nullif(${dollar(p1)},''),
        'Nume secundar',${dollar(n2)},
        'Telefon secundar',nullif(${dollar(p2)},''),
        'Nume al treilea',${dollar(n3)},
        'Telefon al treilea',nullif(${dollar(p3)},''),
        'Mesaj SMS',${dollar(msg)},
        'Mesaj ajutor',${dollar(help)},
        'ActualizatLa',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS')
      )), 10
      returning id
    )`;
}

function directConfigInsertSql(section, b, session = {}) {
  const q = dqIdent(PGSCHEMA);
  const scope = String(session.headerCode || '').trim();
  const scopeHeader = scope ? ` and header_code=${dollar(scope)}` : '';
  if (section === 'care-header') {
    const headerCode = makeCode('CH');
    const branchCode = makeCode('CB');
    const orgName = String(b['Denumire']||'FamilyCare').trim() || 'FamilyCare';
    const orgType = String(b['Tip context']||'familie_proprie').trim() || 'familie_proprie';
    const userName = String(session.userName || '').trim();
    const updateCurrentUser = userName ? `, upd_user as (
      update ${q}.config_record u
      set payload = payload || jsonb_build_object(
        'HeaderCode', (select header_code from ins_h),
        'ID organizație', (select header_code from ins_h),
        'Organizație / cont', (select name from ins_h),
        'Organizatie', (select name from ins_h),
        'Tip organizație', (select context_type from ins_h),
        'BranchCode', ${dollar(branchCode)},
        'Grup / locație', 'Grup principal'
      )
      where u.section_key='main-login-user'
        and coalesce((u.payload->>'Activ')::boolean,true)=true
        and coalesce(u.payload->>'EntityCode',u.payload->>'Cod beneficiar','')=''
        and (lower(coalesce(u.payload->>'Utilizator',''))=lower(${dollar(userName)}) or lower(coalesce(u.payload->>'Nume',''))=lower(${dollar(userName)}))
      returning id
    )` : '';
    return `with ins_h as (
      insert into ${q}.care_header(header_code,name,context_type,coordinator_name,description,active)
      values (${dollar(headerCode)}, ${dollar(orgName)}, ${dollar(orgType)}, ${dollar(b['Coordonator']||userName||'')}, ${dollar(b['Detalii']||'')}, true)
      returning id, header_code, name, context_type
    ), ins_b as (
      insert into ${q}.care_branch(care_header_id,branch_code,name,branch_type,coordinator_name,description,sort_order,active)
      select id, ${dollar(branchCode)}, 'Grup principal', 'familie', ${dollar(b['Coordonator']||userName||'')}, 'Creat automat pentru organizație.', 10, true from ins_h
      returning id, branch_code, name
    )${updateCurrentUser}
    select json_build_object('ok',true,'id',(select id from ins_h),'headerCode',(select header_code from ins_h),'headerName',(select name from ins_h),'branchCode',(select branch_code from ins_b))::text;`;
  }
  if (section === 'branches') {
    const headerName = String(b['Organizație / cont'] || '').trim();
    return `with ${firstHeaderCte(session)}, hsel as (
      select id from ${q}.care_header where coalesce(active,true)=true${scopeHeader} and (${dollar(headerName)}='' or name=${dollar(headerName)} or header_code=${dollar(headerName)}) order by id limit 1
    )
    insert into ${q}.care_branch(care_header_id,branch_code,name,branch_type,coordinator_name,city,description,sort_order,active)
    select coalesce((select id from hsel),(select id from h)), ${dollar(makeCode('CB'))}, ${dollar(b['Denumire ramificație']||'Unitate')}, ${dollar(b['Tip']||'familie')}, ${dollar(b['Coordonator']||'')}, ${dollar(b['Oraș']||'')}, ${dollar(b['Arie / județ / țară']||'')}, 100, true
    returning json_build_object('ok',true,'id',id)::text;`;
  }
  if (section === 'care-persons') {
    const headerName = String(b['Organizație / cont'] || '').trim();
    const branch = String(b['Ramificație']||'').trim();
    const entityCode = makeCode('ME');
    const loginCtes = beneficiaryLoginUserCtes('ins_entity', b);
    const contactCtes = beneficiaryContactCtes('ins_entity', b);
    return `with ${firstHeaderCte(session)}, hsel as (
      select id from ${q}.care_header where coalesce(active,true)=true${scopeHeader} and (${dollar(headerName)}='' or name=${dollar(headerName)} or header_code=${dollar(headerName)}) order by id limit 1
    ), hh as (
      select coalesce((select id from hsel),(select id from h)) as id
    ), br as (
      select id from ${q}.care_branch where coalesce(active,true)=true and care_header_id=(select id from hh) and (branch_code=${dollar(branch)} or name=${dollar(branch)}) order by id limit 1
    ), ins_entity as (
      insert into ${q}.managed_entity(care_header_id,care_branch_id,entity_code,entity_type,display_name,phone,allows_senior_screen,address_notes,notes,active)
      select (select id from hh), (select id from br), ${dollar(entityCode)}, ${dollar(b['Tip entitate']||'senior')}, ${dollar(b['Denumire']||'Senior')}, ${dollar(normalizePhone(b['Telefon senior']||b['Telefon']||''))}, ${seniorScreenSql(b['Tip entitate']||'senior')}, ${dollar(b['Adresă / detalii']||'')}, ${dollar(b['Responsabil']||'')}, true
      returning id, entity_code, display_name, care_header_id, care_branch_id
    )${loginCtes}${contactCtes}
    select json_build_object('ok',true,'id',(select id from ins_entity),'entityCode',(select entity_code from ins_entity))::text;`;
  }
  if (section === 'users') return `insert into ${q}.app_user(user_code,display_name,email,role_key,address_notes,active)
    values (${dollar(makeCode('USR'))}, ${dollar(b['Nume']||'Utilizator')}, ${dollar(b['Email']||'')}, ${dollar(b['Rol']||'family_member')}, ${dollar(b['Domiciliu complet']||'')}, true)
    returning json_build_object('ok',true,'id',id)::text;`;
  if (section === 'doctors') return `insert into ${q}.doctor(doctor_code,full_name,specialty,phone,clinic_name,active)
    values (${dollar(makeCode('DR'))}, ${dollar(b['Nume medic']||'Medic')}, ${dollar(b['Specialitate']||'')}, ${dollar(b['Telefon']||'')}, ${dollar(b['Domiciliu/cabinet']||'')}, true)
    returning json_build_object('ok',true,'id',id)::text;`;
  if (section === 'providers') return `insert into ${q}.provider(provider_code,name,provider_type,phone,address_notes,active)
    values (${dollar(makeCode('PR'))}, ${dollar(b['Denumire']||'Furnizor')}, ${dollar(b['Tip furnizor']||'servicii')}, ${dollar(b['Telefon']||'')}, ${dollar(b['Adresă completă']||'')}, true)
    returning json_build_object('ok',true,'id',id)::text;`;
  return null;
}
function directConfigUpdateSql(section, id, b, session = {}) {
  const q = dqIdent(PGSCHEMA);
  const n = Number(id);
  const scope = String(session.headerCode || '').trim();
  const headerGuard = scope ? ` and header_code=${dollar(scope)}` : '';
  const branchGuard = scope ? ` and care_header_id in (select id from ${q}.care_header where header_code=${dollar(scope)})` : '';
  if (section === 'care-header') return `with upd as (
      update ${q}.care_header
      set name=${dollar(b['Denumire']||'FamilyCare')}, context_type=${dollar(b['Tip context']||'familie_proprie')}, coordinator_name=${dollar(b['Coordonator']||'')}, description=${dollar(b['Detalii']||'')}, updated_at=now()
      where id=${n}${headerGuard}
      returning id, header_code, name, context_type
    ), upd_users as (
      update ${q}.config_record u
      set payload = payload || jsonb_build_object('HeaderCode',(select header_code from upd),'ID organizație',(select header_code from upd),'Organizație / cont',(select name from upd),'Organizatie',(select name from upd),'Tip organizație',(select context_type from upd))
      where u.section_key='main-login-user' and coalesce(u.payload->>'HeaderCode',u.payload->>'ID organizație','')=(select header_code from upd)
      returning id
    ) select json_build_object('ok',true,'id',(select id from upd),'headerCode',(select header_code from upd),'headerName',(select name from upd))::text;`;
  if (section === 'branches') {
    const headerName = String(b['Organizație / cont'] || '').trim();
    return `with hsel as (select id from ${q}.care_header where coalesce(active,true)=true${headerGuard} and (${dollar(headerName)}='' or name=${dollar(headerName)} or header_code=${dollar(headerName)}) order by id limit 1)
      update ${q}.care_branch set care_header_id=coalesce((select id from hsel),care_header_id), name=${dollar(b['Denumire ramificație']||'Unitate')}, branch_type=${dollar(b['Tip']||'familie')}, city=${dollar(b['Oraș']||'')}, description=${dollar(b['Arie / județ / țară']||'')}, coordinator_name=${dollar(b['Coordonator']||'')}, updated_at=now() where id=${n}${branchGuard} returning json_build_object('ok',true,'id',id)::text;`;
  }
  if (section === 'care-persons') {
    const headerName = String(b['Organizație / cont'] || '').trim();
    const branch = String(b['Ramificație']||'').trim();
    const loginCtes = beneficiaryLoginUserCtes('updated_entity', b, { allowWithoutPassword:true });
    const contactCtes = beneficiaryContactCtes('updated_entity', b);
    return `with hsel as (select id from ${q}.care_header where coalesce(active,true)=true${headerGuard} and (${dollar(headerName)}='' or name=${dollar(headerName)} or header_code=${dollar(headerName)}) order by id limit 1),
      hh as (select coalesce((select id from hsel),(select care_header_id from ${q}.managed_entity where id=${n}${branchGuard})) as id),
      br as (select id from ${q}.care_branch where coalesce(active,true)=true and care_header_id=(select id from hh) and (branch_code=${dollar(branch)} or name=${dollar(branch)}) order by id limit 1),
      updated_entity as (
        update ${q}.managed_entity set care_header_id=(select id from hh), display_name=${dollar(b['Denumire']||'Senior')}, entity_type=${dollar(b['Tip entitate']||'senior')}, care_branch_id=(select id from br), phone=coalesce(nullif(${dollar(normalizePhone(b['Telefon senior']||b['Telefon']||''))},''),phone), allows_senior_screen=${seniorScreenSql(b['Tip entitate']||'senior')}, address_notes=${dollar(b['Adresă / detalii']||'')}, notes=${dollar(b['Responsabil']||'')}, updated_at=now()
        where id=${n}${branchGuard} returning id, entity_code, display_name, care_header_id, care_branch_id
      )${loginCtes}${contactCtes}
      select json_build_object('ok',true,'id',(select id from updated_entity),'entityCode',(select entity_code from updated_entity))::text;`;
  }
  if (section === 'users') return `update ${q}.app_user set display_name=${dollar(b['Nume']||'Utilizator')}, email=${dollar(b['Email']||'')}, role_key=${dollar(b['Rol']||'family_member')}, address_notes=${dollar(b['Domiciliu complet']||'')}, updated_at=now() where id=${n} returning json_build_object('ok',true,'id',id)::text;`;
  if (section === 'doctors') return `update ${q}.doctor set full_name=${dollar(b['Nume medic']||'Medic')}, specialty=${dollar(b['Specialitate']||'')}, phone=${dollar(b['Telefon']||'')}, clinic_name=${dollar(b['Domiciliu/cabinet']||'')}, updated_at=now() where id=${n} returning json_build_object('ok',true,'id',id)::text;`;
  if (section === 'providers') return `update ${q}.provider set name=${dollar(b['Denumire']||'Furnizor')}, provider_type=${dollar(b['Tip furnizor']||'servicii')}, phone=${dollar(b['Telefon']||'')}, address_notes=${dollar(b['Adresă completă']||'')}, updated_at=now() where id=${n} returning json_build_object('ok',true,'id',id)::text;`;
  return null;
}
function directConfigDeleteSql(section, id, session = {}) {
  const q = dqIdent(PGSCHEMA);
  const n = Number(id);
  const table = { 'care-header':'care_header', branches:'care_branch', 'care-persons':'managed_entity', users:'app_user', doctors:'doctor', providers:'provider' }[section];
  if (!table) return null;
  const scope = String(session.headerCode || '').trim();
  let guard = '';
  if (scope && section === 'care-header') guard = ` and header_code=${dollar(scope)}`;
  if (scope && (section === 'branches' || section === 'care-persons')) guard = ` and care_header_id in (select id from ${q}.care_header where header_code=${dollar(scope)})`;
  return `update ${q}.${dqIdent(table).replace(/"/g,'')} set active=false, updated_at=now() where id=${n}${guard}; select json_build_object('ok',true)::text;`;
}
async function handleDirectConfigApi(req, res, section, id) {
  if (!DIRECT_CONFIG_SECTIONS.has(section)) return false;
  try {
    let sql = null;
    const session = getMainSessionState(req) || {};
    if (req.method === 'GET' && !id) sql = directConfigSelectSql(section, session);
    else if (req.method === 'POST' && !id) {
      const body=await readJson(req);
      if(section==='care-persons' && seniorScreenSql(body['Tip entitate']||'senior')==='true'){
        const subscription=await getSubscriptionStatus(getMainScope(req).headerCode);
        if(subscription.maxPatients!==null && Number(subscription.usage?.beneficiaries||0)>=subscription.maxPatients){
          send(res,402,JSON.stringify({ok:false,error:`Planul ${subscription.plan} permite maximum ${subscription.maxPatients} beneficiari. Schimbă planul din Configurări > Abonament.`}),'application/json; charset=utf-8');return true;
        }
      }
      sql = directConfigInsertSql(section, body, session);
    }
    else if (req.method === 'PUT' && idOk(id)) sql = directConfigUpdateSql(section, id, await readJson(req), session);
    else if (req.method === 'DELETE' && idOk(id)) sql = directConfigDeleteSql(section, id, session);
    else { send(res, 405, 'Method not allowed'); return true; }
    const out = await runPsql(sql);
    send(res, 200, (req.method === 'GET' ? (out || '[]') : (String(out||'').split('\n').pop() || '{"ok":true}')), 'application/json; charset=utf-8');
    return true;
  } catch (e) {
    send(res, 500, e.message || 'Database error');
    return true;
  }
}

let pgPool = null;
let PgPoolCtor = null;
function getPgPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!PgPoolCtor) {
    try { PgPoolCtor = require('pg').Pool; }
    catch (e) { throw new Error('Lipsește dependența pg. Rulează npm install sau verifică package.json.'); }
  }
  if (!pgPool) {
    const sslMode = String(process.env.PGSSLMODE || '').toLowerCase();
    const sslDisabled = ['disable','disabled','false','0','no'].includes(sslMode) || String(process.env.DATABASE_SSL || '').toLowerCase() === 'false';
    const sslRequired = ['require','true','1','yes'].includes(sslMode) || String(process.env.DATABASE_SSL || '').toLowerCase() === 'true' || !!process.env.RENDER;
    pgPool = new PgPoolCtor({
      connectionString: process.env.DATABASE_URL,
      ssl: sslDisabled ? false : (sslRequired ? { rejectUnauthorized: false } : undefined),
      max: Number(process.env.PGPOOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });
  }
  return pgPool;
}
function stringifyPgValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function formatPgOutput(result) {
  const results = Array.isArray(result) ? result : [result];
  const lastWithRows = [...results].reverse().find(r => r && Array.isArray(r.rows));
  if (!lastWithRows || !lastWithRows.rows.length) return '';
  return lastWithRows.rows.map(row => {
    const vals = Object.values(row);
    if (vals.length === 1) return stringifyPgValue(vals[0]);
    return vals.map(stringifyPgValue).join('|');
  }).join('\n').trim();
}
function runPsql(sql) {
  const pool = getPgPool();
  if (pool) {
    return pool.query(sql).then(formatPgOutput).catch(err => {
      throw new Error(err && err.message ? err.message : 'PostgreSQL query failed');
    });
  }
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), 'familycare_' + Date.now() + '_' + Math.random().toString(16).slice(2) + '.sql');
    fs.writeFileSync(file, sql, 'utf8');
    const args = ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', file];
    const env = { ...process.env };
    execFile(PSQL_BIN, args, { env, windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(file); } catch (_) {}
      if (err) {
        const msg = (stderr || err.message || '').trim();
        reject(new Error(msg || 'PostgreSQL command failed'));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 2_000_000) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}





async function handleMailSettingsApi(req, res, url) {
  if (url.pathname !== '/api/mail-settings') return false;
  try {
    const headerCode=getMainScope(req).headerCode;
    const scope=headerCode?` and payload->>'HeaderCode'=${dollar(headerCode)}`:'';
    if (req.method === 'GET') {
      const sql = `select coalesce((
        select jsonb_build_object(
          'ok', true,
          'configured', true,
          'email', payload->>'Email',
          'provider', case
            when lower(coalesce(payload->>'Email','')) like '%@gmail.com' then 'Gmail'
            when lower(coalesce(payload->>'Email','')) like '%@yahoo.%' then 'Yahoo'
            when lower(coalesce(payload->>'Email','')) ~ '@(outlook|hotmail|live)\.com$' then 'Outlook'
            else 'Auto'
          end,
          'active', coalesce(payload->>'Activ','da'),
          'passwordConfigured', (coalesce(payload->>'Secret SMTP', payload->>'Parolă', payload->>'Parola', '') <> ''),
          'encrypted', (coalesce(payload->>'Secret SMTP','') like 'enc:v1:%')
        )::text
        from ${dqIdent(PGSCHEMA)}.config_record
        where section_key='mail-settings'${scope}
        order by id desc
        limit 1
      ), jsonb_build_object('ok',true,'configured',false)::text);`;
      send(res, 200, await runPsql(sql) || '{"ok":true,"configured":false}', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'POST') {
      const b = await readJson(req);
      const email = String(b.email || b.Email || '').trim();
      const password = String(b.password || b['Parolă'] || '').trim();
      const active = b.active === false ? 'nu' : 'da';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { send(res, 400, 'Email expeditor invalid.'); return true; }
      let existing = {};
      try {
        const oldSql = `select coalesce((select payload::text from ${dqIdent(PGSCHEMA)}.config_record where section_key='mail-settings'${scope} order by id desc limit 1), '{}');`;
        existing = JSON.parse(await runPsql(oldSql) || '{}');
      } catch (_) {}
      const existingSecret = existing['Secret SMTP'] || existing['Parolă'] || existing.Parola || '';
      const protectedSecret = password ? encryptMailSecret(password) : existingSecret;
      if (!protectedSecret) { send(res, 400, 'Parola SMTP este obligatorie la prima configurare.'); return true; }
      if (!String(protectedSecret).startsWith('enc:v1:')) {
        if (!mailSecretKey()) { send(res, 400, 'Configurează MAIL_SECRET_KEY înainte de a salva parola SMTP.'); return true; }
      }
      const finalSecret = String(protectedSecret).startsWith('enc:v1:') ? protectedSecret : encryptMailSecret(protectedSecret);
      const payload = JSON.stringify({ Email: email, 'Secret SMTP': finalSecret, Activ: active, Provider: inferSmtp(email).provider, 'Setat din interfață': 'da', 'Protecție secret':'AES-256-GCM', ...(headerCode?{HeaderCode:headerCode}:{}) });
      const sql = `with old as (delete from ${dqIdent(PGSCHEMA)}.config_record where section_key='mail-settings'${scope})
        insert into ${dqIdent(PGSCHEMA)}.config_record(section_key,payload,sort_order)
        values ('mail-settings', ${dollar(payload)}::jsonb, 1)
        returning json_build_object('ok',true,'provider',payload->>'Provider','email',payload->>'Email')::text;`;
      send(res, 200, await runPsql(sql) || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'DELETE') {
      const sql = `delete from ${dqIdent(PGSCHEMA)}.config_record where section_key='mail-settings'${scope}; select json_build_object('ok',true)::text;`;
      const out = await runPsql(sql);
      send(res, 200, out.split('\n').pop() || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    send(res,405,'Method not allowed');
    return true;
  } catch(e) {
    send(res, 500, e.message || 'Mail settings error');
    return true;
  }
}

async function handleSeniorSoundSettingsApi(req, res, url) {
  if (url.pathname !== '/api/senior-sound-settings') return false;
  try {
    const headerCode=getMainScope(req).headerCode;const scope=headerCode?` and (payload->>'HeaderCode'=${dollar(headerCode)} or (coalesce(payload->>'HeaderCode','')='' and (select count(*) from ${dqIdent(PGSCHEMA)}.care_header where coalesce(active,true)=true)=1))`:'';
    if (req.method === 'GET') {
      const sql = `select coalesce((
        select jsonb_build_object(
          'type', case when lower(coalesce(payload->>'Tip sunet', payload->>'type', 'soft')) in ('soft','bell','alert') then lower(coalesce(payload->>'Tip sunet', payload->>'type', 'soft')) else 'soft' end,
          'volume', case when coalesce(payload->>'Volum', payload->>'volume', '') ~ '^[0-9]+$' then least(100, greatest(0, coalesce(payload->>'Volum', payload->>'volume')::int)) else 70 end,
          'active', coalesce(payload->>'Activ', payload->>'active', 'da')
        )::text
        from ${dqIdent(PGSCHEMA)}.config_record
        where section_key='senior-sound-settings'${scope}
        order by sort_order, id
        limit 1
      ), jsonb_build_object('type','soft','volume',70,'active','da')::text);`;
      send(res, 200, await runPsql(sql) || '{"type":"soft","volume":70,"active":"da"}', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'POST') {
      const b = await readJson(req);
      const type = ['soft','bell','alert'].includes(String(b.type || b['Tip sunet'] || '').toLowerCase()) ? String(b.type || b['Tip sunet']).toLowerCase() : 'soft';
      const volume = Math.max(0, Math.min(100, Number(b.volume ?? b.Volum ?? 70) || 70));
      const active = String(b.active ?? b.Activ ?? 'da');
      const payload = JSON.stringify({ 'Tip sunet': type, Volum: String(volume), Activ: active, ...(headerCode?{HeaderCode:headerCode}:{}) });
      const sql = `with old as (delete from ${dqIdent(PGSCHEMA)}.config_record where section_key='senior-sound-settings'${headerCode?` and payload->>'HeaderCode'=${dollar(headerCode)}`:''})
        insert into ${dqIdent(PGSCHEMA)}.config_record(section_key,payload,sort_order)
        values ('senior-sound-settings', ${dollar(payload)}::jsonb, 1)
        returning json_build_object('ok',true,'type',payload->>'Tip sunet','volume',payload->>'Volum')::text;`;
      send(res, 200, await runPsql(sql) || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    send(res, 405, 'Method not allowed');
    return true;
  } catch(e) {
    send(res, 500, e.message || 'Sound settings error');
    return true;
  }
}

async function handleFamilyContactApi(req, res, url) {
  if (url.pathname !== '/api/family-contact') return false;
  try {
    const headerCode=getMainScope(req).headerCode;const scope=headerCode?` and (payload->>'HeaderCode'=${dollar(headerCode)} or (coalesce(payload->>'HeaderCode','')='' and (select count(*) from ${dqIdent(PGSCHEMA)}.care_header where coalesce(active,true)=true)=1))`:'';
    const sql = `select coalesce((
      select jsonb_build_object(
        'Nume', coalesce(payload->>'Nume', 'Contact familie'),
        'Email', coalesce(payload->>'Email', 'contact@example.com'),
        'Mesaj SMS', coalesce(payload->>'Mesaj SMS', payload->>'Mesaj implicit', 'Te rog să mă contactezi.'),
        'Mesaj ajutor', coalesce(payload->>'Mesaj ajutor', payload->>'Mesaj implicit', 'Am nevoie de ajutor. Te rog să mă contactezi.'),
        'Contacte', jsonb_build_array(
          jsonb_build_object('Etichetă','Principal','Nume',coalesce(payload->>'Nume principal', payload->>'Nume', 'Contact principal'),'Telefon',coalesce(payload->>'Telefon principal', payload->>'Telefon', '0700000001')),
          jsonb_build_object('Etichetă','Secundar','Nume',coalesce(payload->>'Nume secundar','Contact secundar'),'Telefon',coalesce(payload->>'Telefon secundar','0700000002')),
          jsonb_build_object('Etichetă','Al treilea','Nume',coalesce(payload->>'Nume al treilea','Contact rezervă'),'Telefon',coalesce(payload->>'Telefon al treilea', payload->>'Telefon urgență', '0700000003'))
        )
      )::text
      from ${dqIdent(PGSCHEMA)}.config_record
      where section_key='family-contact'${scope}
      order by sort_order, id
      limit 1
    ), jsonb_build_object(
        'Nume','Contact familie',
        'Email','contact@example.com',
        'Mesaj SMS','Te rog să mă contactezi.',
        'Mesaj ajutor','Am nevoie de ajutor. Te rog să mă contactezi.',
        'Contacte', jsonb_build_array(
          jsonb_build_object('Etichetă','Principal','Nume','Contact principal','Telefon','0700000001'),
          jsonb_build_object('Etichetă','Secundar','Nume','Contact secundar','Telefon','0700000002'),
          jsonb_build_object('Etichetă','Al treilea','Nume','Contact rezervă','Telefon','0700000003')
        )
      )::text);`;
    const out = await runPsql(sql);
    send(res, 200, out || '{}', 'application/json; charset=utf-8');
    return true;
  } catch(e) {
    send(res, 200, JSON.stringify({
      Nume:'Contact familie', Email:'contact@example.com',
      'Mesaj SMS':'Te rog să mă contactezi.',
      'Mesaj ajutor':'Am nevoie de ajutor. Te rog să mă contactezi.',
      Contacte:[
        {'Etichetă':'Principal', Nume:'Contact principal', Telefon:'0700000001'},
        {'Etichetă':'Secundar', Nume:'Contact secundar', Telefon:'0700000002'},
        {'Etichetă':'Al treilea', Nume:'Contact rezervă', Telefon:'0700000003'}
      ]
    }), 'application/json; charset=utf-8');
    return true;
  }
}

async function handleQuickActionApi(req, res, url) {
  if (url.pathname !== '/api/quick-action') return false;
  if (req.method !== 'POST') { send(res,405,'Method not allowed'); return true; }
  try {
    const b = await readJson(req);
    const payload = JSON.stringify({
      Actiune: b.action || 'actiune',
      Entitate: b.entityName || '',
      Mesaj: b.message || '',
      Data: new Date().toISOString()
    });
    const sql = `insert into ${dqIdent(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('senior-actions', ${dollar(payload)}::jsonb, 100) returning json_build_object('ok',true,'id',id)::text;`;
    const out = await runPsql(sql);
    send(res, 200, out || '{"ok":true}', 'application/json; charset=utf-8');
    return true;
  } catch(e) {
    send(res, 500, e.message || 'Database error');
    return true;
  }
}

async function handleSeniorEntitiesApi(req, res, url) {
  if (url.pathname !== '/api/senior/entities' && url.pathname !== '/api/entities') return false;
  try {
    const branchCode = url.searchParams.get('branchCode') || '';
    const st = await enrichMainSessionFromDb(getMainSessionState(req) || {});
    const scope = { headerCode:String(st && st.headerCode || '').trim(), branchCode:String(st && st.branchCode || '').trim() };
    const branchFilter = branchCode ? ` and (coalesce(b.branch_code,'')=${dollar(branchCode)} or coalesce(to_jsonb(e)->>'branch_name','') in (select name from ${dqIdent(PGSCHEMA)}.care_branch where branch_code=${dollar(branchCode)}))` : '';
    const headerFilter = scope.headerCode ? ` and h.header_code=${dollar(scope.headerCode)}` : '';
    const filter = `where coalesce(e.active,true)=true${headerFilter}${branchFilter}`;
    const sql = `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
      select
        e.id,
        e.entity_code,
        coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code) as name,
        e.entity_type,
        coalesce(b.branch_code, to_jsonb(e)->>'branch_code') as branch_code,
        coalesce(b.name, to_jsonb(e)->>'branch_name') as branch_name,
        coalesce(to_jsonb(e)->>'address_details', e.address_notes, e.access_details, concat_ws(', ', to_jsonb(e)->>'country', to_jsonb(e)->>'city', to_jsonb(e)->>'street', to_jsonb(e)->>'street_no')) as address_details,
        coalesce(to_jsonb(e)->>'responsible_name', e.notes, '') as responsible_name,
        coalesce(to_jsonb(e)->>'allows_senior_screen','false') as allows_senior_screen,
        coalesce(card_style.card_color,'') as card_color,
        coalesce(card_style.card_text_color,'') as card_text_color
      from ${dqIdent(PGSCHEMA)}.managed_entity e
      left join ${dqIdent(PGSCHEMA)}.care_branch b on b.id=e.care_branch_id
      left join ${dqIdent(PGSCHEMA)}.care_header h on h.id=e.care_header_id
      left join lateral (
        select
          c.payload->>'Culoare fundal' as card_color,
          c.payload->>'Culoare text' as card_text_color
        from ${dqIdent(PGSCHEMA)}.config_record c
        where c.section_key='senior-card-colors'
          and coalesce(c.payload->>'Cod entitate','')=e.entity_code
        order by c.id desc
        limit 1
      ) card_style on true
      ${filter}
      order by b.sort_order nulls last, coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code)
    ) t;`;
    const out = await runPsql(sql);
    send(res, 200, out || '[]', 'application/json; charset=utf-8');
    return true;
  } catch(e) {
    send(res, 500, e.message || 'Database error');
    return true;
  }
}

async function handleTreatmentApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/treatment\/?([0-9]+)?$/);
  if (!m) return false;
  const itemId = m[1] ? Number(m[1]) : null;
  const table = dqIdent(PGSCHEMA) + '.calendar_series';
  const scopeHeader = getMainScope(req).headerCode;
  const treatmentScope = scopeHeader ? ` and coalesce(cs.care_header_id,e.care_header_id) in (select id from ${dqIdent(PGSCHEMA)}.care_header where header_code=${dollar(scopeHeader)})` : '';
  try {
    if (req.method === 'GET' && !itemId) {
      const sql = `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
        select
          cs.id, cs.section_key, cs.task_type, cs.title, cs.description,
          cs.start_date, cs.end_date, cs.start_time, cs.recurrence_rule,
          cs.repeat_every_days, cs.active_weekdays, cs.escalation_minutes,
          cs.email_on_create, cs.email_on_finish, cs.email_recipients,
          cs.status,
          e.entity_code,
          coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code) as entity_name,
          br.branch_code,
          br.name as branch_name
        from ${table} cs
        left join ${dqIdent(PGSCHEMA)}.managed_entity e on e.id=cs.entity_id
        left join ${dqIdent(PGSCHEMA)}.care_branch br on br.id=cs.care_branch_id
        where cs.section_key='treatment'
          and coalesce(cs.active,true)=true
          and lower(coalesce(cs.status,'active')) not in ('cancelled','canceled','anulat','anulată','anulata')
          ${treatmentScope}
        order by cs.start_time nulls last, cs.id desc
      ) t;`;
      const out = await runPsql(sql);
      send(res, 200, out || '[]', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'POST' && !itemId) {
      const b = await readJson(req);
      const title = b.treatmentName || 'Tratament';
      const desc = [b.treatmentType, b.dose, b.instructions, b.responsible].filter(Boolean).join(' · ');
      const startDate = b.startDate || new Date().toISOString().slice(0,10);
      const endDate = b.endDate || startDate;
      const startTime = b.startTime || '09:00';
      const recurrence = b.recurrenceRule || 'selected_weekdays';
      const repeatDays = Number(b.repeatEveryDays || 0) || null;
      const weekdays = b.activeWeekdays || '';
      const esc = Number(b.escalationMinutes || 30) || 30;
      const emailOnCreate = b.emailOnCreate ? 'true' : 'false';
      const emailOnFinish = b.emailOnFinish ? 'true' : 'false';
      const subscription = await getSubscriptionStatus(getMainScope(req).headerCode);
      const recipients = limitedRecipients(b.emailRecipients || '', subscription);
      const entityCodes = Array.isArray(b.entityCodes) && b.entityCodes.length ? b.entityCodes : [b.entityCode || 'ME-0001'];
      const entityList = entityCodes.map(x => dollar(x)).join(',');
      const sql = `
        with src as (
          select e.care_header_id as header_id, e.care_branch_id as branch_id, e.id as entity_id
          from ${dqIdent(PGSCHEMA)}.managed_entity e
          left join ${dqIdent(PGSCHEMA)}.care_header h on h.id=e.care_header_id
          where e.entity_code in (${entityList})${scopeHeader ? ` and h.header_code=${dollar(scopeHeader)}` : ''}
        ), ins as (
          insert into ${table}(care_header_id, care_branch_id, entity_id, section_key, task_type, title, description, start_date, end_date, start_time, recurrence_rule, repeat_every_days, active_weekdays, escalation_minutes, email_on_create, email_on_finish, email_recipients, status, active)
          select header_id, branch_id, entity_id, 'treatment', ${dollar(b.treatmentType || 'medication')}, ${dollar(title)}, ${dollar(desc)}, ${dollar(startDate)}::date, ${dollar(endDate)}::date, ${dollar(startTime)}::time, ${dollar(recurrence)}, ${repeatDays === null ? 'null' : repeatDays}, ${dollar(weekdays)}, ${esc}, ${emailOnCreate}, ${emailOnFinish}, ${dollar(recipients)}, 'active', true
          from src
          returning id
        ), mailq as (
          insert into ${dqIdent(PGSCHEMA)}.config_record(section_key,payload,sort_order)
          select 'email-outbox', jsonb_build_object(
            'Status','pregătit',
            'Tip','Tratament creat',
            'Către',${dollar(recipients)},
            'Subiect',${dollar('FamilyCare - tratament nou: ' + title)},
            'Mesaj',${dollar('A fost creat un tratament nou în FamilyCare. Tratament: ' + title + '. Ora: ' + startTime + '.')},
            'Tratament',${dollar(title)},
            'Ora',${dollar(startTime)},
            'Creat la',now()::text
          ), 10
          where ${emailOnCreate} and length(trim(${dollar(recipients)})) > 0 and exists(select 1 from ins)
          returning id
        ), cnt as (select count(*)::int as inserted from ins), mcnt as (select count(*)::int as email_queued from mailq)
        select case when (select inserted from cnt) > 0 then
          json_build_object('ok',true,'inserted',(select inserted from cnt),'email_queued',(select email_queued from mcnt),'entity_codes',${dollar(entityCodes.join(','))},'entity_label',${dollar(b.entityLabel || '')})::text
        else
          json_build_object('ok',false,'error','Nu am găsit persoana/entitatea selectată în baza de date.')::text
        end;`;
      const out = await runPsql(sql);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (_) {}
      if (!out || (parsed && parsed.ok === false)) {
        send(res, 400, parsed && parsed.error ? parsed.error : (out || 'Tratamentul nu a fost inserat.'));
        return true;
      }
      if (parsed && parsed.ok && b.emailOnCreate && recipients) {
        const subject = 'FamilyCare - tratament nou: ' + title;
        const msg = [
          'A fost creat un tratament nou în FamilyCare.',
          '',
          'Seniori / persoane: ' + (b.entityLabel || entityCodes.join(', ')),
          'Tratament: ' + title,
          'Ora: ' + startTime,
          'Începe la: ' + startDate,
          'Până la: ' + endDate
        ].join('\n');
        const mailRes = await sendAndLog('Tratament creat', recipients, subject, msg, scopeHeader);
        parsed.email_sent = !!mailRes.ok;
        parsed.email_status = mailRes.ok ? 'trimis' : (mailRes.reason || mailRes.error || 'neexpediat');
        send(res, 200, JSON.stringify(parsed), 'application/json; charset=utf-8');
        return true;
      }
      send(res, 200, out, 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'PUT' && itemId) {
      const b = await readJson(req);
      const title = b.treatmentName || b.title || 'Tratament';
      const desc = [b.treatmentType, b.dose, b.instructions, b.responsible].filter(Boolean).join(' · ');
      const startDate = b.startDate || new Date().toISOString().slice(0,10);
      const endDate = b.endDate || startDate;
      const startTime = b.startTime || '09:00';
      const recurrence = b.recurrenceRule || 'selected_weekdays';
      const repeatDays = Number(b.repeatEveryDays || 0) || null;
      const weekdays = b.activeWeekdays || '';
      const esc = Number(b.escalationMinutes || 30) || 30;
      const emailOnCreate = b.emailOnCreate ? 'true' : 'false';
      const emailOnFinish = b.emailOnFinish ? 'true' : 'false';
      const subscription = await getSubscriptionStatus(getMainScope(req).headerCode);
      const recipients = limitedRecipients(b.emailRecipients || '', subscription);
      const entityCode = (Array.isArray(b.entityCodes) && b.entityCodes[0]) || b.entityCode || '';
      const entityUpdate = entityCode ? `, care_header_id = e.care_header_id, care_branch_id = e.care_branch_id, entity_id = e.id` : '';
      const scopeGuard = scopeHeader ? ` and coalesce(cs.care_header_id,e.care_header_id) in (select id from ${dqIdent(PGSCHEMA)}.care_header where header_code=${dollar(scopeHeader)})` : '';
      const fromJoin = entityCode ? ` from ${dqIdent(PGSCHEMA)}.managed_entity e where cs.id=${itemId} and e.entity_code=${dollar(entityCode)}${scopeGuard} ` : ` from ${dqIdent(PGSCHEMA)}.managed_entity e where cs.id=${itemId} and e.id=cs.entity_id${scopeGuard} `;
      const sql = `
        update ${table} cs set
          task_type=${dollar(b.treatmentType || 'medication')},
          title=${dollar(title)},
          description=${dollar(desc)},
          start_date=${dollar(startDate)}::date,
          end_date=${dollar(endDate)}::date,
          start_time=${dollar(startTime)}::time,
          recurrence_rule=${dollar(recurrence)},
          repeat_every_days=${repeatDays === null ? 'null' : repeatDays},
          active_weekdays=${dollar(weekdays)},
          escalation_minutes=${esc},
          email_on_create=${emailOnCreate},
          email_on_finish=${emailOnFinish},
          email_recipients=${dollar(recipients)},
          updated_at=now()
          ${entityUpdate}
        ${fromJoin}
        returning json_build_object('ok',true,'id',cs.id)::text;`;
      const out = await runPsql(sql);
      if (!out) { send(res, 404, 'Tratamentul nu a fost găsit.'); return true; }
      send(res, 200, out, 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'DELETE' && itemId) {
      const sql = `update ${table} cs set active=false, status='cancelled', updated_at=now() where id=${itemId}${scopeHeader ? ` and coalesce(cs.care_header_id,(select care_header_id from ${dqIdent(PGSCHEMA)}.managed_entity where id=cs.entity_id)) in (select id from ${dqIdent(PGSCHEMA)}.care_header where header_code=${dollar(scopeHeader)})` : ''}; select json_build_object('ok',true,'id',${itemId})::text;`;
      const out = await runPsql(sql);
      send(res, 200, out.split('\n').pop() || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    send(res, 405, 'Method not allowed');
    return true;
  } catch(e) {
    send(res, 500, e.message || 'Database error');
    return true;
  }
}


async function handleTreatmentConfirmApi(req, res, url) {
  if (url.pathname !== '/api/treatment/confirm') return false;
  if (req.method !== 'POST') { send(res, 405, 'Method not allowed'); return true; }
  try {
    const b = await readJson(req);
    const treatmentId = Number(b.treatmentId || b.id || 0);
    const title = b.title || 'Tratament';
    const entityName = b.entityName || '';
    const startTime = b.startTime || '';
    const occurrenceKey = b.occurrenceKey || '';
    const payload = JSON.stringify({
      Tip:'confirmare-tratament', Tratament:title, Senior:entityName, Ora:startTime,
      OccurrenceKey:occurrenceKey, ConfirmatLa:new Date().toISOString()
    });
    let cfg = null;
    if (treatmentId) {
      const q = `select coalesce((select jsonb_build_object('email_on_finish',email_on_finish,'email_recipients',email_recipients,'title',title,'start_time',start_time::text)::text from ${dqIdent(PGSCHEMA)}.calendar_series where id=${treatmentId}), '{}');`;
      try { cfg = JSON.parse(await runPsql(q) || '{}'); } catch(_) { cfg = {}; }
    }
    await runPsql(`insert into ${dqIdent(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('treatment-confirmations', ${dollar(payload)}::jsonb, 10);`);
    let mailRes = { ok:false, skipped:true };
    const recipients = (cfg && cfg.email_recipients) || b.emailRecipients || '';
    const shouldSend = (cfg && cfg.email_on_finish) || b.emailOnFinish;
    if (shouldSend && recipients) {
      const subject = 'FamilyCare - tratament confirmat: ' + (cfg.title || title);
      const msg = [
        'Tratamentul a fost confirmat.', '',
        'Senior / persoană: ' + entityName,
        'Tratament: ' + (cfg.title || title),
        'Ora planificată: ' + (startTime || cfg.start_time || ''),
        'Confirmat la: ' + new Date().toLocaleString('ro-RO')
      ].join('\n');
      mailRes = await sendAndLog('Tratament confirmat', recipients, subject, msg, getMainScope(req).headerCode);
    }
    send(res, 200, JSON.stringify({ ok:true, email_sent:!!mailRes.ok, email_status: mailRes.ok ? 'trimis' : (mailRes.reason || mailRes.error || 'neexpediat') }), 'application/json; charset=utf-8');
    return true;
  } catch(e) {
    send(res, 500, e.message || 'Database error');
    return true;
  }
}

async function handleAgendaApi(req, res, url) {
  if (url.pathname !== '/api/agenda') return false;
  const table = dqIdent(PGSCHEMA) + '.calendar_series';
  const scopeHeader = getMainScope(req).headerCode;
  try {
    if (req.method === 'GET') {
      const sql = `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
        select cs.id, cs.section_key, cs.task_type, cs.title, cs.description,
          cs.start_date, cs.end_date, cs.start_time, cs.recurrence_rule,
          cs.repeat_every_days, cs.active_weekdays, cs.escalation_minutes,
          cs.status,
          e.entity_code,
          coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code) as entity_name,
          br.branch_code, br.name as branch_name
        from ${table} cs
        left join ${dqIdent(PGSCHEMA)}.managed_entity e on e.id=cs.entity_id
        left join ${dqIdent(PGSCHEMA)}.care_branch br on br.id=cs.care_branch_id
        where cs.section_key='agenda'
          ${scopeHeader ? `and coalesce(cs.care_header_id,e.care_header_id) in (select id from ${dqIdent(PGSCHEMA)}.care_header where header_code=${dollar(scopeHeader)})` : ''}
        order by cs.start_time nulls last, cs.id desc
      ) t;`;
      const out = await runPsql(sql);
      send(res, 200, out || '[]', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'POST') {
      const b = await readJson(req);
      const title = b.title || 'Activitate';
      const desc = b.description || '';
      const startDate = b.startDate || new Date().toISOString().slice(0,10);
      const endDate = b.endDate || startDate;
      const startTime = b.startTime || '09:00';
      const recurrence = b.recurrenceRule || 'selected_weekdays';
      const repeatDays = Number(b.repeatEveryDays || 0) || 1;
      const weekdays = b.activeWeekdays || '';
      const entityCodes = Array.isArray(b.entityCodes) && b.entityCodes.length ? b.entityCodes : [b.entityCode || 'ME-0001'];
      const entityList = entityCodes.map(x => dollar(x)).join(',');
      const sql = `
        with src as (
          select e.care_header_id as header_id, e.care_branch_id as branch_id, e.id as entity_id
          from ${dqIdent(PGSCHEMA)}.managed_entity e
          left join ${dqIdent(PGSCHEMA)}.care_header h on h.id=e.care_header_id
          where e.entity_code in (${entityList})${scopeHeader ? ` and h.header_code=${dollar(scopeHeader)}` : ''}
        ), ins as (
          insert into ${table}(care_header_id, care_branch_id, entity_id, section_key, task_type, title, description, start_date, end_date, start_time, recurrence_rule, repeat_every_days, active_weekdays, escalation_minutes)
          select header_id, branch_id, entity_id, 'agenda', 'agenda', ${dollar(title)}, ${dollar(desc)}, ${dollar(startDate)}::date, ${dollar(endDate)}::date, ${dollar(startTime)}::time, ${dollar(recurrence)}, ${repeatDays}, ${dollar(weekdays)}, 30
          from src
          returning id
        ), cnt as (select count(*)::int as inserted from ins)
        select case when (select inserted from cnt) > 0 then json_build_object('ok',true,'inserted',(select inserted from cnt))::text
        else json_build_object('ok',false,'error','Nu am găsit seniorii selectați în baza de date.')::text end;`;
      const out = await runPsql(sql);
      let parsed=null; try{parsed=JSON.parse(out)}catch(_){}
      if (!out || (parsed && parsed.ok === false)) { send(res, 400, parsed && parsed.error ? parsed.error : 'Activitatea nu a fost inserată.'); return true; }
      send(res, 200, out, 'application/json; charset=utf-8');
      return true;
    }
    send(res, 405, 'Method not allowed'); return true;
  } catch(e) { send(res, 500, e.message || 'Database error'); return true; }
}



async function handleSeniorCardColorsConfigApi(req, res, section, id, session = {}) {
  if (section !== 'senior-card-colors') return false;
  const table = dqIdent(PGSCHEMA) + '.config_record';
  const scopeHeader = String(session.headerCode || '').trim();
  try {
    if (req.method === 'GET' && !id) {
      const q = dqIdent(PGSCHEMA);
      const sql = `with seniors as (
          select e.entity_code, coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code) as display_name,
                 row_number() over(order by coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code), e.id) as rn
          from ${q}.managed_entity e
          left join ${q}.care_header h on h.id=e.care_header_id
          where coalesce(e.active,true)=true${scopeHeader ? ` and h.header_code=${dollar(scopeHeader)}` : ''}
        ), ranked as (
          select c.id, c.payload, row_number() over(partition by coalesce(c.payload->>'Cod entitate','') order by c.id desc) as rn
          from ${table} c
          where c.section_key='senior-card-colors'
        ), del_dupes as (
          delete from ${table} c using ranked r where c.id=r.id and r.rn>1 returning c.id
        ), ins_missing as (
          insert into ${table}(section_key,payload,sort_order)
          select 'senior-card-colors', jsonb_build_object('Cod entitate',s.entity_code,'Culoare fundal',case when mod(s.rn,6)=1 then '#2563EB' when mod(s.rn,6)=2 then '#0F766E' when mod(s.rn,6)=3 then '#7C3AED' when mod(s.rn,6)=4 then '#C2410C' when mod(s.rn,6)=5 then '#BE123C' else '#0369A1' end,'Culoare text','#FFFFFF'), 100 + s.rn
          from seniors s
          where not exists (select 1 from ${table} c where c.section_key='senior-card-colors' and coalesce(c.payload->>'Cod entitate','')=s.entity_code)
          returning id
        )
        select coalesce(json_agg(row_to_json(t))::text,'[]') from (
          select c.id, c.section_key, c.payload, c.sort_order
          from seniors s
          join ${table} c on c.section_key='senior-card-colors' and coalesce(c.payload->>'Cod entitate','')=s.entity_code
          order by s.rn
        ) t;`;
      const out = await runPsql(sql);
      send(res, 200, out || '[]', 'application/json; charset=utf-8');
      return true;
    }
    if ((req.method === 'POST' && !id) || (req.method === 'PUT' && idOk(id))) {
      const body = await readJson(req);
      const code = String(body['Cod entitate'] || '').trim();
      if (!code) { send(res, 400, 'Alege beneficiarul.'); return true; }
      if (scopeHeader) {
        const allowed = Number(await runPsql(`select count(*) from ${dqIdent(PGSCHEMA)}.managed_entity e join ${dqIdent(PGSCHEMA)}.care_header h on h.id=e.care_header_id where e.entity_code=${dollar(code)} and h.header_code=${dollar(scopeHeader)} and coalesce(e.active,true)=true;`) || 0);
        if (allowed !== 1) { send(res, 403, 'Beneficiarul nu aparține organizației autentificate.'); return true; }
      }
      const payload = JSON.stringify({
        'Cod entitate': code,
        'Culoare fundal': body['Culoare fundal'] || '#2563EB',
        'Culoare text': body['Culoare text'] || '#FFFFFF'
      });
      let sql;
      if (req.method === 'PUT' && idOk(id)) {
        sql = `with upd as (
            update ${table} set payload=${dollar(payload)}::jsonb, updated_at=now()
            where id=${Number(id)} and section_key='senior-card-colors'
            returning id, payload
          ), cleanup as (
            delete from ${table} c using upd u
            where c.section_key='senior-card-colors' and c.id<>u.id and coalesce(c.payload->>'Cod entitate','')=coalesce(u.payload->>'Cod entitate','')
            returning c.id
          ) select json_build_object('ok',true,'id',(select id from upd))::text;`;
      } else {
        sql = `with old as (delete from ${table} where section_key='senior-card-colors' and coalesce(payload->>'Cod entitate','')=${dollar(code)})
          insert into ${table}(section_key,payload,sort_order) values ('senior-card-colors', ${dollar(payload)}::jsonb, 100)
          returning json_build_object('ok',true,'id',id)::text;`;
      }
      const out = await runPsql(sql);
      send(res, 200, out || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'DELETE' && idOk(id)) {
      const sql = scopeHeader
        ? `delete from ${table} c where c.id=${Number(id)} and c.section_key='senior-card-colors' and exists(select 1 from ${dqIdent(PGSCHEMA)}.managed_entity e join ${dqIdent(PGSCHEMA)}.care_header h on h.id=e.care_header_id where e.entity_code=coalesce(c.payload->>'Cod entitate','') and h.header_code=${dollar(scopeHeader)}); select json_build_object('ok',true)::text;`
        : `delete from ${table} where id=${Number(id)} and section_key='senior-card-colors'; select json_build_object('ok',true)::text;`;
      const out = await runPsql(sql);
      send(res, 200, String(out||'').split('\n').pop() || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    send(res, 405, 'Method not allowed'); return true;
  } catch (e) { send(res, 500, e.message || 'Database error'); return true; }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api config section id
  if (parts[0] !== 'api' || parts[1] !== 'config') return false;
  const section = parts[2];
  const id = parts[3];
  if (!sectionOk(section)) { send(res, 400, 'Invalid section'); return true; }
  let session = getMainSessionState(req) || {};
  session = await enrichMainSessionFromDb(session);
  const headerCode = String(session.headerCode || '').trim();
  const scopedConfigFilter = headerCode ? ` and (payload->>'HeaderCode'=${dollar(headerCode)} or (coalesce(payload->>'HeaderCode','')='' and (select count(*) from ${dqIdent(PGSCHEMA)}.care_header where coalesce(active,true)=true)=1))` : '';
  const strictConfigFilter = headerCode ? ` and payload->>'HeaderCode'=${dollar(headerCode)}` : '';
  const addScope = body => headerCode ? { ...body, HeaderCode:headerCode } : body;
  if (section === 'senior-display-settings') {
    const table = dqIdent(PGSCHEMA) + '.config_record';
    try {
      if (req.method === 'GET' && !id) {
        const sql = `select coalesce(json_agg(row_to_json(t))::text,'[]') from (
            select id, section_key, payload, sort_order from ${table} where section_key='senior-display-settings'${scopedConfigFilter} order by updated_at desc nulls last, id desc limit 1
          ) t;`;
        send(res, 200, await runPsql(sql) || '[]', 'application/json; charset=utf-8'); return true;
      }
      if ((req.method === 'POST' && !id) || (req.method === 'PUT' && idOk(id))) {
        const body = await readJson(req);
        let n = Number(body['Număr carduri vizibile'] ?? body.maxVisible ?? body.visibleCards ?? 0);
        if (!Number.isFinite(n)) n = 0;
        n = Math.max(0, Math.min(100, Math.floor(n)));
        const payload = JSON.stringify(addScope({ 'Număr carduri vizibile': String(n) }));
        const sql = `with old as (delete from ${table} where section_key='senior-display-settings'${strictConfigFilter})
          insert into ${table}(section_key,payload,sort_order) values ('senior-display-settings', ${dollar(payload)}::jsonb, 1)
          returning json_build_object('ok',true,'id',id,'maxVisible',payload->>'Număr carduri vizibile')::text;`;
        send(res, 200, await runPsql(sql) || '{"ok":true}', 'application/json; charset=utf-8'); return true;
      }
      if (req.method === 'DELETE' && idOk(id)) {
        send(res, 200, await runPsql(`delete from ${table} where section_key='senior-display-settings'${strictConfigFilter}; select json_build_object('ok',true)::text;`) || '{"ok":true}', 'application/json; charset=utf-8'); return true;
      }
      send(res, 405, 'Method not allowed'); return true;
    } catch (e) { send(res, 500, e.message || 'Database error'); return true; }
  }
  if (section === 'mail-settings') { send(res, 403, 'Folosește endpointul securizat /api/mail-settings.'); return true; }
  if (await handleSeniorCardColorsConfigApi(req, res, section, id, session)) return true;
  if (await handleDirectConfigApi(req, res, section, id, session)) return true;
  const table = dqIdent(PGSCHEMA) + '.config_record';
  try {
    if (req.method === 'GET' && !id) {
      const sql = `select coalesce(json_agg(row_to_json(t))::text,'[]') from (select id, section_key, payload, sort_order from ${table} where section_key=${dollar(section)}${scopedConfigFilter} order by sort_order, id) t;`;
      const out = await runPsql(sql);
      send(res, 200, out || '[]', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'POST' && !id) {
      const body = addScope(await readJson(req));
      const sql = `insert into ${table}(section_key,payload,sort_order) values (${dollar(section)}, ${dollar(JSON.stringify(body))}::jsonb, 100) returning json_build_object('ok',true,'id',id)::text;`;
      const out = await runPsql(sql);
      send(res, 200, out || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'PUT' && idOk(id)) {
      const body = addScope(await readJson(req));
      const sql = `update ${table} set payload=${dollar(JSON.stringify(body))}::jsonb, updated_at=now() where id=${Number(id)} and section_key=${dollar(section)}${scopedConfigFilter} returning json_build_object('ok',true,'id',id)::text;`;
      const out = await runPsql(sql);
      send(res, 200, out || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    if (req.method === 'DELETE' && idOk(id)) {
      const sql = `delete from ${table} where id=${Number(id)} and section_key=${dollar(section)}${scopedConfigFilter}; select json_build_object('ok',true)::text;`;
      const out = await runPsql(sql);
      send(res, 200, out.split('\n').pop() || '{"ok":true}', 'application/json; charset=utf-8');
      return true;
    }
    send(res, 405, 'Method not allowed');
    return true;
  } catch (e) {
    send(res, 500, e.message || 'Database error');
    return true;
  }
}

const requestHandler = async (req, res) => {
  res.familyCareSeniorFrameSources = seniorFrameSourcesFor(req);
  res.familyCareSecureRequest = requestIsSecure(req);
  const url = new URL(req.url, 'http://127.0.0.1');
  if (await handleMainAuthApi(req, res, url)) return;
  if (url.pathname === '/api/runtime-config') {
    let st = getMainSessionState(req);
    st = await enrichMainSessionFromDb(st);
    send(res, 200, JSON.stringify({ ok:true, version:'3.0.0', seniorBaseUrl:SENIOR_BASE_URL, authRequired:AUTH_REQUIRED, registrationAllowed:ALLOW_PUBLIC_REGISTRATION, authenticated:!!st, userName:st&&st.userName||ADMIN_NAME, headerCode:st&&st.headerCode||'', headerName:st&&st.headerName||'', orgType:st&&st.orgType||'', role:st&&st.role||'' }), 'application/json; charset=utf-8');
    return;
  }
  if (url.pathname.startsWith('/api/') && !authorizedMain(req)) {
    send(res, 401, JSON.stringify({ ok:false, error:'Autentificare necesară.' }), 'application/json; charset=utf-8');
    return;
  }
  if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originAllowed(req)) {
    send(res, 403, 'Origin not allowed');
    return;
  }
  if (await handleMailSettingsApi(req, res, url)) return;
  if (await handleSubscriptionApi(req, res, url)) return;
  if (await handleSeniorSoundSettingsApi(req, res, url)) return;
  if (await handleFamilyContactApi(req, res, url)) return;
  if (await handleTreatmentConfirmApi(req, res, url)) return;
  if (await handleQuickActionApi(req, res, url)) return;
  if (await handleSeniorEntitiesApi(req, res, url)) return;
  if (await handleTreatmentApi(req, res, url)) return;
  if (await handleAgendaApi(req, res, url)) return;
  if (await handleApi(req, res, url)) return;
  let pathname = decodeURIComponent(url.pathname);
  // Render/public root fix: redirect root to the real page path so relative links
  // like journal.html and config.html resolve as /pages/journal.html and /pages/config.html.
  if (pathname === '/') {
    send(res, 302, '', 'text/plain; charset=utf-8', {
      'Location': authorizedMain(req) ? '/pages/dashboard.html' : '/pages/main-login.html',
      'Cache-Control': 'no-store'
    });
    return;
  }
  if (/\.(md|sql|txt|log|env|ya?ml)$/i.test(pathname) || pathname.includes('/tests/')) { send(res, 404, 'Not found'); return; }
  const publicStatic = pathname === '/pages/main-login.html' || pathname === '/offline.html' || pathname === '/manifest.webmanifest' || pathname === '/service-worker.js' || pathname === '/app-universal.js' || pathname.startsWith('/assets/') || pathname.startsWith('/styles/');
  if (AUTH_REQUIRED && !authorizedMain(req) && !publicStatic) {
    send(res, 302, '', 'text/plain; charset=utf-8', { 'Location':'/pages/main-login.html', 'Cache-Control':'no-store' });
    return;
  }
  const file = path.resolve(ROOT, pathname.replace(/^[/\\]+/, ''));
  const relative = path.relative(ROOT, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) { send(res, 403, 'Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, 'Not found'); return; }
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
};

let server;
if (HTTPS_ENABLED) {
  if (!fs.existsSync(TLS_PFX_PATH)) {
    console.error('ERROR: HTTPS este activ, dar certificatul lipsește: ' + TLS_PFX_PATH);
    process.exit(1);
  }
  server = https.createServer({ pfx: fs.readFileSync(TLS_PFX_PATH), passphrase: TLS_PFX_PASSPHRASE }, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') console.error('ERROR: Portul ' + PORT + ' este deja folosit. Oprește instanța existentă sau schimbă PORT.');
  else console.error('ERROR server:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
const PID_FILE = path.join(ROOT, '.familycare-main.pid');
try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (_) {}
function removePidFile(){try{if(fs.existsSync(PID_FILE)&&fs.readFileSync(PID_FILE,'utf8').trim()===String(process.pid))fs.unlinkSync(PID_FILE)}catch(_){}}
process.on('exit', removePidFile);
function shutdown(){server.close(() => process.exit(0));if(typeof server.closeAllConnections==='function')server.closeAllConnections();setTimeout(() => process.exit(0),1500).unref();}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log('============================================================');
  console.log('FamilyCare Main V1.0.94 is running');
  console.log('URL: ' + PROTOCOL + '://localhost:' + PORT + (AUTH_REQUIRED ? '/pages/main-login.html' : '/pages/dashboard.html'));
  console.log('Main authentication: ' + (AUTH_REQUIRED ? 'required' : 'disabled for testing'));
  console.log('Database: ' + (process.env.PGDATABASE || '(from PostgreSQL defaults)') + ' / schema ' + PGSCHEMA);
  console.log('DB mode: ' + (process.env.DATABASE_URL ? 'DATABASE_URL / pg' : 'local psql'));
  if (SENIOR_BASE_URL) console.log('Senior URL: ' + SENIOR_BASE_URL);
  console.log('Press CTRL+C in this window to stop the server.');
  console.log('============================================================');
});
