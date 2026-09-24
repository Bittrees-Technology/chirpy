import {createServer} from 'node:net';
import {TLSSocket,createSecureContext} from 'node:tls';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

// Private, synthetic SMTP endpoint; no external DNS, credentials or mail delivery.
export async function smtpFixture(){
 const directory=mkdtempSync(join(tmpdir(),'chat-smtp-wire-')),cert=join(directory,'ca.pem'),key=join(directory,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=smtp.test','-addext','subjectAltName=DNS:smtp.test'],{stdio:'ignore'});
 const context=createSecureContext({cert:readFileSync(cert),key:readFileSync(key)}),sockets=new Set<any>();
 const state={mode:'accept',connections:0,envelopes:0,auth:0,plaintextAuth:0,messages:[] as string[],rcpt:[] as string[]};
 function attach(socket:any,secure=false){
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  let buffer='',data=false,body='';
  const onData=(chunk:Buffer)=>{
   buffer+=chunk.toString();let end;
   while((end=buffer.indexOf('\r\n'))!==-1){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
    if(data){
     if(line==='.'){
      state.messages.push(body);body='';data=false;
      if(state.mode==='drop-ack'){socket.destroy();return;}
      if(state.mode==='hang-ack')return;
      socket.write(state.mode==='data450'?'450 4.3.0 Try later\r\n':state.mode==='data550'?'550 5.7.0 Rejected\r\n':'250 2.0.0 Queued synthetic\r\n');
     }else body+=(line.startsWith('..')?line.slice(1):line)+'\r\n';
    }else if(line.startsWith('EHLO'))socket.write(secure?'250-smtp.test\r\n250 AUTH PLAIN\r\n':state.mode==='no-tls'?'250 smtp.test\r\n':'250-smtp.test\r\n250 STARTTLS\r\n');
    else if(line==='STARTTLS'){
     if(state.mode==='no-tls'){socket.write('454 4.7.0 TLS unavailable\r\n');continue;}
     socket.removeListener('data',onData);socket.write('220 Upgrade\r\n');const tls=new TLSSocket(socket,{isServer:true,secureContext:context});attach(tls,true);return;
    }else if(line.startsWith('AUTH')){state.auth++;if(!secure)state.plaintextAuth++;socket.write(state.mode==='auth-denied'?'535 5.7.8 Denied\r\n':'235 2.7.0 Authenticated\r\n');}
    else if(line.startsWith('MAIL FROM:')){state.envelopes++;socket.write('250 2.1.0 Sender OK\r\n');}
    else if(line.startsWith('RCPT TO:')){state.rcpt.push(line);socket.write(state.mode==='rcpt450'?'450 4.2.0 Try later\r\n':state.mode==='rcpt550'?'550 5.1.1 No mailbox\r\n':'250 2.1.5 Recipient OK\r\n');}
    else if(line==='DATA'){data=true;socket.write('354 End with dot\r\n');}
    else if(line==='QUIT'){socket.end('221 Goodbye\r\n');}
    else socket.write('500 Unsupported\r\n');
   }
  };
  socket.on('data',onData);
 }
 const server=createServer(socket=>{state.connections++;attach(socket);socket.write('220 smtp.test\r\n');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {directory,cert,state,port:(server.address() as any).port,async close(){for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});}};
}
