import type { UserRole } from "../types.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        businessId: string | null;
        role: UserRole;
      };
    }
  }
}

export {};
