import type { AccountStatus, UserRole } from "../types.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        businessId: string | null;
        role: UserRole;
        status: AccountStatus | null;
      };
    }
  }
}

export {};
