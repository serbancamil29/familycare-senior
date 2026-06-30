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
async function mailCfg() {
  let dbCfg = null;
  try {
    const sql = `select coalesce((
      select payload::text
      from ${dqIdent(PGSCHEMA)}.config_record
      where section_key='mail-settings'
      order by id desc
      limit 1
    ), '{}');`;
    dbCfg = JSON.parse(await runPsql(sql) || '{}');
  } catch (_) { dbCfg = null; }

  const uiEmail = dbCfg && (dbCfg.Email || dbCfg['Email expeditor'] || dbCfg.Username || dbCfg.User || dbCfg['Adresă email']);
  const uiPass = dbCfg && (dbCfg['Parolă'] || dbCfg.Parola || dbCfg.Password || dbCfg['Parolă aplicație'] || dbCfg['App password']);
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
async function sendMailSMTP({to, subject, text}) {
  const cfg = await mailCfg();
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
async function logEmailStatus(kind, recipients, subject, message, status, detail) {
  try {
    const payload = JSON.stringify({ Tip:kind, Către:recipients, Subiect:subject, Mesaj:message, Status:status, Detalii:detail || '', Data:new Date().toISOString() });
    await runPsql(`insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('email-outbox', ${dollar(payload)}::jsonb, 10);`);
  } catch(_) {}
}
async function sendAndLog(kind, recipients, subject, message) {
  if (!normalizeEmailList(recipients).length) return { ok:false, skipped:true, reason:'Fără destinatari' };
  try {
    const result = await sendMailSMTP({ to:recipients, subject, text:message });
    await logEmailStatus(kind, recipients, subject, message, result.ok ? 'trimis' : 'neexpediat', result.reason || '');
    return result;
  } catch (e) {
    await logEmailStatus(kind, recipients, subject, message, 'eșuat', e.message || String(e));
    return { ok:false, error:e.message || String(e) };
  }
}


const PORT = Number(process.env.PORT || 31001);
const HOST = process.env.HOST || ((process.env.RENDER || process.env.NODE_ENV === 'production') ? '0.0.0.0' : '127.0.0.1');
const ROOT = __dirname;
const PGSCHEMA = process.env.PGSCHEMA || 'familycare';
const PSQL_BIN = process.env.PSQL_BIN || 'psql';
const HTTPS_ENABLED = String(process.env.HTTPS || '').toLowerCase() === 'true';
const TLS_PFX_PATH = process.env.TLS_PFX_PATH || path.join(ROOT, 'certs', 'familycare-local.pfx');
const TLS_PFX_PASSPHRASE = process.env.TLS_PFX_PASSPHRASE || 'familycare-local';
const PROTOCOL = HTTPS_ENABLED ? 'https' : 'http';
const SENIOR_PIN = String(process.env.SENIOR_PIN || '');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const seniorSessions = new Map();
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml; charset=utf-8','.png':'image/png','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const MAIN_PORT = Number(process.env.MAIN_PORT || 31000);
const MAIN_BASE_URL = String(process.env.MAIN_BASE_URL || '').replace(/\/$/, '');
function safeOrigin(value){try{return new URL(value).origin}catch(_){return ''}}
function frameAncestorsFor(req){
  const configured=safeOrigin(MAIN_BASE_URL);
  let local="'self'";
  try{
    const hostname=new URL(PROTOCOL+'://'+String(req.headers.host||'localhost')).hostname;
    if(/^[a-z0-9.:-]+$/i.test(hostname)){const host=hostname.includes(':')?'['+hostname+']':hostname;local+=" http://"+host+":"+MAIN_PORT+" https://"+host+":"+MAIN_PORT}
  }catch(_){}
  return local+(configured?' '+configured:'');
}
function send(res,status,body,type='text/plain; charset=utf-8'){res.writeHead(status,{
  'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors "+(res.familyCareFrameAncestors||"'self'")+"; base-uri 'self'; form-action 'self'",
  ...(HTTPS_ENABLED ? {'Strict-Transport-Security':'max-age=31536000'} : {})
});res.end(body)}
function dq(s){return '"'+String(s).replace(/"/g,'""')+'"'}
function dollar(text){let tag='fc';while(String(text).includes('$'+tag+'$')) tag+='x';return '$'+tag+'$'+String(text)+'$'+tag+'$'}
function runPsql(sql){return new Promise((resolve,reject)=>{const file=path.join(os.tmpdir(),'familycare_senior_'+Date.now()+'_'+Math.random().toString(16).slice(2)+'.sql');fs.writeFileSync(file,sql,'utf8');const args=['-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-f',file];execFile(PSQL_BIN,args,{env:{...process.env},windowsHide:true,timeout:15000},(err,stdout,stderr)=>{try{fs.unlinkSync(file)}catch(_){} if(err){reject(new Error(String(stderr||err.message||'PostgreSQL command failed').trim()));return} resolve(String(stdout||'').trim())})})}

async function readJson(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>2000000)reject(new Error('Body too large'))});req.on('end',()=>{try{resolve(data?JSON.parse(data):{})}catch(e){reject(new Error('Invalid JSON body'))}});req.on('error',reject)})}
function sameSecret(a,b){const aa=Buffer.from(String(a));const bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)}
function originAllowed(req){const origin=req.headers.origin;if(!origin)return true;try{const u=new URL(origin);const forwardedProto=String(req.headers['x-forwarded-proto']||PROTOCOL).split(',')[0].trim();return u.protocol===forwardedProto+':'&&u.host.toLowerCase()===String(req.headers.host||'').toLowerCase()}catch(_){return false}}
function authorizedSenior(req){const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const expires=seniorSessions.get(token);if(!expires||expires<Date.now()){if(token)seniorSessions.delete(token);return false}return true}
async function handleSeniorLoginApi(req,res,url){
  if(url.pathname!=='/api/senior/login')return false;
  if(req.method!=='POST'){send(res,405,'Method not allowed');return true}
  try{const b=await readJson(req);if(!sameSecret(b.pin||'',SENIOR_PIN)){send(res,401,JSON.stringify({ok:false,error:'PIN incorect'}),'application/json; charset=utf-8');return true}const token=crypto.randomBytes(32).toString('base64url');seniorSessions.set(token,Date.now()+SESSION_TTL_MS);send(res,200,JSON.stringify({ok:true,token,expiresIn:SESSION_TTL_MS}),'application/json; charset=utf-8');return true}catch(e){send(res,400,e.message||'Cerere invalidă');return true}
}
async function handleSeniorSoundSettingsApi(req, res, url) {
  if (url.pathname !== '/api/senior-sound-settings') return false;
  try {
    if (req.method !== 'GET') { send(res, 405, 'Method not allowed'); return true; }
    const sql = `select coalesce((
      select jsonb_build_object(
        'type', case when lower(coalesce(payload->>'Tip sunet', payload->>'type', 'soft')) in ('soft','bell','alert') then lower(coalesce(payload->>'Tip sunet', payload->>'type', 'soft')) else 'soft' end,
        'volume', case when coalesce(payload->>'Volum', payload->>'volume', '') ~ '^[0-9]+$' then least(100, greatest(0, coalesce(payload->>'Volum', payload->>'volume')::int)) else 70 end,
        'active', coalesce(payload->>'Activ', payload->>'active', 'da')
      )::text
      from ${dq(PGSCHEMA)}.config_record
      where section_key='senior-sound-settings'
      order by sort_order, id
      limit 1
    ), jsonb_build_object('type','soft','volume',70,'active','da')::text);`;
    send(res, 200, await runPsql(sql) || '{"type":"soft","volume":70,"active":"da"}', 'application/json; charset=utf-8');
    return true;
  } catch(e) {
    send(res, 200, JSON.stringify({type:'soft',volume:70,active:'da'}), 'application/json; charset=utf-8');
    return true;
  }
}

