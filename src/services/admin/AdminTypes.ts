export const ADMIN_ROLES = ['owner', 'operator', 'analyst'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export type AdminStatus = 'active' | 'disabled';

export interface AdminIdentity {
  readonly id: string;
  readonly email: string;
  readonly role: AdminRole;
  readonly status: AdminStatus;
}

export const isAdminRole = (value: unknown): value is AdminRole =>
  typeof value === 'string' && ADMIN_ROLES.includes(value as AdminRole);

export const roleAllows = (role: AdminRole, required: AdminRole): boolean => {
  const rank: Record<AdminRole, number> = { analyst: 1, operator: 2, owner: 3 };
  return rank[role] >= rank[required];
};
