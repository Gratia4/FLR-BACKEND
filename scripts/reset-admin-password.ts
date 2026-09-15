import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../src/db.js";

const input = z.object({
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12).max(128),
}).parse(process.env);

async function resetPassword() {
  const passwordHash = await bcrypt.hash(input.ADMIN_PASSWORD, 12);
  const result = await pool.query(
    `UPDATE users SET password_hash=$1, updated_at=now()
     WHERE lower(email)=lower($2) AND role='SUPER_ADMIN'
     RETURNING id,email`,
    [passwordHash, input.ADMIN_EMAIL],
  );
  if (!result.rowCount) throw new Error("Super admin account not found; no changes were made");
  await pool.query(
    "INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id) VALUES($1::uuid,'ADMIN_PASSWORD_RESET','user',$1::text)",
    [result.rows[0].id],
  );
  console.log(`Reset password for ${result.rows[0].email}`);
}

resetPassword().finally(() => pool.end());