async function handleFamilyContactApi(req,res,url) {
  if (url.pathname !== '/api/family-contact') return false;
  try {
    const sql = `with contact_source as (
      select payload, updated_at, id, section_key
      from ${dq(PGSCHEMA)}.config_record
      where section_key='family-contact'
         or (section_key='notification-channels' and lower(coalesce(payload->>'Canal','')) in ('telefon / sms','telefon','sms'))
         or payload ? 'Telefon principal'
         or payload ? 'Numar principal'
         or payload ? 'Număr principal'
         or payload ? 'Telefon implicit'
         or payload ? 'phone_primary'
      order by
        case when payload ? 'Telefon principal' or payload ? 'Numar principal' or payload ? 'Număr principal' or payload ? 'Telefon implicit' or payload ? 'phone_primary' then 0 else 1 end,
        updated_at desc nulls last,
        id desc
      limit 1
    ), p as (
      select coalesce((select payload from contact_source), '{}'::jsonb) as payload
    )
    select jsonb_build_object(
      'Nume', coalesce(payload->>'Nume', payload->>'Contact', 'Contact familie'),
      'Email', coalesce(payload->>'Email', payload->>'Email principal', 'contact@example.com'),
      'Mesaj SMS', coalesce(payload->>'Mesaj SMS', payload->>'Mesaj mesaj', payload->>'Mesaj implicit', 'Te rog să mă contactezi.'),
      'Mesaj ajutor', coalesce(payload->>'Mesaj ajutor', payload->>'Mesaj urgență', payload->>'Mesaj implicit', 'Am nevoie de ajutor. Te rog să mă contactezi urgent.'),
      'Contacte', jsonb_build_array(
        jsonb_build_object(
          'Etichetă','Principal',
          'Nume',coalesce(payload->>'Nume principal', payload->>'Nume', 'Contact principal'),
          'Telefon',coalesce(payload->>'Telefon principal', payload->>'Numar principal', payload->>'Număr principal', payload->>'Telefon implicit', payload->>'phone_primary', payload->>'Telefon', '0700000001')
        ),
        jsonb_build_object(
          'Etichetă','Secundar',
          'Nume',coalesce(payload->>'Nume secundar', 'Contact secundar'),
          'Telefon',coalesce(payload->>'Telefon secundar', payload->>'Numar secundar', payload->>'Număr secundar', payload->>'phone_secondary', '0700000002')
        ),
        jsonb_build_object(
          'Etichetă','Al treilea',
          'Nume',coalesce(payload->>'Nume al treilea', payload->>'Nume urgentă', payload->>'Nume urgență', 'Contact rezervă'),
          'Telefon',coalesce(payload->>'Telefon al treilea', payload->>'Telefon urgență', payload->>'Telefon urgenta', payload->>'Numar al treilea', payload->>'Număr al treilea', payload->>'phone_third', '0700000003')
        )
      )
    )::text from p;`;
    const out = await runPsql(sql);
    send(res,200, out || '{}', 'application/json; charset=utf-8');
    return true;
  } catch(e) {
    send(res,200, JSON.stringify({
      Nume:'Contact familie', Email:'contact@example.com',
      'Mesaj SMS':'Te rog să mă contactezi.',
      'Mesaj ajutor':'Am nevoie de ajutor. Te rog să mă contactezi urgent.',
      Contacte:[
        {'Etichetă':'Principal', Nume:'Contact principal', Telefon:'0700000001'},
        {'Etichetă':'Secundar', Nume:'Contact secundar', Telefon:'0700000002'},
        {'Etichetă':'Al treilea', Nume:'Contact rezervă', Telefon:'0700000003'}
      ]
    }), 'application/json; charset=utf-8');
    return true;
  }
}
async function handleQuickActionApi(req,res,url){
 if(url.pathname!=='/api/quick-action') return false;
 if(req.method!=='POST'){send(res,405,'Method not allowed'); return true}
 try{const b=await readJson(req); const payload=JSON.stringify({Actiune:b.action||'actiune',Entitate:b.entityName||'',Mesaj:b.message||'',Data:new Date().toISOString()}); const sql=`insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('senior-actions', ${dollar(payload)}::jsonb, 100) returning json_build_object('ok',true,'id',id)::text;`; const out=await runPsql(sql); send(res,200,out||'{"ok":true}','application/json; charset=utf-8'); return true;}catch(e){send(res,500,e.message||'Database error'); return true}
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
      const q = `select coalesce((select jsonb_build_object('email_on_finish',email_on_finish,'email_recipients',email_recipients,'title',title,'start_time',start_time::text)::text from ${dq(PGSCHEMA)}.calendar_series where id=${treatmentId}), '{}');`;
      try { cfg = JSON.parse(await runPsql(q) || '{}'); } catch(_) { cfg = {}; }
    }
    await runPsql(`insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('treatment-confirmations', ${dollar(payload)}::jsonb, 10);`);
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
      mailRes = await sendAndLog('Tratament confirmat', recipients, subject, msg);
    }
    send(res, 200, JSON.stringify({ ok:true, email_sent:!!mailRes.ok, email_status: mailRes.ok ? 'trimis' : (mailRes.reason || mailRes.error || 'neexpediat') }), 'application/json; charset=utf-8');
    return true;
  } catch(e) {
    send(res, 500, e.message || 'Database error');
    return true;
  }
}

