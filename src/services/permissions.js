import { memberRoles } from '../config/referenceData.js';

const capabilitiesByRole = new Map(memberRoles.map((role) => [role.value, new Set(role.capabilities)]));

export function capabilitiesFor(role) {
  return [...(capabilitiesByRole.get(role) ?? [])];
}

export function hasCapability(role, capability) {
  return capabilitiesByRole.get(role)?.has(capability) ?? false;
}

export function requireCapability(capability) {
  return (request, response, next) => {
    if (hasCapability(request.auth?.access_role, capability)) return next();
    return response.status(403).json({ error: { code: 'PERMISSION_DENIED', message: 'Your team role does not allow this action. Ask an owner or manager.' } });
  };
}
