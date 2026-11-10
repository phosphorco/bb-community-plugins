import { createHash } from "node:crypto";
export const sha256 = (v: string) =>
  createHash("sha256").update(v).digest("hex");
import { canonical } from "./value.ts";
export { canonical } from "./value.ts";
export const fingerprint = (v: unknown) => sha256(canonical(v));
