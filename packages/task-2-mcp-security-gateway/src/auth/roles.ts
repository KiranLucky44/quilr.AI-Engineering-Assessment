export const ROLES = ['admin', 'viewer'] as const;

export type Role = (typeof ROLES)[number];

export interface AuthenticatedPrincipal {
  readonly role: Role;
  readonly tokenFingerprint: string;
}

export function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'viewer';
}
