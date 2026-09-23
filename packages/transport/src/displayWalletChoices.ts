import { profileAddress } from '../../core/src/publicProfile.js';
import { validDisplayWalletRecord, type DisplayNetwork, type DisplayWalletRecord } from '../../core/src/displayWallet.js';
export type DisplayWalletReader = (network: DisplayNetwork, wallets: string[]) => Promise<DisplayWalletRecord[]>;
/** Per-client, bounded public-preference cache. Slow calls retain their slot until
 * settled; a short display deadline never allows polling to multiply network work. */
export class DisplayWalletChoices {
  private cache = new Map<string, { at: number; value?: DisplayWalletRecord }>();
  private pending = new Map<string, Promise<DisplayWalletRecord | undefined>>();
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private read: DisplayWalletReader, private network: DisplayNetwork, private now = Date.now) {}
  private schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => { this.queue.push(() => { this.active++; void task().then(resolve, reject).finally(() => { this.active--; this.drain(); }); }); this.drain(); });
  }
  private drain() { while (this.active < 4 && this.queue.length) this.queue.shift()!(); }
  async resolve(wallets: Iterable<string>): Promise<Map<string, DisplayWalletRecord>> {
    const ids = new Set<string>(); let scanned = 0;
    for (const wallet of wallets) { if (++scanned > 5000 || ids.size >= 2500) break; if (profileAddress(wallet)) ids.add(wallet); }
    const reads = new Map<string, Promise<DisplayWalletRecord | undefined>>(), missing: string[] = [];
    for (const id of ids) {
      const cached = this.cache.get(id), now = this.now();
      if (cached && now >= cached.at && now - cached.at < (cached.value ? 30000 : 5000)) { this.cache.delete(id); this.cache.set(id, cached); reads.set(id, Promise.resolve(cached.value)); }
      else { this.cache.delete(id); const pending = this.pending.get(id); if (pending) reads.set(id, pending); else if (this.pending.size + missing.length < 2500) missing.push(id); }
    }
    for (let offset = 0; offset < missing.length; offset += 50) {
      const batch = missing.slice(offset, offset + 50);
      const request = this.schedule(async () => {
        try {
          const records = await this.read(this.network, batch);
          if (records.length !== batch.length || !records.every((record, i) => validDisplayWalletRecord(record, batch[i], this.network))) return new Map<string, DisplayWalletRecord>();
          return new Map(records.map(record => [record.wallet, record]));
        } catch { return new Map<string, DisplayWalletRecord>(); }
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quick = Promise.race([request, new Promise<Map<string, DisplayWalletRecord>>(resolve => { timer = setTimeout(() => resolve(new Map()), 2000); })]).finally(() => clearTimeout(timer));
      for (const id of batch) {
        const result = quick.then(records => records.get(id)); this.pending.set(id, result); reads.set(id, result);
        void request.then(records => {
          this.cache.delete(id); this.cache.set(id, { at: this.now(), value: records.get(id) });
          while (this.cache.size > 2500) this.cache.delete(this.cache.keys().next().value!);
          if (this.pending.get(id) === result) this.pending.delete(id);
        });
      }
    }
    const result = new Map<string, DisplayWalletRecord>();
    await Promise.all([...reads].map(async ([id, read]) => { const record = await read; if (record) result.set(id, record); }));
    return result;
  }
}
