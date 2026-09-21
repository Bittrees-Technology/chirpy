// Keep the capability in memory only; remove it before any optional interaction.
const token=/^#token=([a-f0-9]{64})$/.exec(location.hash)?.[1];
history.replaceState(null,'',location.pathname);
const language=document.getElementById('language');
const button=document.getElementById('confirm');
let state=token?'ready':'invalid';
const words={
  en:{title:'Chat email preferences',heading:'Stop Chat email',explanation:'Confirm to stop future Chat email to this address from all wallets. This does not recall email already sent or change your wallet chats.',button:'Stop future email',privacy:'No wallet connection or sign-in is required. Anyone with this private link can stop email to its recipient.',ready:'Opening this page has not changed your preference.',invalid:'This link is missing or no longer available. Reopen the complete link from your email.',pending:'Confirming your preference…',success:'Future Chat email to this address is stopped. Messages already handed off may still arrive.',error:'The change could not be confirmed. Please try again.',limited:'Please wait a moment, then try again.'},
  es:{title:'Preferencias de correo de Chat',heading:'Dejar de recibir correos de Chat',explanation:'Confirma para dejar de recibir correos de Chat de cualquier billetera en esta dirección. Esto no retira correos ya enviados ni cambia tus chats de billetera.',button:'Dejar de recibir correos',privacy:'No necesitas conectar una billetera ni iniciar sesión. Cualquier persona con este enlace privado puede detener los correos a su destinatario.',ready:'Abrir esta página no ha cambiado tu preferencia.',invalid:'Este enlace falta o ya no está disponible. Vuelve a abrir el enlace completo de tu correo.',pending:'Confirmando tu preferencia…',success:'Se han detenido los futuros correos de Chat a esta dirección. Los mensajes ya entregados al proveedor aún pueden llegar.',error:'No se pudo confirmar el cambio. Inténtalo de nuevo.',limited:'Espera un momento e inténtalo de nuevo.'}
};
language.value=navigator.language.toLowerCase().startsWith('es')?'es':'en';
function render(){
  const text=words[language.value]||words.en;document.documentElement.lang=language.value;document.title=text.title;
  for(const id of ['heading','explanation','privacy'])document.getElementById(id).textContent=text[id];
  button.textContent=text.button;button.disabled=['invalid','pending','success'].includes(state);
  document.getElementById('status').textContent=text[state];
}
language.addEventListener('change',render);
button.addEventListener('click',async()=>{
  if(!token || ['invalid','pending','success'].includes(state))return;
  state='pending';render();
  try{
    const response=await fetch('/api/mail-optout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});
    if(response.status===404)state='invalid';else if(response.status===429)state='limited';
    else if(response.ok && (await response.json()).status==='opted-out')state='success';else state='error';
  }catch{state='error';}
  render();
});
render();
