export type UserRole = "CLIENT" | "SUPER_ADMIN" | "SALES_MANAGER" | "CONTENT_MANAGER" | "LOGISTICS" | "FINANCE";
export type AccountStatus = "PENDING" | "APPROVED" | "SUSPENDED" | "REJECTED";
export type OrderStatus = "DRAFT" | "SUBMITTED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "INVOICED" | "CANCELLED";

export const STAFF_ROLES: UserRole[] = ["SUPER_ADMIN", "SALES_MANAGER", "CONTENT_MANAGER", "LOGISTICS", "FINANCE"];

/** Who may act on each area of the console. SUPER_ADMIN is implicit everywhere. */
export const PERMISSIONS = {
  registrations: ["SUPER_ADMIN", "SALES_MANAGER"],
  clients: ["SUPER_ADMIN", "SALES_MANAGER"],
  catalogue: ["SUPER_ADMIN", "CONTENT_MANAGER"],
  inventory: ["SUPER_ADMIN", "LOGISTICS", "CONTENT_MANAGER"],
  fulfilment: ["SUPER_ADMIN", "LOGISTICS", "SALES_MANAGER"],
  finance: ["SUPER_ADMIN", "FINANCE"],
  staff: ["SUPER_ADMIN"],
  analytics: ["SUPER_ADMIN", "SALES_MANAGER", "FINANCE"],
  communications: ["SUPER_ADMIN", "SALES_MANAGER", "CONTENT_MANAGER"],
} as const satisfies Record<string, readonly UserRole[]>;

export type PermissionArea = keyof typeof PERMISSIONS;

export type TokenPayload = {
  sub: string;
  businessId: string | null;
  role: UserRole;
  status: AccountStatus | null;
};
