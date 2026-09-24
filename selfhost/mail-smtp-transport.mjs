import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isIP} from 'node:net';
import {isAbsolute} from 'node:path';
import {createHmac,X509Certificate} from 'node:crypto';
import {openSmtpJournal} from './mail-smtp-journal.mjs';

const invalid=()=>{throw Error('Invalid private SMTP configuration');};
export async function readSmtpSettings(env,config){
  // First deployment is a same-host Acer relay, with explicit certificate identity.
  const host=env.CHAT_SMTP_HOST,port=Number(env.CHAT_SMTP_PORT||25),servername=env.CHAT_SMTP_TLS_SERVERNAME;
  if(!['127.0.0.1','::1'].includes(host)||!Number.isInteger(port)||port<1||port>65535||typeof servername!=='string'||isIP(servername)||servername.length>253||!servername.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))invalid();
  if(!!env.CHAT_SMTP_USER!==!!env.CHAT_SMTP_PASSWORD)invalid();
  const filename=env.CHAT_SMTP_TLS_CA_FILE;
  if(typeof filename!=='string'||!isAbsolute(filename))invalid();
  const file=await open(filename,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
  let ca;
  try{
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>65536||stat.mode&0o022||process.getuid&&![0,process.getuid()].includes(stat.uid))invalid();
    const bytes=Buffer.alloc(65537);let length=0;
    while(length<bytes.length){const result=await file.read(bytes,length,bytes.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
    if(length>65536)invalid();ca=bytes.subarray(0,length).toString('utf8');
    if(!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(ca))invalid();
  }finally{await file.close();}
  const cert=new X509Certificate(ca);
  const journalId=env.CHAT_SMTP_JOURNAL_ID,key=env.CHAT_SMTP_JOURNAL_KEY;
  if(typeof journalId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(journalId)||!/^[a-f0-9]{64}$/.test(key||'')||!Buffer.isBuffer(config.key)||config.key.length!==32)invalid();
  // No credentials are exported to Vercel: the opaque profile pins all effective settings.
  const profile=createHmac('sha256',config.key).update(JSON.stringify(['Chat private SMTP v1',config.service,config.from,host,port,servername,cert.fingerprint256,env.CHAT_SMTP_USER||'',env.CHAT_SMTP_PASSWORD||'',journalId,key])).digest('hex');
  return {profile,journal:{filename:env.CHAT_SMTP_JOURNAL_FILE,key,journalId},options:{host,port,secure:port===465,requireTLS:port!==465,
    name:'chat-worker',connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,dnsTimeout:5000,
    tls:{servername,ca,rejectUnauthorized:true,minVersion:'TLSv1.2'},logger:false,debug:false},
    auth:env.CHAT_SMTP_USER?{user:env.CHAT_SMTP_USER,pass:env.CHAT_SMTP_PASSWORD}:null};
}

// Callback errors are not generally proof of nonacceptance. Only a protocol
// negative response to our single-recipient transaction proves that SMTP refused it.
function refusal(error){
  if(error&&['MAIL FROM','RCPT TO','DATA'].includes(error.command)&&['EENVELOPE','EMESSAGE'].includes(error.code)&&
    Number.isInteger(error.responseCode)&&error.responseCode>=400&&error.responseCode<=599&&
    typeof error.response==='string'&&error.response.startsWith(String(error.responseCode)+' '))
    return {status:error.responseCode<500?'retryable':'rejected',definitiveNoAcceptance:true};
  return {status:'uncertain'};
}
function smtpSession(settings,signal){
  const connection=new SMTPConnection(settings.options);let failure=null,pending=null,closed=false;
  const fail=error=>{failure=error||Error('SMTP disconnected');pending?.(failure);};
  const abort=()=>{fail(Error('SMTP deadline'));connection.close();};
  connection.on('error',fail);connection.on('end',()=>fail(Error('SMTP disconnected')));
  signal.addEventListener('abort',abort,{once:true});
  const operation=invoke=>new Promise((resolve,reject)=>{
    if(failure||closed||signal.aborted)return reject(Error('SMTP unavailable'));
    pending=reject;
    try{invoke((error,result)=>{pending=null;if(error)reject(error);else resolve(result);});}catch(error){pending=null;reject(error);}
  });
  return {
    async prepare(){
      await operation(callback=>connection.connect(callback));
      if(!connection.secure)throw Error('SMTP encryption required');
      if(settings.auth)await operation(callback=>connection.login(settings.auth,callback));
    },
    async send(payload){
      // Local composition cannot submit anything and cannot access URLs/files.
      const message=await new MailComposer({...payload,disableFileAccess:true,disableUrlAccess:true}).compile().build();
      if(failure||closed||signal.aborted)return {status:'retryable',definitiveNoAcceptance:true};
      try{
        const result=await operation(callback=>connection.send({from:payload.from,to:payload.to},message,callback));
        return result&&Array.isArray(result.accepted)&&result.accepted.length===1&&result.accepted[0]===payload.to[0]&&
          Array.isArray(result.rejected)&&result.rejected.length===0&&typeof result.response==='string'&&/^250 /.test(result.response)?{status:'accepted'}:{status:'uncertain'};
      }catch(error){return refusal(error);}
    },
    close(){closed=true;signal.removeEventListener('abort',abort);connection.close();},
  };
}
export async function createSmtpAdapter(env,config){
  const settings=await readSmtpSettings(env,config);
  if(config.provider!=='smtp'||settings.profile!==config.smtpProfile)invalid();
  const journal=openSmtpJournal(settings.journal);
  return {
    profile:settings.profile,
    check:()=>journal.check(),summary:()=>journal.summary(),pending:options=>journal.pending(options),reference:command=>journal.reference(command),recover:reference=>journal.recover(reference),
    async submit(command,authorize){
      if(command.payload?.from!==config.from)invalid();
      const known=journal.inspect(command);
      if(!['unknown','retryable'].includes(known.status))return known;
      const signal=AbortSignal.timeout(40000),session=smtpSession(settings,signal);
      try{
        // TLS and authentication precede authorization and the durable send boundary.
        // A preflight failure cannot have submitted an envelope or DATA.
        try{await session.prepare();}catch{
          const recovered=journal.inspect(command);
          return ['unknown','retryable'].includes(recovered.status)?{status:'retryable'}:recovered;
        }
        return await journal.submit(command,{authorize,send:payload=>session.send(payload),signal});
      }finally{session.close();}
    },
    close:()=>journal.close(),
  };
}
