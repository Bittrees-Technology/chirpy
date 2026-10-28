import { privateKeyToAccount } from 'viem/accounts';
import { readGateStorageConfig, validGatekeeperAddress, validGatekeeperKey } from './gate-config.js';

// Resume needs only the recorded public identity and database key. Legacy secret
// configuration remains compatible, but conflicting/invalid inputs never win.
export function readGateResumeConfig(env = process.env) {
  const supplied = env.XMTP_GATEKEEPER_ADDRESS;
  const privateKey = env.XMTP_GATEKEEPER_PRIVATE_KEY;
  if (supplied !== undefined && supplied !== '' && !validGatekeeperAddress(supplied)) throw new Error('A valid gatekeeper public address is required.');
  let derived;
  if (privateKey !== undefined && privateKey !== '') {
    if (!validGatekeeperKey(privateKey)) throw new Error('Invalid legacy gatekeeper signing key.');
    derived = privateKeyToAccount(privateKey).address.toLowerCase();
  }
  const address = supplied ? supplied.toLowerCase() : derived;
  if (!address || (derived && address !== derived)) throw new Error('Gatekeeper public identity is missing or conflicts with the signing key.');
  return { address, ...readGateStorageConfig(env) };
}
