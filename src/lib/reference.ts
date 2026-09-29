import { randomInt } from "node:crypto";

export function createReference(prefix: "REG" | "ORD" | "INV" | "PAY" | "RET" | "CRN") {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return `${prefix}-${date}-${randomInt(10000, 99999)}`;
}
