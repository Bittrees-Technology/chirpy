import {publicProfileConfig,createPublicProfiles,verifyProfileSignature} from '../server/public-profile.js';
import {profileAddress} from '../packages/core/src/publicProfile.js';
import {syncCors} from '../server/sync-cors.js';
import {checkRateLimit} from '../server/server-utils.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const config=publicProfileConfig();if(!config)return res.status(503).json({enabled:false,error:'Public profiles are unavailable.'});
 const cors=syncCors(req,res,{service:config.service,allowedOrigins:[process.env.CHIRPY_SYNC_ALLOWED_ORIGINS,process.env.CHIRPY_SYNC_MIGRATION_ORIGINS].filter(Boolean).join(',')});
 if(cors)return res.status(cors.status).json(cors.body);
 if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST, OPTIONS');return res.status(405).json({error:'Method not allowed.'});}
 if(!checkRateLimit(req,'/api/profile').allowed)return res.status(429).json({error:'Too many requests.'});
 try{
  const profiles=createPublicProfiles(config);
  if(req.method==='GET'){
   const wallets=typeof req.query?.wallet==='string'&&req.query.wallet.length<=2149?req.query.wallet.split(','):[];
   if(!wallets.length||wallets.length>50||!wallets.every(profileAddress)||new Set(wallets).size!==wallets.length||Object.keys(req.query).length!==1)return res.status(400).json({error:'Use up to 50 unique wallet addresses.'});
   return res.status(200).json({service:config.service,profiles:await profiles.readMany(wallets)});
  }
  if(String(req.headers?.['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')return res.status(415).json({error:'Use application/json.'});
  if(Buffer.byteLength(JSON.stringify(req.body??{}))>12000)return res.status(413).json({error:'Profile request is too large.'});
  if(!req.body||Object.keys(req.body).sort().join(',')!=='command,signature'||!await verifyProfileSignature(config,req.body.command,req.body.signature))return res.status(401).json({error:'Invalid or expired profile authorization.'});
  const result=await profiles.write(req.body.command);
  return res.status({saved:200,conflict:409,expired:401}[result.status]).json({service:config.service,...result});
 }catch{return res.status(503).json({error:'Public profiles are unavailable. Reload the current profile before retrying.'});}
}
