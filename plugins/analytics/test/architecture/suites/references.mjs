import {
  analyticsRoot,
  check,
  isInstrumentSelfTest,
  loadOptionalTestBinding,
  missingOperation,
  runNode,
  sha256,
  suiteResult,
} from "./data/common.mjs";
import { createStoredExecutionRecordFixture } from "./data/fixtures.mjs";
import { controlledReferenceOperations } from "./data/instrument-self-test-adapter.mjs";
import {
  executionReferenceCapsuleV2Schema,
  storedExecutionRecordSchema,
} from "../../../execution-contract.ts";

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function outcome(id, pass, details) {
  return check(id, pass ? "pass" : "fail", details);
}

export async function runReferenceScenario(operations) {
  const record = storedExecutionRecordSchema.parse(
    createStoredExecutionRecordFixture(),
  );
  const f = {
    executionId: record.result.executionId,
    visualizationId: record.definition.figures[0].visualization.id,
    targetDatumKey: record.result.result.datumKeys[0],
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    selectedRow: record.result.result.rows[0],
    bundle: record.definition.bundle,
    query: record.definition.query,
    range: record.snapshot.frozenRange,
  };
  const repository = operations.createRepository();
  let service;
  let mismatched;
  try {
    const admission = operations.admissionFor(
      record.snapshot.sourceScope.scopeKey,
    );
    await repository.saveExecution(record);
    service = operations.createReferenceService({ repository, admission });
    const created = await service.create({
      executionId: f.executionId,
      visualizationId: f.visualizationId,
      targetDatumKey: f.targetDatumKey,
      nowMs: f.createdAtMs + 1,
    });
    if (created?.kind !== "prepared") {
      return [
        check(
          "authoritative-created-capsule",
          "fail",
          "Creation did not return a prepared capsule.",
        ),
      ];
    }
    if (!executionReferenceCapsuleV2Schema.safeParse(created.capsule).success) {
      return [
        check(
          "authoritative-created-capsule",
          "fail",
          "Creation returned an invalid capsule.",
        ),
      ];
    }
    const resolvedBeforeEdit = await service.resolve({
      token: created.capsule.token,
      nowMs: f.createdAtMs + 2,
    });
    const forged = await service.create({
      executionId: "analytics-exec_zyxwvutsrqponmlk",
      visualizationId: f.visualizationId,
      targetDatumKey: f.targetDatumKey,
      nowMs: f.createdAtMs + 3,
    });
    const wrongDatum = await service.create({
      executionId: f.executionId,
      visualizationId: f.visualizationId,
      targetDatumKey: "analytics-datum_abcdefghijklmnop_9",
      nowMs: f.createdAtMs + 3,
    });
    mismatched = operations.createReferenceService({
      repository,
      admission: operations.admissionFor("analytics-scope_zyxwvutsrqponmlk"),
    });
    const wrongScope = await mismatched.create({
      executionId: f.executionId,
      visualizationId: f.visualizationId,
      targetDatumKey: f.targetDatumKey,
      nowMs: f.createdAtMs + 3,
    });
    await repository.replaceCurrentBundle({
      ...f.bundle,
      revision: "c".repeat(64),
    });
    const resolvedAfterEdit = await service.resolve({
      token: created.capsule.token,
      nowMs: f.createdAtMs + 4,
    });
    await repository.expireExecution(f.executionId);
    const resolvedAfterExpiry = await service.resolve({
      token: created.capsule.token,
      nowMs: f.expiresAtMs + 1,
    });
    const capsuleChecks = [
      created,
      resolvedBeforeEdit,
      resolvedAfterEdit,
      resolvedAfterExpiry,
    ].map((outcome, index) => {
      if (outcome.kind !== "prepared") {
        return check(
          `capsule-${index}-prepared`,
          "fail",
          `Expected prepared capsule, received ${outcome.kind}.`,
        );
      }
      try {
        executionReferenceCapsuleV2Schema.parse(outcome.capsule);
        return check(
          `capsule-${index}-schema`,
          "pass",
          "Returned prepared capsule satisfies the accepted schema.",
        );
      } catch (error) {
        return check(`capsule-${index}-schema`, "fail", String(error));
      }
    });
    return [
      outcome(
        "authoritative-created-capsule",
        created.kind === "prepared" &&
          created.capsule.executionId === f.executionId &&
          same(created.capsule.capturedSelectedRow, f.selectedRow),
        "Creation must derive selected row from persisted execution, not client claims.",
      ),
      outcome(
        "immutable-concrete-context",
        created.kind === "prepared" &&
          created.capsule.definition.bundle.revision === f.bundle.revision &&
          created.capsule.definition.query.revision === f.query.revision &&
          created.capsule.definition.query.sql === f.query.sql &&
          same(created.capsule.parameters, f.query.parameters) &&
          same(created.capsule.snapshot.frozenRange, f.range),
        "Captured capsule differs from immutable execution/bundle snapshots.",
      ),
      outcome(
        "captured-reference-survives-current-bundle-edit",
        resolvedBeforeEdit.kind === "prepared" &&
          resolvedAfterEdit.kind === "prepared" &&
          same(resolvedBeforeEdit.capsule, resolvedAfterEdit.capsule),
        "Resolving a saved reference read mutable current bundle state.",
      ),
      outcome(
        "independent-capsule-lifetime",
        resolvedAfterExpiry.kind === "prepared" &&
          same(resolvedAfterExpiry.capsule, created.capsule),
        "Captured reference failed after source execution expiry.",
      ),
      outcome(
        "forged-datum-and-scope-rejected",
        forged.kind === "error" && forged.error.code === "record-expired" &&
          wrongDatum.kind === "error" &&
          wrongDatum.error.code === "invalid-request" &&
          wrongScope.kind === "error" &&
          wrongScope.error.code === "identity-mismatch",
        "Service did not return accepted nested error outcomes for forged execution, datum, and scope.",
      ),
      ...capsuleChecks,
    ];
  } finally {
    const cleanup = await Promise.allSettled(
      [mismatched, service, repository].map((owner) =>
        Promise.resolve().then(() => owner?.dispose?.())
      ),
    );
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Reference fixture cleanup failed.",
      );
    }
  }
}

