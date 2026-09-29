import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { PoolClient } from "pg";
import { config } from "../config.js";
import { query } from "../db.js";
import type { TokenPayload } from "../types.js";

export function createAccessToken(payload: TokenPayload) {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN as SignOptions["expiresIn"] });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, config.JWT_SECRET) as TokenPayload;
}

/* ---------------- opaque tokens (refresh + password reset) ---------------- */

/**
 * Opaque random tokens, stored only as a SHA-256 digest. A database leak
 * therefore does not hand out live sessions or reset links.
 */
export function issueOpaqueToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function persistRefreshToken(
  userId: string,
  hash: string,
  meta: { userAgent?: string; ip?: string },
  client?: PoolClient,
) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `INSERT INTO refresh_tokens(user_id,token_hash,user_agent,ip_address,expires_at)
     VALUES($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
    [userId, hash, meta.userAgent?.slice(0, 250) ?? null, meta.ip ?? null, String(config.REFRESH_TOKEN_DAYS)],
  );
}

export async function revokeRefreshToken(hash: string) {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hash]);
}

export async function revokeAllRefreshTokens(userId: string) {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

/** Generates a readable one-time password for staff invites. */
export function temporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%";
  const pick = (source: string, count: number) =>
    Array.from({ length: count }, () => source[randomBytes(1)[0]! % source.length]).join("");
  return `${pick(alphabet, 4)}${pick(digits, 3)}${pick(symbols, 1)}${pick(alphabet.toLowerCase(), 3)}`;
}
