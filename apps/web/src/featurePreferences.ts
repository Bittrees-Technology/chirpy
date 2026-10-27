import { useState, useSyncExternalStore } from 'react';

export const optionalSections = ['rooms', 'mail', 'routes', 'forum'] as const;
export type OptionalSection = typeof optionalSections[number];
export type SectionPreferences = Record<OptionalSection, boolean>;
const defaults = (): SectionPreferences => ({ rooms: false, mail: false, routes: false, forum: false });
const changed = 'chat:sections-changed';
export const sectionPreferencesKey = (address: string, mode: string) => `chat:sections:v1:${mode}:${address.toLowerCase()}`;
export function parseSectionPreferences(raw: string | null): SectionPreferences {
  if (raw === null) return defaults();
  if (raw.length > 1024) throw Error('Invalid section preferences');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !optionalSections.includes(key as OptionalSection))
    || Object.values(value).some(value => typeof value !== 'boolean')) throw Error('Invalid section preferences');
  return { ...defaults(), ...value };
}
/** Browser-local display choices, deliberately separate from encrypted consent and sync schemas. */
export function useSectionPreferences(address: string, mode: string) {
  const key = sectionPreferencesKey(address, mode);
  const read = () => { try { return localStorage.getItem(key); } catch { return '!unavailable'; } };
  const raw = useSyncExternalStore(listener => {
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) listener(); };
    window.addEventListener('storage', onStorage); window.addEventListener(changed, listener);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(changed, listener); };
  }, read);
  const [saveError, setSaveError] = useState<string | null>(null);
  let sections = defaults(), invalid = false;
  try { sections = parseSectionPreferences(raw); } catch { invalid = true; }
  function setSection(section: OptionalSection, enabled: boolean) {
    try {
      if (!optionalSections.includes(section) || typeof enabled !== 'boolean') throw Error();
      // Re-read so another tab's unrelated choice is not overwritten.
      const current = parseSectionPreferences(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({ ...current, [section]: enabled }));
      setSaveError(null); window.dispatchEvent(new Event(changed));
    } catch { setSaveError(key); }
  }
  return { sections, setSection, error: invalid || saveError === key };
}
