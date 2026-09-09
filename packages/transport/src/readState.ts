/** Read cursors are local to this wallet/network/device; they are not receipts. */
export class ReadState {
  private memory = new Map<string, bigint>();
  constructor(private scope: string) {}
  private key(id: string) { return `chirpy.read.v1:${this.scope}:${id}`; }
  get(id: string): bigint {
    let stored = 0n;
    try {
      const raw = localStorage.getItem(this.key(id));
      if (raw && /^\d{1,30}$/.test(raw)) stored = BigInt(raw);
    } catch { /* Memory still works when storage is disabled. */ }
    const memory = this.memory.get(id) ?? 0n;
    return stored > memory ? stored : memory;
  }
  advance(id: string, cursor: bigint): boolean {
    if (cursor <= this.get(id)) return false;
    this.memory.set(id, cursor);
    try { localStorage.setItem(this.key(id), String(cursor)); } catch { /* Keep in memory. */ }
    return true;
  }
}
