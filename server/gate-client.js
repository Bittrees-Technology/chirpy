import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { readGateClientConfig } from './gate-config.js';

export function createGateClientGetter({ env = process.env, loadSdk = () => import('@xmtp/node-sdk') } = {}) {
  let clientPromise;
  return function getClient() {
    if (!clientPromise) clientPromise = (async () => {
      const config = readGateClientConfig(env);
      await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
      const { Client, IdentifierKind, LogLevel } = await loadSdk();
      const account = privateKeyToAccount(config.privateKey);
      const client = await Client.create({
        type: 'EOA',
        getIdentifier: () => ({ identifier: account.address.toLowerCase(), identifierKind: IdentifierKind.Ethereum }),
        signMessage: async message => new Uint8Array(Buffer.from((await account.signMessage({ message })).slice(2), 'hex')),
      }, {
        env: config.network, loggingLevel: LogLevel.Off, dbEncryptionKey: config.databaseKey,
        dbPath: inboxId => {
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(inboxId)) throw new Error('Invalid gate inbox identifier.');
          return join(config.dataDir, `chirpy-xmtp-gatekeeper-${inboxId}.db3`);
        },
      });
      if (!client.isRegistered) await client.register();
      return client;
    })().catch(error => { clientPromise = undefined; throw error; });
    return clientPromise;
  };
}
export const getGatekeeperClient = createGateClientGetter();
