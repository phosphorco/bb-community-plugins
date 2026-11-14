import { z } from "zod";
// This describes the narrow operation boundary. A matching text marker alone
// is never verification; the persisted outbox and target/payload must match.
export const ReceiptEnvelopeSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().uuid(),
    originalIds: z.array(z.string()).min(1),
    targetThreadId: z.string().min(1),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ReceiptEnvelope = z.infer<typeof ReceiptEnvelopeSchema>;