async function handleApi(req,res,url){
 try{
  if(url.pathname==='/api/senior/entities'){
   const branchCode=url.searchParams.get('branchCode')||'CB-0001';
   const sql=`select coalesce(json_agg(row_to_json(t))::text,'[]') from (
     select
       e.entity_code,
       coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code) as name,
       e.entity_type,
       coalesce(b.name, to_jsonb(e)->>'branch_name') as branch_name,
       b.branch_code,
       coalesce(to_jsonb(e)->>'address_details', concat_ws(', ', to_jsonb(e)->>'country', to_jsonb(e)->>'city', to_jsonb(e)->>'street', to_jsonb(e)->>'street_no')) as address_details,
       coalesce(to_jsonb(e)->>'responsible_name','') as responsible_name,
       coalesce(card_style.card_color,'') as card_color,
       coalesce(card_style.card_text_color,'') as card_text_color
     from ${dq(PGSCHEMA)}.managed_entity e
     left join ${dq(PGSCHEMA)}.care_branch b on b.id=e.care_branch_id
     left join lateral (
       select
         c.payload->>'Culoare fundal' as card_color,
         c.payload->>'Culoare text' as card_text_color
       from ${dq(PGSCHEMA)}.config_record c
       where c.section_key='senior-card-colors'
         and coalesce(c.payload->>'Cod entitate','')=e.entity_code
       order by c.id desc
       limit 1
     ) card_style on true
     where coalesce(b.branch_code,'')=${dollar(branchCode)} or coalesce(to_jsonb(e)->>'branch_name','') in (select name from ${dq(PGSCHEMA)}.care_branch where branch_code=${dollar(branchCode)})
     order by coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code)
   ) t;`;
   const out=await runPsql(sql); send(res,200,out||'[]','application/json; charset=utf-8'); return true;
  }
  if(url.pathname==='/api/treatment'){
   const sql=`select coalesce(json_agg(row_to_json(t))::text,'[]') from (select cs.id, cs.section_key, cs.task_type, cs.title, cs.description, cs.start_date, cs.end_date, cs.start_time, cs.recurrence_rule, cs.repeat_every_days, cs.active_weekdays, cs.escalation_minutes, cs.email_on_create, cs.email_on_finish, cs.email_recipients, cs.status, e.entity_code, coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code) as entity_name, br.branch_code, br.name as branch_name from ${dq(PGSCHEMA)}.calendar_series cs left join ${dq(PGSCHEMA)}.managed_entity e on e.id=cs.entity_id left join ${dq(PGSCHEMA)}.care_branch br on br.id=cs.care_branch_id where cs.section_key='treatment' and coalesce(cs.active,true)=true and lower(coalesce(cs.status,'active')) not in ('cancelled','canceled','anulat','anulată','anulata') order by cs.start_time nulls last, cs.id desc) t;`;
   const out=await runPsql(sql); send(res,200,out||'[]','application/json; charset=utf-8'); return true;
  }
 }catch(e){send(res,500,e.message||'Database error'); return true}
 return false;
}
const requestHandler=async(req,res)=>{res.familyCareFrameAncestors=frameAncestorsFor(req);const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!originAllowed(req)){send(res,403,'Origin not allowed');return}
  if(await handleSeniorLoginApi(req,res,url))return;
  if(url.pathname.startsWith('/api/')&&!authorizedSenior(req)){send(res,401,JSON.stringify({ok:false,error:'Sesiune expirată'}),'application/json; charset=utf-8');return}
  if(await handleSeniorSoundSettingsApi(req,res,url)) return;
  if(await handleFamilyContactApi(req,res,url)) return;
  if(await handleTreatmentConfirmApi(req,res,url)) return; if(await handleQuickActionApi(req,res,url)) return; if(await handleApi(req,res,url)) return;
  let pathname=decodeURIComponent(url.pathname); if(pathname==='/') pathname='/pages/senior-login.html'; const file=path.resolve(ROOT,pathname.replace(/^[/\\]+/,'')); const relative=path.relative(ROOT,file); if(relative.startsWith('..')||path.isAbsolute(relative)){send(res,403,'Forbidden'); return} fs.readFile(file,(err,data)=>{if(err){send(res,404,'Not found');return} send(res,200,data,MIME[path.extname(file).toLowerCase()]||'application/octet-stream')})
};
let server;
if(HTTPS_ENABLED){if(!fs.existsSync(TLS_PFX_PATH)){console.error('ERROR: HTTPS este activ, dar certificatul lipsește: '+TLS_PFX_PATH);process.exit(1)}server=https.createServer({pfx:fs.readFileSync(TLS_PFX_PATH),passphrase:TLS_PFX_PASSPHRASE},requestHandler)}else{server=http.createServer(requestHandler)}
server.on('error',err=>{if(err&&err.code==='EADDRINUSE')console.error('ERROR: Portul '+PORT+' este deja folosit. Oprește instanța existentă sau schimbă PORT.');else console.error('ERROR server:',err&&err.message?err.message:err);process.exitCode=1});
const PID_FILE=path.join(ROOT,'.familycare-senior.pid');try{fs.writeFileSync(PID_FILE,String(process.pid),'utf8')}catch(_){}function removePidFile(){try{if(fs.existsSync(PID_FILE)&&fs.readFileSync(PID_FILE,'utf8').trim()===String(process.pid))fs.unlinkSync(PID_FILE)}catch(_){}}function shutdown(){server.close(()=>process.exit(0));if(typeof server.closeAllConnections==='function')server.closeAllConnections();setTimeout(()=>process.exit(0),1500).unref()}process.on('exit',removePidFile);process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
server.listen(PORT,HOST,()=>{console.log('============================================================');console.log('FamilyCare Senior V1.0.67 Universal PWA is running');console.log('URL: '+PROTOCOL+'://localhost:'+PORT+'/pages/senior-login.html');console.log('Database: '+(process.env.PGDATABASE||'(default)')+' / schema '+PGSCHEMA);console.log('DB mode: '+(process.env.DATABASE_URL?'DATABASE_URL / pg':'local psql'));if(MAIN_BASE_URL)console.log('Main URL: '+MAIN_BASE_URL);console.log('Press CTRL+C in this window to stop the server.');console.log('============================================================')});
