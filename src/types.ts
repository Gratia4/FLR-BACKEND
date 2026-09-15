export type UserRole = "CLIENT" | "SUPER_ADMIN" | "SALES_MANAGER" | "CONTENT_MANAGER" | "LOGISTICS" | "FINANCE";
export type AccountStatus = "PENDING" | "APPROVED" | "SUSPENDED" | "REJECTED";

export type TokenPayload = {
  sub: string;
  businessId: string | null;
  role: UserRole;
};
