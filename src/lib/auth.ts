import jwt, { type SignOptions } from "jsonwebtoken";
import { config } from "../config.js";
import type { TokenPayload } from "../types.js";

export function createAccessToken(payload: TokenPayload) {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN as SignOptions["expiresIn"] });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, config.JWT_SECRET) as TokenPayload;
}
