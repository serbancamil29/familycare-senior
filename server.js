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
    await runPsql(`insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('email-outbox', ${dollar(payload)}::jsonb, 10);`);
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


const PORT = Number(process.env.PORT || 31001);
const HOST = process.env.HOST || ((process.env.RENDER || process.env.NODE_ENV === 'production') ? '0.0.0.0' : '127.0.0.1');
const ROOT = __dirname;
const PGSCHEMA = process.env.PGSCHEMA || 'familycare';
const PSQL_BIN = process.env.PSQL_BIN || 'psql';
const HTTPS_ENABLED = String(process.env.HTTPS || '').toLowerCase() === 'true';
const TLS_PFX_PATH = process.env.TLS_PFX_PATH || path.join(ROOT, 'certs', 'familycare-local.pfx');
const TLS_PFX_PASSPHRASE = process.env.TLS_PFX_PASSPHRASE || 'familycare-local';
const PROTOCOL = HTTPS_ENABLED ? 'https' : 'http';
const SENIOR_ENTITY_CODE = String(process.env.SENIOR_ENTITY_CODE || '').trim();
// V1.0.89: Senior folosește același login ca Main, ca să lege aparținătorul de beneficiarii lui.
// Doar pentru demo se poate dezactiva cu SENIOR_AUTH_DISABLED=true sau FAMILYCARE_AUTH_DISABLED=true.
const SENIOR_AUTH_DISABLED = ['true','1','yes','da'].includes(String(process.env.SENIOR_AUTH_DISABLED || process.env.FAMILYCARE_AUTH_DISABLED || '').trim().toLowerCase());
const SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.SESSION_TTL_MINUTES || 720) * 60 * 1000);
const seniorSessions = new Map(); // token -> { expires, userId, userName, headerId, headerCode, headerName }
const loginAttempts = new Map();
setInterval(()=>{const now=Date.now();for(const [token,state] of seniorSessions){if(!state||!state.expires||state.expires<now)seniorSessions.delete(token);}for(const [key,state] of loginAttempts){if((state.until&&state.until<now)||(!state.until&&state.first&&now-state.first>15*60*1000))loginAttempts.delete(key);}},15*60*1000).unref();
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
function send(res,status,body,type='text/plain; charset=utf-8',extraHeaders={}){res.writeHead(status,{
  'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'Cross-Origin-Opener-Policy':'same-origin','X-Permitted-Cross-Domain-Policies':'none',
  'Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors "+(res.familyCareFrameAncestors||"'self'")+"; base-uri 'self'; form-action 'self'",
  ...extraHeaders,
  ...(res.familyCareSecureRequest ? {'Strict-Transport-Security':'max-age=31536000; includeSubDomains'} : {})
});res.end(body)}
function dq(s){return '"'+String(s).replace(/"/g,'""')+'"'}
function dollar(text){let tag='fc';while(String(text).includes('$'+tag+'$')) tag+='x';return '$'+tag+'$'+String(text)+'$'+tag+'$'}
let pgPool=null;
function getPgPool(){
 if(!process.env.DATABASE_URL)return null;
 if(!pgPool){
  const {Pool}=require('pg');
  const sslMode=String(process.env.PGSSLMODE||'').toLowerCase();
  const sslDisabled=['disable','disabled','false','0','no'].includes(sslMode)||String(process.env.DATABASE_SSL||'').toLowerCase()==='false';
  const sslRequired=['require','true','1','yes'].includes(sslMode)||String(process.env.DATABASE_SSL||'').toLowerCase()==='true'||!!process.env.RENDER;
  pgPool=new Pool({connectionString:process.env.DATABASE_URL,ssl:sslDisabled?false:(sslRequired?{rejectUnauthorized:false}:undefined),max:Number(process.env.PGPOOL_MAX||5),idleTimeoutMillis:30000,connectionTimeoutMillis:15000});
 }
 return pgPool;
}
function pgValue(value){if(value===null||value===undefined)return'';if(value instanceof Date)return value.toISOString();if(Buffer.isBuffer(value))return value.toString('utf8');if(typeof value==='object')return JSON.stringify(value);return String(value)}
function pgOutput(result){const results=Array.isArray(result)?result:[result];const last=[...results].reverse().find(r=>r&&Array.isArray(r.rows));if(!last||!last.rows.length)return'';return last.rows.map(row=>{const values=Object.values(row);return values.length===1?pgValue(values[0]):values.map(pgValue).join('|')}).join('\n').trim()}
function runPsql(sql){const pool=getPgPool();if(pool)return pool.query(sql).then(pgOutput).catch(error=>{throw new Error(error?.message||'PostgreSQL query failed')});return new Promise((resolve,reject)=>{const file=path.join(os.tmpdir(),'familycare_senior_'+Date.now()+'_'+Math.random().toString(16).slice(2)+'.sql');fs.writeFileSync(file,sql,'utf8');const args=['-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-f',file];execFile(PSQL_BIN,args,{env:{...process.env},windowsHide:true,timeout:15000},(err,stdout,stderr)=>{try{fs.unlinkSync(file)}catch(_){} if(err){reject(new Error(String(stderr||err.message||'PostgreSQL command failed').trim()));return} resolve(String(stdout||'').trim())})})}

async function readJson(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>2000000)reject(new Error('Body too large'))});req.on('end',()=>{try{resolve(data?JSON.parse(data):{})}catch(e){reject(new Error('Invalid JSON body'))}});req.on('error',reject)})}
function sameSecret(a,b){const aa=Buffer.from(String(a));const bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)}
function originAllowed(req){const origin=req.headers.origin;if(!origin)return true;try{const u=new URL(origin);const forwardedProto=String(req.headers['x-forwarded-proto']||PROTOCOL).split(',')[0].trim();return u.protocol===forwardedProto+':'&&u.host.toLowerCase()===String(req.headers.host||'').toLowerCase()}catch(_){return false}}
function requestIsSecure(req){return HTTPS_ENABLED||String(req.headers['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase()==='https'}
function cookies(req){return String(req.headers.cookie||'').split(';').reduce((out,part)=>{const index=part.indexOf('=');if(index>0){const key=part.slice(0,index).trim(),raw=part.slice(index+1).trim();try{out[key]=decodeURIComponent(raw)}catch(_){out[key]=raw}}return out},{})}
function seniorCookie(token,req,maxAge){return `fc_senior_session=${encodeURIComponent(token||'')}; Path=/; HttpOnly; SameSite=Strict${requestIsSecure(req)?'; Secure':''}; Max-Age=${Math.max(0,maxAge||0)}`}
function getSeniorSession(req){
 if(SENIOR_AUTH_DISABLED)return {authDisabled:true,expires:Date.now()+SESSION_TTL_MS,headerCode:'',headerId:null,headerName:'',userName:'Demo'};
 const bearer=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 const token=cookies(req).fc_senior_session||bearer;
 const state=token?seniorSessions.get(token):null;
 if(!state||!state.expires||state.expires<Date.now()){if(token)seniorSessions.delete(token);return null}
 state.expires=Date.now()+SESSION_TTL_MS;
 seniorSessions.set(token,state);
 return state;
}
function authorizedSenior(req){return !!getSeniorSession(req)}
function loginKey(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim()}
function loginBlocked(req){const state=loginAttempts.get(loginKey(req));if(!state)return false;if(state.until>Date.now())return true;if(state.until)loginAttempts.delete(loginKey(req));return false}
function loginFailure(req){const key=loginKey(req);const state=loginAttempts.get(key)||{count:0,first:Date.now(),until:0};if(Date.now()-state.first>15*60*1000){state.count=0;state.first=Date.now()}state.count+=1;if(state.count>=5)state.until=Date.now()+15*60*1000;loginAttempts.set(key,state)}
function normalizePhone(value){return String(value||'').replace(/[^0-9+]/g,'').trim()}
function passwordHash(password,salt,iterations=180000){return crypto.pbkdf2Sync(String(password||''),String(salt||''),iterations,32,'sha256').toString('hex')}
function makeCode(prefix){return prefix+'-'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).slice(2,6).toUpperCase()}
async function findSeniorLoginUser(identifier){
 const raw=String(identifier||'').trim(); const normalized=normalizePhone(raw);
 if(!raw&&!normalized)return null;
 try{
  const out=await runPsql(`select coalesce((select json_build_object('id',id,'payload',payload)::text
    from ${dq(PGSCHEMA)}.config_record
    where section_key='main-login-user'
      and coalesce((payload->>'Activ')::boolean,true)=true
      and (coalesce(payload->>'Telefon','')=${dollar(normalized)} or lower(coalesce(payload->>'Nume',''))=lower(${dollar(raw)}) or lower(coalesce(payload->>'Utilizator',''))=lower(${dollar(raw)}))
    order by id desc limit 1),'{}');`);
  const parsed=JSON.parse(out||'{}'); return parsed&&parsed.id?parsed:null;
 }catch(_){return null}
}
async function resolveSeniorBranch(headerId, requested=''){
 const wanted=String(requested||'').trim();
 const out=await runPsql(`with branches as (
   select id,branch_code,name,count(*) over() as total
   from ${dq(PGSCHEMA)}.care_branch
   where care_header_id=${Number(headerId)||0} and coalesce(active,true)=true
  ) select coalesce((select json_build_object('id',id,'branch_code',branch_code,'name',name,'total',total)::text from branches
     where (${dollar(wanted)}<>'' and (branch_code=${dollar(wanted)} or name=${dollar(wanted)})) or (${dollar(wanted)}='' and total=1)
     order by id limit 1),'{}');`);
 const branch=JSON.parse(out||'{}');
 return branch&&branch.id?branch:null;
}
async function ensureSeniorUserScope(found){
 const payload=found&&found.payload?found.payload:{};
 const userId=found&&found.id?Number(found.id):0;
 const name=String(payload.Nume||payload.Utilizator||'Aparținător').trim()||'Aparținător';
 let headerCode=String(payload.HeaderCode||payload['ID organizație']||payload.Header||'').trim();
 let orgName=String(payload['Organizație / cont']||payload.Organizatie||payload.Organizație||'').trim();
 let entityCode=String(payload.EntityCode||payload['Cod beneficiar']||payload.BeneficiarCode||'').trim();
 if(entityCode){
  try{
   const out=await runPsql(`select coalesce((select json_build_object('entity_code',e.entity_code,'entity_name',e.display_name,'header_id',h.id,'header_code',h.header_code,'header_name',h.name,'branch_code',b.branch_code)::text
     from ${dq(PGSCHEMA)}.managed_entity e
     left join ${dq(PGSCHEMA)}.care_header h on h.id=e.care_header_id
     left join ${dq(PGSCHEMA)}.care_branch b on b.id=e.care_branch_id
     where coalesce(e.active,true)=true and e.entity_code=${dollar(entityCode)}
     order by e.id limit 1),'{}');`);
   const linked=JSON.parse(out||'{}');
   if(linked&&linked.entity_code){
    if(!linked.branch_code)throw new Error('Beneficiarul nu este alocat unei ramuri / locații. Configurează ramura în FamilyCare Main.');
    if(userId) await runPsql(`update ${dq(PGSCHEMA)}.config_record set payload=payload || jsonb_build_object('HeaderCode',${dollar(linked.header_code||'')},'ID organizație',${dollar(linked.header_code||'')},'Organizație / cont',${dollar(linked.header_name||'')},'Organizatie',${dollar(linked.header_name||'')},'BranchCode',${dollar(linked.branch_code||'')},'EntityCode',${dollar(linked.entity_code)},'Cod beneficiar',${dollar(linked.entity_code)},'Beneficiar',${dollar(linked.entity_name||'')},'Rol','ramura') where id=${userId};`);
    return {userId,userName:name,headerId:Number(linked.header_id||0),headerCode:linked.header_code||'',headerName:linked.header_name||orgName,branchCode:'',entityCode:linked.entity_code,entityName:linked.entity_name||'',role:'beneficiar'};
   }
  }catch(_){ }
 }
 if(headerCode){
  try{
   const out=await runPsql(`select coalesce((select json_build_object('id',id,'header_code',header_code,'name',name)::text from ${dq(PGSCHEMA)}.care_header where coalesce(active,true)=true and header_code=${dollar(headerCode)} order by id limit 1),'{}');`);
   const h=JSON.parse(out||'{}');
   if(h&&h.id){
      const role=String(payload.Rol||'apartinator').toLowerCase();
      if(role==='ramura'){
        const branch=await resolveSeniorBranch(h.id,payload.BranchCode||payload['Grup / locație']||'');
        if(!branch)throw new Error('Contul nu are o ramură unică. Configurează BranchCode în Main pentru dispozitivul Senior.');
        if(userId)await runPsql(`update ${dq(PGSCHEMA)}.config_record set payload=payload||jsonb_build_object('BranchCode',${dollar(branch.branch_code)},'Grup / locație',${dollar(branch.name)},'Rol','ramura') where id=${userId};`);
        return {userId,userName:name,headerId:Number(h.id),headerCode:h.header_code,headerName:h.name||orgName,branchCode:branch.branch_code,entityCode:'',role:'ramura'};
      }
      if(userId)await runPsql(`update ${dq(PGSCHEMA)}.config_record set payload=payload||jsonb_build_object('HeaderCode',${dollar(h.header_code)},'ID organizație',${dollar(h.header_code)},'Organizație / cont',${dollar(h.name||orgName)},'Organizatie',${dollar(h.name||orgName)},'Rol','apartinator') where id=${userId};`);
      return {userId,userName:name,headerId:Number(h.id),headerCode:h.header_code,headerName:h.name||orgName,branchCode:'',entityCode:'',role:'apartinator'};
    }
  }catch(_){}
 }
 const desiredOrg=orgName || (String(payload['Tip organizație']||'').toLowerCase()==='retea' ? ('Rețeaua '+name) : ('Familia '+name));
 try{
  const out=await runPsql(`select coalesce((select json_build_object('id',id,'header_code',header_code,'name',name)::text
    from ${dq(PGSCHEMA)}.care_header
    where coalesce(active,true)=true and (name=${dollar(desiredOrg)} or coordinator_name=${dollar(name)} or (${dollar(orgName)}<>'' and name=${dollar(orgName)}))
    order by case when name=${dollar(desiredOrg)} then 0 else 1 end, id limit 1),'{}');`);
  const h=JSON.parse(out||'{}');
  if(h&&h.id){
    await runPsql(`update ${dq(PGSCHEMA)}.config_record set payload=payload || jsonb_build_object('HeaderCode',${dollar(h.header_code)},'ID organizație',${dollar(h.header_code)},'Organizație / cont',${dollar(h.name||desiredOrg)},'Organizatie',${dollar(h.name||desiredOrg)},'Rol','apartinator') where id=${userId};`);
    return {userId,userName:name,headerId:Number(h.id),headerCode:h.header_code,headerName:h.name||desiredOrg,branchCode:'',entityCode:'',role:'apartinator'};
  }
 }catch(_){}
 throw new Error('Contul nu este legat de o organizație și o ramură valabile. Corectează legătura din Main → Configurări → Beneficiari.');
}
async function createSeniorLoginUser(body){
 const name=String(body.name||body.Nume||body.user||body.Utilizator||'').trim();
 const phone=normalizePhone(body.phone||body.Telefon||'');
 const password=String(body.password||body.Parola||body['Parolă']||'');
 const orgType=String(body.orgType||body['Tip organizație']||'familie_proprie').trim()||'familie_proprie';
 if(!name)throw new Error('Completează utilizatorul.');
 if(!phone)throw new Error('Completează telefonul.');
 if(password.length<6)throw new Error('Parola trebuie să aibă minimum 6 caractere.');
 const existing=await findSeniorLoginUser(phone)||await findSeniorLoginUser(name);
 if(existing)throw new Error('Există deja un user cu acest telefon sau utilizator.');
 const headerCode=makeCode('CH'); const branchCode=makeCode('CB');
 const orgName=orgType==='retea'?('Rețeaua '+name):(orgType==='camin'?('Cămin '+name):('Familia '+name));
 const branchName=orgType==='retea'||orgType==='camin'?'Grup principal':'Familia mea';
 const salt=crypto.randomBytes(16).toString('hex'); const iterations=180000;
 const payload=JSON.stringify({Nume:name,Utilizator:name,Telefon:phone,'Tip organizație':orgType,HeaderCode:headerCode,'ID organizație':headerCode,Organizatie:orgName,'Organizație / cont':orgName,BranchCode:branchCode,'Grup / locație':branchName,Salt:salt,Iterations:iterations,Hash:passwordHash(password,salt,iterations),Activ:true,CreatLa:new Date().toISOString()});
 const sql=`with h as (insert into ${dq(PGSCHEMA)}.care_header(header_code,name,context_type,coordinator_name,description,active) values (${dollar(headerCode)},${dollar(orgName)},${dollar(orgType)},${dollar(name)},'Creat din login FamilyCare Senior.',true) returning id,header_code,name), b as (insert into ${dq(PGSCHEMA)}.care_branch(care_header_id,branch_code,name,branch_type,coordinator_name,description,sort_order,active) select id,${dollar(branchCode)},${dollar(branchName)},'familie',${dollar(name)},'Grup implicit creat la înregistrare Senior.',10,true from h returning branch_code), u as (insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('main-login-user',${dollar(payload)}::jsonb,10) returning id) select json_build_object('ok',true,'id',(select id from u),'headerCode',(select header_code from h),'branchCode',(select branch_code from b))::text;`;
 return JSON.parse(await runPsql(sql)||'{}');
}
function openSeniorSessionFor(res,req,scope){
 const token=crypto.randomBytes(32).toString('base64url');
 const state={expires:Date.now()+SESSION_TTL_MS,userId:scope.userId||0,userName:scope.userName||'',headerId:scope.headerId||null,headerCode:scope.headerCode||'',headerName:scope.headerName||'',branchCode:scope.branchCode||'',entityCode:scope.entityCode||'',entityName:scope.entityName||'',role:scope.role||''};
 seniorSessions.set(token,state);
 res.setHeader('Set-Cookie',seniorCookie(token,req,Math.floor(SESSION_TTL_MS/1000)));
 return token;
}

async function handleSeniorLoginApi(req,res,url){
  if(url.pathname==='/api/senior/branches'&&req.method==='GET'){
    try{
      const session=getSeniorSession(req);
      const headerFilter=session&&session.headerCode?` and h.header_code=${dollar(session.headerCode)}`:'';
      const branchFilter=session&&session.branchCode?` and b.branch_code=${dollar(session.branchCode)}`:'';
      const sql=`select coalesce(json_agg(row_to_json(t))::text,'[]') from (select b.branch_code, b.name from ${dq(PGSCHEMA)}.care_branch b left join ${dq(PGSCHEMA)}.care_header h on h.id=b.care_header_id where coalesce(b.active,true)=true${headerFilter}${branchFilter} order by b.sort_order,b.id) t;`;
      const out=await runPsql(sql);
      send(res,200,out&&out!=='[]'?out:JSON.stringify([]),'application/json; charset=utf-8');
    }catch(_){send(res,200,JSON.stringify([]),'application/json; charset=utf-8');}
    return true;
  }
  if(url.pathname==='/api/senior/session'&&req.method==='GET'){
    const state=getSeniorSession(req);
    const effectiveEntityCode=SENIOR_ENTITY_CODE||'';
    const preferredEntityCode=(state&&state.entityCode)||'';
    const token=cookies(req).fc_senior_session||'';if(token&&state)res.setHeader('Set-Cookie',seniorCookie(token,req,Math.floor(SESSION_TTL_MS/1000)));
    send(res,200,JSON.stringify({ok:true,authenticated:!!state,authRequired:!SENIOR_AUTH_DISABLED,singleEntity:!!effectiveEntityCode,entityCode:effectiveEntityCode,preferredEntityCode,expiresIn:SESSION_TTL_MS,headerCode:state&&state.headerCode||'',headerName:state&&state.headerName||'',branchCode:state&&state.branchCode||'',userName:state&&state.userName||'',role:state&&state.role||''}),'application/json; charset=utf-8');
    return true;
  }
  if(url.pathname==='/api/senior/logout'&&req.method==='DELETE'){
    const token=cookies(req).fc_senior_session||'';if(token)seniorSessions.delete(token);res.setHeader('Set-Cookie',seniorCookie('',req,0));send(res,200,'{"ok":true}','application/json; charset=utf-8');return true
  }
  if(url.pathname==='/api/senior/register'){
    send(res,403,JSON.stringify({ok:false,error:'Utilizatorii Senior se creează doar din FamilyCare Main, la Configurări → Beneficiari.'}),'application/json; charset=utf-8');
    return true;
  }
  if(url.pathname!=='/api/senior/login')return false;
  if(req.method!=='POST'){send(res,405,'Method not allowed');return true}
  if(SENIOR_AUTH_DISABLED){send(res,200,JSON.stringify({ok:true,authRequired:false,expiresIn:SESSION_TTL_MS,singleEntity:!!SENIOR_ENTITY_CODE,entityCode:SENIOR_ENTITY_CODE}),'application/json; charset=utf-8');return true}
  if(loginBlocked(req)){send(res,429,JSON.stringify({ok:false,error:'Prea multe încercări. Reîncearcă peste 15 minute.'}),'application/json; charset=utf-8');return true}
  try{
    const b=await readJson(req);
    const found=await findSeniorLoginUser(b.identifier||b.user||b.phone||b.Telefon||'');
    const payload=found&&found.payload?found.payload:null;
    const hash=payload&&passwordHash(b.password||b.Parola||b['Parolă']||'',payload.Salt||'',Number(payload.Iterations||180000));
    if(!payload||!payload.Hash||hash!==payload.Hash){loginFailure(req);send(res,401,JSON.stringify({ok:false,error:'Telefon/utilizator sau parolă incorectă.'}),'application/json; charset=utf-8');return true}
    loginAttempts.delete(loginKey(req));
    const scope=await ensureSeniorUserScope(found);
    openSeniorSessionFor(res,req,scope);
    const effectiveEntityCode=SENIOR_ENTITY_CODE||'';
    send(res,200,JSON.stringify({ok:true,expiresIn:SESSION_TTL_MS,singleEntity:!!effectiveEntityCode,entityCode:effectiveEntityCode,preferredEntityCode:scope.entityCode||'',headerCode:scope.headerCode,headerName:scope.headerName,branchCode:scope.branchCode||'',userName:scope.userName,role:scope.role||''}),'application/json; charset=utf-8');
    return true;
  }catch(e){send(res,400,JSON.stringify({ok:false,error:e.message||'Cerere invalidă.'}),'application/json; charset=utf-8');return true}
}

async function handleSeniorSoundSettingsApi(req,res,url){
 if(url.pathname!=='/api/senior-sound-settings')return false;
 try{
  if(req.method==='GET'){
   const session=getSeniorSession(req)||{};const headerCode=String(session.headerCode||'').trim();const scope=headerCode?` and (payload->>'HeaderCode'=${dollar(headerCode)} or (coalesce(payload->>'HeaderCode','')='' and (select count(*) from ${dq(PGSCHEMA)}.care_header where coalesce(active,true)=true)=1))`:'';
   const sql=`select coalesce((
     select jsonb_build_object(
       'type', case when lower(coalesce(payload->>'Tip sunet', payload->>'type', 'soft')) in ('soft','bell','alert') then lower(coalesce(payload->>'Tip sunet', payload->>'type', 'soft')) else 'soft' end,
       'volume', case when coalesce(payload->>'Volum', payload->>'volume', '') ~ '^[0-9]+$' then least(100, greatest(0, coalesce(payload->>'Volum', payload->>'volume')::int)) else 70 end,
       'active', coalesce(payload->>'Activ', payload->>'active', 'da')
     )::text
     from ${dq(PGSCHEMA)}.config_record
     where section_key='senior-sound-settings'${scope}
     order by sort_order, id
     limit 1
   ), jsonb_build_object('type','soft','volume',70,'active','da')::text);`;
   send(res,200,await runPsql(sql)||'{"type":"soft","volume":70,"active":"da"}','application/json; charset=utf-8');return true;
  }
  send(res,405,'Method not allowed');return true;
 }catch(e){send(res,200,'{"type":"soft","volume":70,"active":"da"}','application/json; charset=utf-8');return true;}
}

async function getSeniorDisplayLimit(session={}){
 try{
  const headerCode=String(session&&session.headerCode||'').trim();
  const scope=headerCode?` and (payload->>'HeaderCode'=${dollar(headerCode)} or (coalesce(payload->>'HeaderCode','')='' and (select count(*) from ${dq(PGSCHEMA)}.care_header where coalesce(active,true)=true)=1))`:'';
  const sql=`select coalesce((select case when coalesce(payload->>'Număr carduri vizibile','') ~ '^[0-9]+$' then least(100,greatest(1,(payload->>'Număr carduri vizibile')::int)) else 0 end from ${dq(PGSCHEMA)}.config_record where section_key='senior-display-settings'${scope} order by updated_at desc nulls last, id desc limit 1),0);`;
  return Math.max(0,Math.min(100,Number(await runPsql(sql))||0));
 }catch(_){return 0}
}
async function handleSeniorDisplaySettingsApi(req,res,url){
 if(url.pathname!=='/api/senior-display-settings')return false;
 if(req.method!=='GET'){send(res,405,'Method not allowed');return true}
 const maxVisible=await getSeniorDisplayLimit(getSeniorSession(req)||{});
 send(res,200,JSON.stringify({ok:true,maxVisible,mode:maxVisible?'fixed':'auto',maximumSupported:100}),'application/json; charset=utf-8');
 return true;
}

async function handleFamilyContactApi(req,res,url) {
  if (url.pathname !== '/api/family-contact') return false;
  try {
    const session=getSeniorSession(req)||{};
    const headerCode=String(session.headerCode||'').trim();
    const requestedEntity=String(url.searchParams.get('entityCode')||session.entityCode||'').trim();
    const scope=headerCode?` and (payload->>'HeaderCode'=${dollar(headerCode)} or (coalesce(payload->>'HeaderCode','')='' and (select count(*) from ${dq(PGSCHEMA)}.care_header where coalesce(active,true)=true)=1))`:'';
    const entityScope=requestedEntity?` and (coalesce(payload->>'EntityCode', payload->>'Cod entitate','')=${dollar(requestedEntity)} or coalesce(payload->>'EntityCode', payload->>'Cod entitate','')='')`:'';
    const sql = `with contact_source as (
      select payload, updated_at, id, section_key
      from ${dq(PGSCHEMA)}.config_record
      where (section_key='family-contact'
         or (section_key='notification-channels' and lower(coalesce(payload->>'Canal','')) in ('telefon / sms','telefon','sms'))
         or payload ? 'Telefon principal'
         or payload ? 'Numar principal'
         or payload ? 'Număr principal'
         or payload ? 'Telefon implicit'
         or payload ? 'phone_primary')${scope}${entityScope}
      order by
        case when ${dollar(requestedEntity)}<>'' and coalesce(payload->>'EntityCode', payload->>'Cod entitate','')=${dollar(requestedEntity)} then 0 else 1 end,
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
          'Etichetă',coalesce(payload->>'Nume principal', payload->>'Nume', 'Familie 1'),
          'Nume',coalesce(payload->>'Nume principal', payload->>'Nume', 'Familie 1'),
          'Telefon',coalesce(payload->>'Telefon principal', payload->>'Numar principal', payload->>'Număr principal', payload->>'Telefon implicit', payload->>'phone_primary', payload->>'Telefon', '')
        ),
        jsonb_build_object(
          'Etichetă',coalesce(payload->>'Nume secundar', 'Familie 2'),
          'Nume',coalesce(payload->>'Nume secundar', 'Familie 2'),
          'Telefon',coalesce(payload->>'Telefon secundar', payload->>'Numar secundar', payload->>'Număr secundar', payload->>'phone_secondary', '')
        ),
        jsonb_build_object(
          'Etichetă',coalesce(payload->>'Nume al treilea', payload->>'Nume urgentă', payload->>'Nume urgență', 'Familie 3'),
          'Nume',coalesce(payload->>'Nume al treilea', payload->>'Nume urgentă', payload->>'Nume urgență', 'Familie 3'),
          'Telefon',coalesce(payload->>'Telefon al treilea', payload->>'Telefon urgență', payload->>'Telefon urgenta', payload->>'Numar al treilea', payload->>'Număr al treilea', payload->>'phone_third', '')
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
        {'Etichetă':'Familie 1', Nume:'Familie 1', Telefon:''},
        {'Etichetă':'Familie 2', Nume:'Familie 2', Telefon:''},
        {'Etichetă':'Familie 3', Nume:'Familie 3', Telefon:''}
      ]
    }), 'application/json; charset=utf-8');
    return true;
  }
}
async function handleQuickActionApi(req,res,url){
 if(url.pathname!=='/api/quick-action') return false;
 if(req.method!=='POST'){send(res,405,'Method not allowed'); return true}
 try{const b=await readJson(req);const session=getSeniorSession(req)||{};const requestEntityCode=String(b.entityCode||b['Cod entitate']||session.entityCode||'').trim();const payload=JSON.stringify({Actiune:b.action||'actiune',Entitate:b.entityName||'',Mesaj:b.message||'',Data:new Date().toISOString(),HeaderCode:session.headerCode||'',BranchCode:session.branchCode||'','Cod entitate':requestEntityCode}); const sql=`insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('senior-actions', ${dollar(payload)}::jsonb, 100) returning json_build_object('ok',true,'id',id)::text;`; const out=await runPsql(sql); send(res,200,out||'{"ok":true}','application/json; charset=utf-8'); return true;}catch(e){send(res,500,e.message||'Database error'); return true}
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
    const session=getSeniorSession(req)||{};
    const requestEntityCode=String(b.entityCode||b['Cod entitate']||session.entityCode||'').trim();
    const payload = JSON.stringify({
      Tip:'confirmare-tratament', Tratament:title, Senior:entityName, Ora:startTime,
      OccurrenceKey:occurrenceKey, ConfirmatLa:new Date().toISOString(),HeaderCode:session.headerCode||'',BranchCode:session.branchCode||'','Cod entitate':requestEntityCode
    });
    const decisionPayload = JSON.stringify({
      Senior:entityName, Tratament:title, 'Ora planificată':startTime,
      Decizie:'Administrat / efectuat', Motiv:'', 'Înregistrat la':new Date().toISOString(),
      OccurrenceKey:occurrenceKey, 'ID tratament':treatmentId || '',HeaderCode:session.headerCode||'',BranchCode:session.branchCode||'','Cod entitate':requestEntityCode
    });
    let cfg = null;
    if (treatmentId) {
      const q = `select coalesce((select jsonb_build_object('email_on_finish',cs.email_on_finish,'email_recipients',cs.email_recipients,'title',cs.title,'start_time',cs.start_time::text)::text from ${dq(PGSCHEMA)}.calendar_series cs left join ${dq(PGSCHEMA)}.managed_entity e on e.id=cs.entity_id left join ${dq(PGSCHEMA)}.care_branch br on br.id=coalesce(cs.care_branch_id,e.care_branch_id) left join ${dq(PGSCHEMA)}.care_header h on h.id=coalesce(cs.care_header_id,e.care_header_id) where cs.id=${treatmentId}${session.headerCode?` and h.header_code=${dollar(session.headerCode)}`:''}${session.branchCode?` and br.branch_code=${dollar(session.branchCode)}`:''}), '{}');`;
      try { cfg = JSON.parse(await runPsql(q) || '{}'); } catch(_) { cfg = {}; }
      if(!cfg||!cfg.title){send(res,403,JSON.stringify({ok:false,error:'Tratamentul nu aparține beneficiarului autentificat.'}),'application/json; charset=utf-8');return true}
    }
    await runPsql(`insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('treatment-confirmations', ${dollar(payload)}::jsonb, 10); insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('treatment-decisions', ${dollar(decisionPayload)}::jsonb, 10);`);
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
      mailRes = await sendAndLog('Tratament confirmat', recipients, subject, msg, session.headerCode||'');
    }
    send(res, 200, JSON.stringify({ ok:true, email_sent:!!mailRes.ok, email_status: mailRes.ok ? 'trimis' : (mailRes.reason || mailRes.error || 'neexpediat') }), 'application/json; charset=utf-8');
    return true;
  } catch(e) {
    send(res, 500, e.message || 'Database error');
    return true;
  }
}

async function handleTreatmentDecisionApi(req,res,url){
 if(url.pathname!=='/api/treatment/decision')return false;
 if(req.method!=='POST'){send(res,405,'Method not allowed');return true}
 try{
  const b=await readJson(req);
  const session=getSeniorSession(req)||{};
  const allowed=['Refuzat','Omis','Amânat'];
  const decision=allowed.includes(String(b.decision||''))?String(b.decision):'';
  if(!decision){send(res,400,JSON.stringify({ok:false,error:'Decizie invalidă.'}),'application/json; charset=utf-8');return true}
  const treatmentId=Number(b.treatmentId||0);
  if(treatmentId){const permitted=Number(await runPsql(`select count(*) from ${dq(PGSCHEMA)}.calendar_series cs left join ${dq(PGSCHEMA)}.managed_entity e on e.id=cs.entity_id left join ${dq(PGSCHEMA)}.care_branch br on br.id=coalesce(cs.care_branch_id,e.care_branch_id) left join ${dq(PGSCHEMA)}.care_header h on h.id=coalesce(cs.care_header_id,e.care_header_id) where cs.id=${treatmentId}${session.headerCode?` and h.header_code=${dollar(session.headerCode)}`:''}${session.branchCode?` and br.branch_code=${dollar(session.branchCode)}`:''};`)||0);if(permitted!==1){send(res,403,JSON.stringify({ok:false,error:'Tratamentul nu aparține ramurii autentificate.'}),'application/json; charset=utf-8');return true}}
  const requestEntityCode=String(b.entityCode||b['Cod entitate']||session.entityCode||'').trim();
  const payload=JSON.stringify({
   Senior:String(b.entityName||'').slice(0,160),Tratament:String(b.title||'Tratament').slice(0,240),
   'Ora planificată':String(b.startTime||'').slice(0,20),Decizie:decision,Motiv:String(b.reason||'').slice(0,1000),
   'Înregistrat la':new Date().toISOString(),OccurrenceKey:String(b.occurrenceKey||'').slice(0,300),'ID tratament':String(b.treatmentId||'').slice(0,40),HeaderCode:session.headerCode||'',BranchCode:session.branchCode||'','Cod entitate':requestEntityCode
  });
  await runPsql(`insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('treatment-decisions', ${dollar(payload)}::jsonb, 10);`);
  send(res,200,'{"ok":true}','application/json; charset=utf-8');return true;
 }catch(e){send(res,500,JSON.stringify({ok:false,error:e.message||'Database error'}),'application/json; charset=utf-8');return true}
}

async function handleBeneficiaryFeedbackApi(req,res,url){
 if(url.pathname!=='/api/senior/feedback')return false;
 if(req.method!=='POST'){send(res,405,'Method not allowed');return true}
 try{
  const b=await readJson(req);
  const session=getSeniorSession(req)||{};
  const type=String(b.type||'').toLowerCase();
  if(!['complaint','satisfaction','rights'].includes(type)){send(res,400,JSON.stringify({ok:false,error:'Tip invalid.'}),'application/json; charset=utf-8');return true}
  const score=type==='satisfaction'?Math.max(1,Math.min(5,Number(b.score)||0)):'';
  if(type==='satisfaction'&&!score){send(res,400,JSON.stringify({ok:false,error:'Alege un scor între 1 și 5.'}),'application/json; charset=utf-8');return true}
  const anonymous=Boolean(b.anonymous);
  const labels={complaint:'Sesizare / reclamație',satisfaction:'Satisfacție',rights:'Cerere privind drepturile'};
  const payload=JSON.stringify({
   Tip:labels[type],Categorie:String(b.category||'General').slice(0,120),Beneficiar:anonymous?'':String(b.entityName||'').slice(0,160),
   'Cod entitate':anonymous?'':String(b.entityCode||'').slice(0,80),Anonim:anonymous?'Da':'Nu',Mesaj:String(b.message||'').slice(0,2000),
   Scor:score,Data:new Date().toISOString(),Status:'Nou',Sursă:'FamilyCare Senior',HeaderCode:session.headerCode||'',BranchCode:session.branchCode||'','Cod entitate sesiune':session.entityCode||''
  });
  await runPsql(`insert into ${dq(PGSCHEMA)}.config_record(section_key,payload,sort_order) values ('beneficiary-feedback', ${dollar(payload)}::jsonb, 10);`);
  send(res,200,'{"ok":true}','application/json; charset=utf-8');return true;
 }catch(e){send(res,500,JSON.stringify({ok:false,error:e.message||'Database error'}),'application/json; charset=utf-8');return true}
}

async function handleApi(req,res,url){
 try{
  if(url.pathname==='/api/senior/entities'){
   const requestedBranchCode=url.searchParams.get('branchCode')||'';
   const session=getSeniorSession(req);
   const scopedEntityCode=SENIOR_ENTITY_CODE||'';
   const entityFilter=scopedEntityCode?` and e.entity_code=${dollar(scopedEntityCode)}`:'';
   const headerFilter=session&&session.headerCode?` and h.header_code=${dollar(session.headerCode)}`:'';
   const displayLimit=await getSeniorDisplayLimit(session||{});
   const branchCode=(session&&session.branchCode)||requestedBranchCode;
   const branchFilter=branchCode?` and (coalesce(b.branch_code,'')=${dollar(branchCode)} or coalesce(to_jsonb(e)->>'branch_name','') in (select name from ${dq(PGSCHEMA)}.care_branch where branch_code=${dollar(branchCode)}))`:'';
   const sql=`select coalesce(json_agg(row_to_json(t))::text,'[]') from (
     select
       e.entity_code,
       coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code) as name,
       e.entity_type,
       coalesce(b.name, to_jsonb(e)->>'branch_name') as branch_name,
       b.branch_code,
       coalesce(to_jsonb(e)->>'address_details', e.address_notes, e.access_details, concat_ws(', ', to_jsonb(e)->>'country', to_jsonb(e)->>'city', to_jsonb(e)->>'street', to_jsonb(e)->>'street_no')) as address_details,
       coalesce(to_jsonb(e)->>'responsible_name', e.notes, '') as responsible_name,
       coalesce(card_style.card_color,'') as card_color,
       coalesce(card_style.card_text_color,'') as card_text_color
     from ${dq(PGSCHEMA)}.managed_entity e
     left join ${dq(PGSCHEMA)}.care_branch b on b.id=e.care_branch_id
     left join ${dq(PGSCHEMA)}.care_header h on h.id=e.care_header_id
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
     where coalesce(e.active,true)=true${branchFilter}${headerFilter}${entityFilter}
     order by coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code)
     limit ${displayLimit||100}
   ) t;`;
   const out=await runPsql(sql); send(res,200,out||'[]','application/json; charset=utf-8'); return true;
  }
  if(url.pathname==='/api/treatment'){
   const session=getSeniorSession(req);
   const scopedEntityCode=SENIOR_ENTITY_CODE||'';
   const entityFilter=scopedEntityCode?` and e.entity_code=${dollar(scopedEntityCode)}`:'';
   const headerFilter=session&&session.headerCode?` and h.header_code=${dollar(session.headerCode)}`:'';
   const branchFilter=session&&session.branchCode?` and br.branch_code=${dollar(session.branchCode)}`:'';
   const sql=`select coalesce(json_agg(row_to_json(t))::text,'[]') from (select cs.id, cs.section_key, cs.task_type, cs.title, cs.description, cs.start_date, cs.end_date, cs.start_time, cs.recurrence_rule, cs.repeat_every_days, cs.active_weekdays, cs.escalation_minutes, cs.email_on_create, cs.email_on_finish, cs.email_recipients, cs.status, e.entity_code, coalesce(to_jsonb(e)->>'name', to_jsonb(e)->>'display_name', e.entity_code) as entity_name, br.branch_code, br.name as branch_name from ${dq(PGSCHEMA)}.calendar_series cs left join ${dq(PGSCHEMA)}.managed_entity e on e.id=cs.entity_id left join ${dq(PGSCHEMA)}.care_branch br on br.id=coalesce(cs.care_branch_id,e.care_branch_id) left join ${dq(PGSCHEMA)}.care_header h on h.id=coalesce(e.care_header_id,cs.care_header_id) where cs.section_key='treatment' and coalesce(cs.active,true)=true and lower(coalesce(cs.status,'active')) not in ('cancelled','canceled','anulat','anulată','anulata')${headerFilter}${branchFilter}${entityFilter} order by cs.start_time nulls last, cs.id desc) t;`;
   const out=await runPsql(sql); send(res,200,out||'[]','application/json; charset=utf-8'); return true;
  }
 }catch(e){send(res,500,e.message||'Database error'); return true}
 return false;
}
const requestHandler=async(req,res)=>{res.familyCareFrameAncestors=frameAncestorsFor(req);res.familyCareSecureRequest=requestIsSecure(req);const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!originAllowed(req)){send(res,403,'Origin not allowed');return}
  if(await handleSeniorLoginApi(req,res,url))return;
  if(url.pathname.startsWith('/api/')&&!authorizedSenior(req)){send(res,401,JSON.stringify({ok:false,error:'Sesiune expirată'}),'application/json; charset=utf-8');return}
  if(await handleSeniorSoundSettingsApi(req,res,url)) return;
  if(await handleSeniorDisplaySettingsApi(req,res,url)) return;
  if(await handleFamilyContactApi(req,res,url)) return;
  if(await handleTreatmentConfirmApi(req,res,url)) return; if(await handleTreatmentDecisionApi(req,res,url)) return; if(await handleBeneficiaryFeedbackApi(req,res,url)) return; if(await handleQuickActionApi(req,res,url)) return; if(await handleApi(req,res,url)) return;
  let pathname=decodeURIComponent(url.pathname);
  if(pathname==='/') pathname='/pages/senior-login.html';
  // V1.0.89: păstrează compatibilitatea cu linkurile vechi /senior.html sau /senior-login.html.
  // Senior trebuie să pornească mereu din login, apoi login-ul trimite către /pages/senior.html.
  if(['/senior.html','/senior-login.html','/login','/login.html'].includes(pathname)){
    send(res,302,'','text/plain; charset=utf-8',{'Location': SENIOR_AUTH_DISABLED ? '/pages/senior.html' : '/pages/senior-login.html','Cache-Control':'no-store'});
    return;
  }
  if (/\.(md|sql|txt|log|env|ya?ml)$/i.test(pathname) || pathname.includes('/tests/')) { send(res,404,'Not found'); return; }
  const publicStatic = pathname==='/pages/senior-login.html' || pathname==='/offline.html' || pathname==='/manifest.webmanifest' || pathname==='/service-worker.js' || pathname==='/app-universal.js' || pathname.startsWith('/assets/') || pathname.startsWith('/styles/');
  if(pathname==='/pages/senior-login.html' && !SENIOR_AUTH_DISABLED){
    const oldToken=cookies(req).fc_senior_session||''; if(oldToken) seniorSessions.delete(oldToken);
    res.setHeader('Set-Cookie', seniorCookie('',req,0));
  }
  if(!SENIOR_AUTH_DISABLED && !authorizedSenior(req) && !publicStatic){send(res,302,'','text/plain; charset=utf-8',{'Location':'/pages/senior-login.html','Cache-Control':'no-store'});return;}
  const file=path.resolve(ROOT,pathname.replace(/^[/\\]+/,''));
  const relative=path.relative(ROOT,file);
  if(relative.startsWith('..')||path.isAbsolute(relative)){send(res,403,'Forbidden'); return}
  fs.readFile(file,(err,data)=>{if(err){send(res,404,'Not found');return} send(res,200,data,MIME[path.extname(file).toLowerCase()]||'application/octet-stream')})

};
let server;
if(HTTPS_ENABLED){if(!fs.existsSync(TLS_PFX_PATH)){console.error('ERROR: HTTPS este activ, dar certificatul lipsește: '+TLS_PFX_PATH);process.exit(1)}server=https.createServer({pfx:fs.readFileSync(TLS_PFX_PATH),passphrase:TLS_PFX_PASSPHRASE},requestHandler)}else{server=http.createServer(requestHandler)}
server.on('error',err=>{if(err&&err.code==='EADDRINUSE')console.error('ERROR: Portul '+PORT+' este deja folosit. Oprește instanța existentă sau schimbă PORT.');else console.error('ERROR server:',err&&err.message?err.message:err);process.exitCode=1});
const PID_FILE=path.join(ROOT,'.familycare-senior.pid');try{fs.writeFileSync(PID_FILE,String(process.pid),'utf8')}catch(_){}function removePidFile(){try{if(fs.existsSync(PID_FILE)&&fs.readFileSync(PID_FILE,'utf8').trim()===String(process.pid))fs.unlinkSync(PID_FILE)}catch(_){}}function shutdown(){server.close(()=>process.exit(0));if(typeof server.closeAllConnections==='function')server.closeAllConnections();setTimeout(()=>process.exit(0),1500).unref()}process.on('exit',removePidFile);process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
server.listen(PORT,HOST,()=>{console.log('============================================================');console.log('FamilyCare Senior V1.0.89 is running');console.log('URL: '+PROTOCOL+'://localhost:'+PORT+(SENIOR_AUTH_DISABLED?'/pages/senior.html':'/pages/senior-login.html'));console.log('Senior authentication: '+(SENIOR_AUTH_DISABLED?'disabled for testing':'user login required'));console.log('Database: '+(process.env.PGDATABASE||'(default)')+' / schema '+PGSCHEMA);console.log('DB mode: '+(process.env.DATABASE_URL?'DATABASE_URL / pg':'local psql'));console.log('Privacy mode: '+(SENIOR_ENTITY_CODE?'single beneficiary '+SENIOR_ENTITY_CODE:'family / multiple beneficiaries'));if(MAIN_BASE_URL)console.log('Main URL: '+MAIN_BASE_URL);console.log('Press CTRL+C in this window to stop the server.');console.log('============================================================')});
