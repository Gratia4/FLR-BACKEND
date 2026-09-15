import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../src/db.js";

const input = z.object({
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12).max(128),
  ADMIN_NAME: z.string().min(2).max(150),
  ADMIN_PHONE: z.string().min(8).max(30),
}).parse(process.env);

async function createAdmin() {
  const passwordHash = await bcrypt.hash(input.ADMIN_PASSWORD, 12);
  const result = await pool.query(
    `INSERT INTO users(email,password_hash,full_name,job_title,phone,role)
     VALUES(lower($1),$2,$3,'System Administrator',$4,'SUPER_ADMIN')
     ON CONFLICT(email) DO NOTHING RETURNING id,email`,
    [input.ADMIN_EMAIL, passwordHash, input.ADMIN_NAME, input.ADMIN_PHONE],
  );
  if (!result.rowCount) throw new Error("A user with that email already exists; no changes were made");
  console.log(`Created super admin ${result.rows[0].email}`);
}

createAdmin().finally(() => pool.end());
