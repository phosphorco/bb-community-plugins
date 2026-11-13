import { z } from "zod";
import { senderPolicyRefSchema } from "./admission/native.ts";
const scope = {
  testProjectId:z.string().min(1).max(200),
  scope:z.literal("test-project"),
};
const request = {
  ...scope,requestId:z.string().min(1).max(200),basis:z.string().min(1),
  expectedActivePolicy:senderPolicyRefSchema.nullable(),
};
export const admissionContract = {
  testAdmissionState:{
    experimental_description:"Read plugin-owned frozen sender policy and native hook readiness for an explicit testing project. Saved rules and active immutable policy are separate; this performs no enrollment or inference.",
    input:z.strictObject(scope),output:z.unknown(),
  },
  publishTestPolicy:{
    experimental_description:"Explicitly publish the current saved global catalog for ONE testing project only. Requires saved basis, stable requestId and expectedActivePolicy from status. Saving and installation do not activate enforcement. Static accept/reject only; matching paid JEV and delivery changes are refused.",
    input:z.strictObject(request),output:z.unknown(),
  },
  deactivateTestPolicy:{
    experimental_description:"Explicitly deactivate the policy enrolled only for this testing project using plugin-owned policy CAS. Cannot disable a publication containing any other project. Requires current saved basis and stable requestId; unknown outcomes require same-operation lookup.",
    input:z.strictObject(request),output:z.unknown(),
  },
  lookupTestPublication:{
    experimental_description:"Reconcile exactly one testing-project publication/deactivation operation by its original requestId. This is read-only: it never republishes, infers or retries an uncertain write.",
    input:z.strictObject({...scope,requestId:z.string().min(1).max(200)}),output:z.unknown(),
  },
} as const;
