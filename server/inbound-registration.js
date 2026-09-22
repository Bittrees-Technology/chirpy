// Trusted registration child core. This API creates only a fresh dedicated identity.
import {join} from 'node:path';
import {readdirSync} from 'node:fs';
import {readInboundSenderConfig} from './inbound-sender-config.js';
import {writePrivateNew,syncPrivateDirectory} from './inbound-provisioning.js';
export async function registerInboundIdentity(stage,{loadSdk=()=>import('@xmtp/node-sdk'),loadAccounts=()=>import('viem/accounts')}={}){
 syncPrivateDirectory(stage);
 const config=readInboundSenderConfig(join(stage,'registration.json'));
 if(!config||Object.keys(config).length!==3||!['dev','production'].includes(config.network)||!/^0x[a-f0-9]{64}$/.test(config.privateKey||'')||!/^[a-f0-9]{64}$/.test(config.databaseKey||''))throw Error('Invalid registration configuration');
 const directory=join(stage,'sdk');syncPrivateDirectory(directory);
 if(readdirSync(directory).length!==0)throw Error('Registration requires an empty dedicated database directory');
 // Fsynced exclusive claim precedes every native load or network operation.
 writePrivateNew(join(stage,'registration-started.json'),{version:1});
 const accounts=await loadAccounts(),account=accounts.privateKeyToAccount(config.privateKey),sdk=await loadSdk();
 const address=account.address.toLowerCase();
 const identifier={identifier:address,identifierKind:sdk.IdentifierKind.Ethereum};
 const signer={type:'EOA',getIdentifier:()=>identifier,signMessage:async message=>Buffer.from((await account.signMessage({message})).slice(2),'hex')};
 const client=await sdk.Client.create(signer,{env:config.network,dbPath:join(directory,'xmtp.db3'),dbEncryptionKey:Buffer.from(config.databaseKey,'hex'),disableDeviceSync:true,loggingLevel:sdk.LogLevel.Off});
 if(!client.isRegistered||!/^[a-f0-9]{64}$/.test(client.inboxId)||!/^[a-f0-9]{64}$/.test(client.installationId)||
  await client.fetchInboxIdByIdentifier(identifier)!==client.inboxId||(await client.conversations.list({limit:1})).length!==0)throw Error('Fresh registration could not be verified');
 return {address,inboxId:client.inboxId,installationId:client.installationId};
}
