export interface OrgValidation { ok: boolean; errors: string[]; }
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const address = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

/** Validate present fields before importing. Absent legacy optional fields are defaulted by parseOrg. */
export function validateOrgConfig(value: unknown): OrgValidation {
  const errors: string[] = [];
  const check = (ok: unknown, path: string) => { if (!ok && errors.length < 20) errors.push(`${path} is invalid`); };
  const optionalText = (value: unknown, path: string, max = 2048) => {
    if (value !== undefined) check(typeof value === 'string' && value.length <= max, path);
  };
  const list = (value: unknown, path: string, visit: (item: any, path: string) => void, optional = false) => {
    if (optional && value === undefined) return;
    if (!Array.isArray(value) || value.length > 1000) { check(false, path); return; }
    value.forEach((item, index) => visit(item, `${path}[${index}]`));
  };
  const policy = (value: unknown, path: string) => {
    if (value === undefined) return;
    if (!object(value)) { check(false, path); return; }
    if (value.mode !== undefined) check(['active', 'read-only'].includes(value.mode), `${path}.mode`);
    if (value.attachments !== undefined) check(['allow', 'block'].includes(value.attachments), `${path}.attachments`);
    if (value.maxUploadBytes !== undefined) check(integer(value.maxUploadBytes), `${path}.maxUploadBytes`);
  };
  const rule = (value: unknown, path: string) => {
    if (!object(value)) { check(false, path); return; }
    switch (value.kind) {
      case 'token':
        check(['erc20', 'erc721', 'erc1155'].includes(value.standard), `${path}.standard`);
        check(address(value.token), `${path}.token`);
        check(typeof value.min === 'string' && value.min.length <= 100 && /^\d+(\.\d+)?$/.test(value.min), `${path}.min`);
        if (value.tokenId !== undefined) check(typeof value.tokenId === 'string' && /^\d{1,78}$/.test(value.tokenId), `${path}.tokenId`);
        break;
      case 'safe': check(address(value.safe), `${path}.safe`); break;
      case 'ens': optionalText(value.name, `${path}.name`, 255); break;
      case 'role': check(text(value.role), `${path}.role`); break;
      case 'power': check(integer(value.tier), `${path}.tier`); break;
      default: check(false, `${path}.kind`);
    }
  };
  if (!object(value)) return { ok: false, errors: ['not an object'] };
  check(value.version === 1, 'version');
  if (value.id !== undefined) check(text(value.id) && value.id !== 'org_personal', 'id');
  check(text(value.namespace), 'namespace');
  if (!object(value.branding)) check(false, 'branding');
  else {
    check(text(value.branding.name), 'branding.name');
    if (value.branding.slug !== undefined) check(text(value.branding.slug), 'branding.slug');
    optionalText(value.branding.logoUrl, 'branding.logoUrl', 100_000);
    for (const field of ['accent', 'homeUrl']) optionalText(value.branding[field], `branding.${field}`);
    optionalText(value.branding.themeCss, 'branding.themeCss', 100_000);
  }
  if (!object(value.chain)) check(false, 'chain');
  else {
    check(integer(value.chain.chainId) && value.chain.chainId > 0, 'chain.chainId');
    optionalText(value.chain.rpcUrl, 'chain.rpcUrl');
  }
  optionalText(value.gateUrl, 'gateUrl');
  list(value.entryGate, 'entryGate', rule);
  if (!object(value.gating)) check(false, 'gating');
  else {
    for (const flag of ['enableTokenRules', 'enableSafeRules', 'enableEnsRules']) {
      if (value.gating[flag] !== undefined) check(typeof value.gating[flag] === 'boolean', `gating.${flag}`);
    }
    if (value.gating.roleCascade !== undefined) {
      const cascade = value.gating.roleCascade;
      if (!object(cascade)) check(false, 'gating.roleCascade');
      else {
        check(Object.keys(cascade).length <= 1000, 'gating.roleCascade');
        for (const [role, rank] of Object.entries(cascade)) check(text(role) && integer(rank), 'gating.roleCascade rank');
      }
    }
    const power = value.gating.powerTier;
    if (power !== undefined && power !== null) {
      if (!object(power)) check(false, 'gating.powerTier');
      else {
        check(text(power.label), 'gating.powerTier.label');
        check(text(power.resolver), 'gating.powerTier.resolver');
        list(power.tiers, 'gating.powerTier.tiers', (tier, path) => check(integer(tier), path));
        if (power.params !== undefined) {
          if (!object(power.params)) check(false, 'gating.powerTier.params');
          else {
            check(Object.keys(power.params).length <= 1000, 'gating.powerTier.params');
            for (const [key, val] of Object.entries(power.params)) check(text(key) && typeof val === 'string' && val.length <= 2048, 'gating.powerTier.params value');
          }
        }
      }
    }
  }
  policy(value.policy, 'policy');
  const ids = new Set<string>();
  list(value.defaultRooms, 'defaultRooms', (room, path) => {
    if (!object(room)) { check(false, path); return; }
    check(text(room.id) && !ids.has(room.id), `${path}.id`); ids.add(room.id);
    check(text(room.title), `${path}.title`);
    optionalText(room.description, `${path}.description`, 10_000);
    if (!object(room.gate)) check(false, `${path}.gate`);
    else {
      check(['any', 'all'].includes(room.gate.combine), `${path}.gate.combine`);
      list(room.gate.rules, `${path}.gate.rules`, rule);
    }
    policy(room.policy, `${path}.policy`);
  }, true);
  list(value.roles, 'roles', (role, path) => {
    if (!object(role)) { check(false, path); return; }
    check(text(role.label), `${path}.label`);
    optionalText(role.color, `${path}.color`);
  }, true);
  list(value.admins, 'admins', (admin, path) => check(address(admin), path), true);
  return { ok: errors.length === 0, errors };
}