async function contractCheck() {
  const script =
    "import {storedExecutionRecordSchema} from './execution-contract.ts'; import {createStoredExecutionRecordFixture} from './test/architecture/suites/data/fixtures.mjs'; storedExecutionRecordSchema.parse(createStoredExecutionRecordFixture());";
  const parsed = await runNode([
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    script,
  ]);
  if (parsed.code !== 0) {
    return check(
      "stored-execution-record-fixture-schema",
      "fail",
      parsed.output,
    );
  }
  const result = await runNode([
    "--test",
    "--experimental-strip-types",
    "test/architecture/fixtures/execution-contract.fixtures.test.ts",
  ]);
  return check(
    "accepted-contract-pure-reference-preparation",
    result.code === 0 ? "pass" : "fail",
    "Bounded execution-contract preparation fixture is supplementary, not service acceptance.",
  );
}
async function selfTest() {
  const faults = {
    "wrong-row": "authoritative-created-capsule",
    "wrong-sql": "immutable-concrete-context",
    "mutable-resolution": "captured-reference-survives-current-bundle-edit",
    "expire-capsule": "independent-capsule-lifetime",
    "accept-forged": "forged-datum-and-scope-rejected",
    "accept-datum": "forged-datum-and-scope-rejected",
    "accept-scope": "forged-datum-and-scope-rejected",
  };
  const positive = await runReferenceScenario(controlledReferenceOperations());
  const negatives = await Promise.all(
    Object.entries(faults).map(async ([fault, oracle]) => {
      const checks = await runReferenceScenario(
        controlledReferenceOperations({ fault }),
      );
      return check(
        `instrument-self-test-${fault}`,
        checks.find((item) => item.id === oracle)?.status === "fail"
          ? "pass"
          : "fail",
        `Deliberately wrong operation result must fail ${oracle}.`,
      );
    }),
  );
  return suiteResult("references", [
    check(
      "instrument-self-test-positive",
      positive.every((item) => item.status === "pass") ? "pass" : "fail",
      "Operation-level controlled positive scenario.",
    ),
    ...negatives,
  ], ["instrument-self-test only"]);
}
async function loadOperations() {
  return loadOptionalTestBinding("references");
}
export async function runSuite(options = {}) {
  if (isInstrumentSelfTest(options)) return selfTest();
  const contract = await contractCheck();
  const binding = await loadOperations();
  if (binding.kind === "defect") {
    return suiteResult("references", [
      contract,
      check("production-reference-binding-defect", "fail", binding.details),
    ]);
  }
  if (binding.kind === "absent") {
    return suiteResult("references", [
      contract,
      check(
        "missing-production-reference-operations",
        "blocked",
        `${binding.details} ${
          missingOperation(
            "reference service",
            "createRepository/admissionFor/createReferenceService({repository,admission}) -> create/resolve",
          ).details
        } Contract SHA-256: ${await sha256(
          `${analyticsRoot}/execution-contract.ts`,
        )}.`,
      ),
    ], [
      "Normal mode will execute runReferenceScenario unchanged once a test-owned real-operation binding exists.",
    ]);
  }
  return suiteResult("references", [
    contract,
    ...(await runReferenceScenario(binding.operations)),
  ]);
}
