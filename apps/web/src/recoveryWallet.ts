import { createPublicClient, http, recoverMessageAddress, toHex, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { getActiveProvider } from './walletProviders';

/** One operation, not a reusable login, sync grant or stored signing secret. */
export async function verifyRecoveryWallet(wallet: string, ensureCurrent: () => void, purpose: 'export' | 'restore' = 'export') {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Invalid recovery wallet');
  const address = wallet.toLowerCase() as Hex;
  const provider = getActiveProvider();
  if (!provider) throw new Error('Connect a wallet to export local data');
  const expiresAt = Date.now() + 120_000;
  let invalidated = false;
  let disposed = false;
  const invalidate = () => { invalidated = true; };
  provider.on?.('accountsChanged', invalidate);
  provider.on?.('disconnect', invalidate);
  provider.on?.('session_delete', invalidate);
  const dispose = () => {
    disposed = true;
    provider.removeListener?.('accountsChanged', invalidate);
    provider.removeListener?.('disconnect', invalidate);
    provider.removeListener?.('session_delete', invalidate);
  };
  const check = () => {
    ensureCurrent();
    if (disposed || invalidated || getActiveProvider() !== provider || Date.now() >= expiresAt) {
      throw new Error('Recovery session changed or expired');
    }
  };
  const ask = async (args: Parameters<typeof provider.request>[0]) => {
    check();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Recovery session changed or expired')), Math.max(0, expiresAt - Date.now()));
    });
    try { return await Promise.race([provider.request(args), deadline]); }
    finally { clearTimeout(timeout); }
  };
  const currentChain = async () => {
    check();
    const accounts = await ask({ method: 'eth_accounts' });
    check();
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== address) {
      throw new Error('Recovery wallet changed');
    }
    const chain = await ask({ method: 'eth_chainId' });
    check();
    if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(chain)) throw new Error('Invalid wallet chain');
    return BigInt(chain);
  };
  try {
    const chain = await currentChain();
    const assertCurrent = async () => {
      if (await currentChain() !== chain) throw new Error('Recovery wallet chain changed');
    };
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const message = `Chat local data ${purpose}\nWallet: ${address}\nOrigin: ${window.location.origin}\nChain: ${chain}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\nProve control for one local data ${purpose}. This does not authorize messages, transactions, or account access.`;
    const signature = await ask({ method: 'personal_sign', params: [toHex(message), wallet] });
    await assertCurrent();
    if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){1,32768}$/.test(signature)) throw new Error('Invalid ownership signature');
    let valid = false;
    try { valid = (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase() === address; }
    catch { /* Contract signatures are checked on the supported chain below. */ }
    if (!valid) {
      if (chain !== 1n) throw new Error('Contract wallet recovery requires Ethereum mainnet');
      const client = createPublicClient({ chain: mainnet,
        transport: http(import.meta.env.VITE_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com', { timeout: 10_000, retryCount: 0 }) });
      valid = await client.verifyMessage({ address, message, signature: signature as Hex });
    }
    await assertCurrent();
    if (!valid) throw new Error('Wallet ownership could not be verified');
    return { assertCurrent, assertSession: check, dispose };
  } catch (error) { dispose(); throw error; }
}
