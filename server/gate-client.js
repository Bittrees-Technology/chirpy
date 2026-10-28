import { privateKeyToAccount } from 'viem/accounts';
import { readGateClientConfig } from './gate-config.js';
import { gateDatabasePath, readGateInstallation, requireRegisteredGate, reserveGateRegistration, sealGateInstallation } from './gate-storage.js';

const defaultSdk = () => import('@xmtp/node-sdk');
function identity(config) {
  const account = privateKeyToAccount(config.privateKey);
  return { account, address: account.address.toLowerCase() };
}
function options(config, directory, LogLevel, receipt) {
  return {
    env: config.network, loggingLevel: LogLevel.Off, dbEncryptionKey: config.databaseKey, disableAutoRegister: true,
    dbPath: inboxId => {
      if (receipt && inboxId !== receipt.inboxId) throw new Error('Gate inbox differs from the accepted installation.');
      return gateDatabasePath(directory, inboxId, { mustExist: Boolean(receipt) });
    },
  };
}
export function createGateClientGetter({ env = process.env, loadSdk = defaultSdk } = {}) {
  let clientPromise;
  return function getClient() {
    if (!clientPromise) clientPromise = (async () => {
      const config = readGateClientConfig(env);
      const { address } = identity(config);
      const { directory, receipt } = await readGateInstallation(config, address);
      const { Client, IdentifierKind, LogLevel } = await loadSdk();
      // build has no wallet signer and cannot silently register a replacement.
      const client = await Client.build({ identifier: address, identifierKind: IdentifierKind.Ethereum }, options(config, directory, LogLevel, receipt));
      requireRegisteredGate(client, receipt);
      return client;
    })().catch(error => { clientPromise = undefined; throw error; });
    return clientPromise;
  };
}
// Deliberate operator provisioning only. Never call from health/admission/startup.
export async function provisionGateInstallation({ env = process.env, loadSdk = defaultSdk } = {}) {
  const config = readGateClientConfig(env);
  const { account, address } = identity(config);
  const directory = await reserveGateRegistration(config, address);
  const { Client, IdentifierKind, LogLevel } = await loadSdk();
  const client = await Client.create({
    type: 'EOA', getIdentifier: () => ({ identifier: address, identifierKind: IdentifierKind.Ethereum }),
    signMessage: async message => new Uint8Array(Buffer.from((await account.signMessage({ message })).slice(2), 'hex')),
  }, options(config, directory, LogLevel));
  if (!client.isRegistered) await client.register();
  await sealGateInstallation(directory, config, address, client);
  return client;
}
export const getGatekeeperClient = createGateClientGetter();
