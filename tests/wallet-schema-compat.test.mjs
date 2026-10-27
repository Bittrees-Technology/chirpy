import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const installed=resolve('node_modules/.pnpm');
const wallet=readdirSync(installed).find(p=>p.startsWith('@reown+appkit-wallet@'));
assert.ok(wallet,'wallet package installed');
const schema=await import(pathToFileURL(resolve(installed,wallet,'node_modules/@reown/appkit-wallet/dist/esm/src/W3mFrameSchema.js')));
test('wallet frame validation retains valid network, sign-in and theme messages with patched Zod',()=>{
 const message={accountAddress:'0x'+'1'.repeat(40),chainId:'eip155:1',domain:'chat.bittrees.org',uri:'https://chat.bittrees.org',version:'1',nonce:'synthetic-test'};
 assert.equal(schema.SIWXMessage.safeParse(message).success,true);
 assert.equal(schema.SIWXMessage.safeParse({...message,resources:['https://chat.bittrees.org']}).success,true);
 assert.equal(schema.AppConnectEmailRequest.safeParse({email:'member@example.org'}).success,true);
 assert.equal(schema.AppSyncThemeRequest.safeParse({themeMode:'dark',themeVariables:{'--color':'orange','--size':12},w3mThemeVariables:{'--color':'orange'}}).success,true);
});
test('wallet frame validation continues to reject malformed identity and theme payloads',()=>{
 for(const input of [null,{}, {accountAddress:42}, {accountAddress:'0x'+'1'.repeat(40),chainId:1}])assert.equal(schema.SIWXMessage.safeParse(input).success,false);
 assert.equal(schema.AppConnectEmailRequest.safeParse({email:'not-an-email'}).success,false);
 assert.equal(schema.AppSyncThemeRequest.safeParse({themeVariables:{color:{unexpected:true}}}).success,false);
});
