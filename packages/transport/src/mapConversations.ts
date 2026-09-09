/** Bound per-conversation SDK reads while preserving inbox order. */
export async function mapConversations<T, R>(values: T[], map: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { results[index] = await map(values[index]); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  };
  // Drain active reads before reporting failure so a retry cannot overlap them.
  await Promise.all(Array.from({ length: Math.min(8, values.length) }, worker));
  if (failed) throw failure;
  return results;
}
