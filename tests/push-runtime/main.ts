import { PushRoomSession, type PushSigner } from '../../packages/transport/src/pushSession';
import { PushAPI } from '../../packages/transport/node_modules/@pushprotocol/restapi';
import { Signer } from '../../packages/transport/node_modules/@pushprotocol/restapi/src/lib/helpers/signer';
import { getUUID } from '../../packages/transport/node_modules/@pushprotocol/restapi/src/lib/payloads/helpers';
import { PGPHelper } from '../../packages/transport/node_modules/@pushprotocol/restapi/src/lib/chat/helpers/pgp';
import { decryptPGPKey } from '../../packages/transport/node_modules/@pushprotocol/restapi/src/lib/helpers/crypto';
const owner = `0x${'1'.repeat(40)}`;
(window as any).runPushCompatibility = async () => {
  const originalStorage = { ...localStorage };
  const keys = await PGPHelper.generateKeyPair();
  (window as any).mockPushUser = { did: `eip155:${owner}`, wallets: `eip155:${owner}`, publicKey: keys.publicKeyArmored,
    encryptedPrivateKey: JSON.stringify({ version: 'x25519-xsalsa20-poly1305' }), profile: { name: 'Synthetic', desc: '', picture: '' } };
  const cipherText = await PGPHelper.pgpEncrypt({ plainText: 'Synthetic room message', keys: [keys.publicKeyArmored] });
  const decrypted = await PGPHelper.pgpDecrypt({ cipherText, toPrivateKeyArmored: keys.privateKeyArmored });
  const signatureArmored = await PGPHelper.sign({ message: decrypted, signingKey: keys.privateKeyArmored });
  await PGPHelper.verifySignature({ messageContent: decrypted, signatureArmored, publicKeyArmored: keys.publicKeyArmored });
  let tamperedRejected = false;
  try { await PGPHelper.verifySignature({ messageContent: 'Altered', signatureArmored, publicKeyArmored: keys.publicKeyArmored }); } catch { tamperedRejected = true; }
  const requests: string[] = []; let current = true; let captured!: PushSigner;
  const provider = { on() {}, removeListener() {}, async request({ method }: { method: string }) { requests.push(method); if (method === 'eth_accounts') return [owner]; if (method === 'eth_chainId') return '0x1'; if (method === 'eth_decrypt') return keys.privateKeyArmored; if (method === 'personal_sign' || method === 'eth_signTypedData_v4') return `0x${'a'.repeat(130)}`; throw new Error('Unexpected signing method'); } };
  const session = new PushRoomSession(owner, provider, () => current, async signer => {
    captured = signer;
    const sdkSigner = new Signer(signer);
    await sdkSigner.signMessage('Synthetic Push recovery');
    await sdkSigner.signTypedData({ name: 'Push Test', version: '1', chainId: 1 }, { Data: [{ name: 'content', type: 'string' }] }, { content: 'Synthetic' }, 'Data');
    const action = async () => ({ ok: true });
    return { account: owner, decryptedPgpPvtKey: keys.privateKeyArmored, chat: { history: action, send: action, group: { info: action, join: action, leave: action, permissions: action, add: action, remove: action, participants: { status: action, list: action } } } };
  });
  const client = await session.enable(); await client.history('synthetic-room');
  let wrongProviderCalls = 0;
  (window as any).ethereum = { request: async () => { wrongProviderCalls++; throw new Error('Wrong wallet'); } };
  const recovered = await decryptPGPKey({ encryptedPGPPrivateKey: JSON.stringify({ version: 'x25519-xsalsa20-poly1305' }), account: owner, signer: captured, toUpgrade: false });
  const realRuntime = new PushRoomSession(owner, provider, () => current);
  await realRuntime.enable();
  const realRuntimeReady = realRuntime.getSnapshot().status === 'ready';
  realRuntime.dispose();
  delete (window as any).ethereum;
  session.dispose(); current = false;
  let staleRejected = false;
  try { await captured.signMessage({ message: 'After disposal' }); } catch { staleRejected = true; }
  return { realRuntimeReady, sdkLoaded: typeof PushAPI.initialize === 'function', uuid: getUUID(), decrypted, tamperedRejected, staleRejected,
    legacyRecoveryBound: recovered === keys.privateKeyArmored && wrongProviderCalls === 0, personalSigned: requests.includes('personal_sign'), typedSigned: requests.includes('eth_signTypedData_v4'), storageUnchanged: JSON.stringify(originalStorage) === JSON.stringify({ ...localStorage }) };
};
document.body.textContent = 'Push runtime ready';
