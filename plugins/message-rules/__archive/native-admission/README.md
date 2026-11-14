# Retired native-admission factory tests

The upstream BB 0.49.0 upgrade removes the custom native publication/evaluator API. This exact old factory test is retained as historical source, outside compilation and test discovery. Its publication CAS, evaluator-generation rebind, native evidence-token and feedback guarantees are not provided by the native sender hook.

Current acceptance lives in `test/admission/sender.test.ts` and `sender-policy.test.ts`. The new hook applies static accept/reject rules synchronously. The plugin owns explicit frozen policy activation and its receipts. Matching paid JEV or delivery-rewrite rules are refused with an actionable explanation. Existing native admission tables and callback history remain intact; no old publication is silently activated.

A paid asynchronous lane requires a separate design: the native hook holds a server-wide lock for at most ten seconds, while old JEV checks permit longer work. Never await that transport inside the hook.
