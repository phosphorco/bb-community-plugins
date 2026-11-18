import { test } from "bun:test";
import { browserSavedRequestRecovery } from "./browser-recovery.ts";

// The owned CDP lifecycle needs a fresh process, as provided for each browser
// file by tools/test.mjs. Keep the complete recovery and cleanup assertions.
test(
  "actual product browser reload resumes exact saved direct and native request",
  browserSavedRequestRecovery,
  60000,
);
