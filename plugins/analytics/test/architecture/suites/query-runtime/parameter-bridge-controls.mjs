import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(new URL("../../../../query-runtime/parameter-bridge.cjs", import.meta.url));
const require = createRequire(import.meta.url);
const bridge = require(bridgePath);
const limits = Object.freeze({ maxAstNodes: 64, maxGeneratedBytes: 32 * 1024 });
const expectedBridgeRevision = "analytics-parameter-bridge-ast-v3";
const expectedBridgeSourceSha256 = "335d6aa6ba0002118ae970b7b60663cff1f80be42efdf986029c3b5f46aa36f2";
const parameters = Object.freeze([
  // Deliberately reverse caller declaration order. The parser map makes a1
  // position one and a_2 position two, so boundValues must follow positions.
  { name: "a_2", logicalType: "integer", value: 9 },
  { name: "a1", logicalType: "integer", value: 2 },
]);

// This is parser-AST-shaped test data for the pure helper, never a SQL engine
// fixture. It includes a maximum uint64 query location, an ordinary safe
// integer, and a beyond-safe integer numeric literal to catch JSON precision
// loss before any policy/worker action.
const decimalTypeJson = '{"id":"DECIMAL","type_info":{"type":"DECIMAL_TYPE_INFO","width":18,"scale":2}}';
const orderExpressionJson = '{"type":"COLUMN_REF","query_location":14,"column_names":["duration_ms"]}';
const orderEnvelopeJson = `{"type":"ASCENDING","null_order":"NULLS LAST","expression":${orderExpressionJson}}`;
const orderModifierJson = `{"type":"ORDER_MODIFIER","orders":[${orderEnvelopeJson}]}`;
const nullConstantJson = '{"type":"VALUE_CONSTANT","query_location":13,"value":{"type":{"id":"SQLNULL"},"is_null":true}}';
const coalesceChildrenJson = '[{"type":"VALUE_PARAMETER","identifier":"a1","query_location":16},{"type":"VALUE_CONSTANT","query_location":17,"value":{"type":{"id":"INTEGER"},"is_null":false,"value":0}}]';
const coalesceNodeJson = `{"type":"OPERATOR_COALESCE","query_location":15,"children":${coalesceChildrenJson}}`;
const serialized = `{"error":false,"statements":[{"named_param_map":[{"key":"a1","value":1},{"key":"a_2","value":2}],"node":{"type":"SELECT_NODE","query_location":18446744073709551615,"safe_numeric":42,"beyond_safe_numeric":9007199254740993,"modifiers":[${orderModifierJson}],"select_list":[{"type":"VALUE_PARAMETER","identifier":"a_2","query_location":7},{"type":"VALUE_PARAMETER","identifier":"a1","query_location":8},{"type":"VALUE_CONSTANT","query_location":9,"value":{"type":${decimalTypeJson},"is_null":false,"value":9007199254740993}},{"type":"VALUE_CONSTANT","query_location":10,"value":{"type":{"id":"INTEGER_LITERAL","type_info":{"type":"INTEGER_LITERAL_TYPE_INFO","constant_value":{"type":{"id":"INTEGER"},"is_null":false,"value":7}}},"is_null":false,"value":7}},{"type":"OPERATOR_CAST","query_location":11,"child":{"type":"COLUMN_REF","query_location":12,"column_names":["duration_ms"]},"cast_type":${decimalTypeJson}},${nullConstantJson},${coalesceNodeJson}]}}]}`;

/**
 * Direct-import controls for the actual worker-owned pure bridge. No child,
 * SQLite, DuckDB, SQL execution, or production runtime constructor is used.
 */
export function runParameterBridgeControls() {
  const checks = [];
  const sourceSha256 = createHash("sha256").update(readFileSync(bridgePath)).digest("hex");
  checks.push(control(
    "parameter-bridge-source-provenance",
    bridge.PARAMETER_BRIDGE_TRANSFORM_REVISION === expectedBridgeRevision
      && bridge.PARAMETER_BRIDGE_SOURCE_SHA256 === expectedBridgeSourceSha256
      && bridge.PARAMETER_BRIDGE_SOURCE_SHA256 === sourceSha256
      && typeof bridge.bridgeNamedParameters === "function"
      && typeof bridge.verifyPositionalBridge === "function"
      && typeof bridge.policyAstFromSerialized === "function"
      && typeof bridge.isValidatedLogicalTypeMetadata === "function"
      && typeof bridge.isValidatedOrderByEnvelope === "function",
    "The no-engine controls imported the actual worker bridge with matching source identity and approved pure exports.",
  ));

  let transformed;
  try {
    transformed = bridge.bridgeNamedParameters({ serialized, parameters, ...limits });
  } catch {
    checks.push(control("parameter-bridge-lossless-numeric-and-map-order", false, "The actual bridge rejected its bounded valid parser-AST control."));
    checks.push(control("parameter-bridge-policy-view-bounds-and-lexemes", false, "Valid bridge setup was unavailable for the shared policy-view controls."));
    checks.push(control("parameter-bridge-logical-type-metadata-terminals", false, "Valid bridge setup was unavailable for the LogicalType metadata terminal controls."));
    checks.push(control("parameter-bridge-null-constant-envelope", false, "Valid bridge setup was unavailable for the conditional null-constant envelope controls."));
    checks.push(control("parameter-bridge-order-by-envelope", false, "Valid bridge setup was unavailable for the typed OrderBy envelope controls."));
    checks.push(control("parameter-bridge-coalesce-nonempty-children", false, "Valid bridge setup was unavailable for the OPERATOR_COALESCE controls."));
    checks.push(control("parameter-bridge-malformed-map-controls", false, "Valid bridge setup was unavailable for the map-negative controls."));
    checks.push(control("parameter-bridge-typed-edge-and-container-guards", false, "Valid bridge setup was unavailable for the typed edge/container controls."));
    checks.push(control("parameter-bridge-limit-modifier-typed-controls", false, "Valid bridge setup was unavailable for the SELECT LIMIT modifier controls."));
    checks.push(control("parameter-bridge-equivalence-guards", false, "Valid bridge setup was unavailable for the equivalence controls."));
    checks.push(control("parameter-bridge-query-location-guards", false, "Valid bridge setup was unavailable for the query-location controls."));
    return checks;
  }

  const policyNode = transformed?.policyAst?.statements?.[0]?.node;
  const numericPreserved = typeof transformed?.generatedJson === "string"
    && transformed.generatedJson.includes("18446744073709551615")
    && transformed.generatedJson.includes('"safe_numeric":42')
    && transformed.generatedJson.includes("9007199254740993")
    && policyNode?.query_location === "18446744073709551615"
    && policyNode?.safe_numeric === "42"
    && policyNode?.beyond_safe_numeric === "9007199254740993";
  const positional = transformed?.positionalCount === 2
    && Array.isArray(transformed?.boundValues)
    && transformed.boundValues.length === 2
    && transformed.boundValues[0] === 2 && transformed.boundValues[1] === 9;
  checks.push(control(
    "parameter-bridge-lossless-numeric-and-map-order",
    numericPreserved && positional,
    "Maximum uint64, safe, and beyond-safe numeric lexemes were retained exactly; parser map order determined the bounded positional value vector.",
  ));

  const policyAst = tryPolicyView(serialized, limits.maxAstNodes, limits.maxGeneratedBytes);
  const policyNodeView = policyAst?.statements?.[0]?.node;
  const numericPolicyView = policyNodeView?.query_location === "18446744073709551615"
    && policyNodeView?.safe_numeric === "42"
    && policyNodeView?.beyond_safe_numeric === "9007199254740993";
  const depthOverflow = withNestedPadding(140);
  const tokenOverflow = withWidePadding(128);
  checks.push(control(
    "parameter-bridge-policy-view-bounds-and-lexemes",
    numericPolicyView
      && tryPolicyView(depthOverflow, limits.maxAstNodes, limits.maxGeneratedBytes) == null
      && tryPolicyView(tokenOverflow, 1, limits.maxGeneratedBytes) == null
      && tryPolicyView(serialized, limits.maxAstNodes, 32) == null,
    "The actual shared bounded policy view retains numeric lexemes as strings and rejects over-depth, over-token, and over-byte parser trees.",
  ));

  const decimalMetadata = policyNodeView?.select_list?.[2]?.value?.type;
  const integerLiteralMetadata = policyNodeView?.select_list?.[3]?.value?.type;
  const castMetadata = policyNodeView?.select_list?.[4]?.cast_type;
  const wrongPath = serialized.replace(
    '"select_list":[',
    `"untrusted_logical_type":${decimalTypeJson},"select_list":[`,
  );
  const wrongPathMetadata = tryPolicyView(wrongPath, limits.maxAstNodes, limits.maxGeneratedBytes)
    ?.statements?.[0]?.node?.untrusted_logical_type;
  const malformedMetadata = [
    serialized.replace('"width":18', '"width":39'),
    serialized.replace('"scale":2', '"scale":19'),
    serialized.replace('"scale":2}', '"scale":2,"unexpected":true}'),
    serialized.replace('"scale":2}', '"scale":2,"nested":{"type":"SELECT_NODE"}}'),
  ];
  const terminalIdentity = bridge.isValidatedLogicalTypeMetadata(decimalMetadata)
    && bridge.isValidatedLogicalTypeMetadata(decimalMetadata?.type_info)
    && bridge.isValidatedLogicalTypeMetadata(integerLiteralMetadata)
    && bridge.isValidatedLogicalTypeMetadata(integerLiteralMetadata?.type_info)
    && bridge.isValidatedLogicalTypeMetadata(castMetadata)
    && bridge.isValidatedLogicalTypeMetadata(castMetadata?.type_info)
    && !bridge.isValidatedLogicalTypeMetadata(structuredClone(decimalMetadata));
  checks.push(control(
    "parameter-bridge-logical-type-metadata-terminals",
    terminalIdentity
      && wrongPathMetadata != null
      && !bridge.isValidatedLogicalTypeMetadata(wrongPathMetadata)
      && malformedMetadata.every((candidate) => tryPolicyView(candidate, limits.maxAstNodes, limits.maxGeneratedBytes) == null),
    "Only helper-cloned, source-proven VALUE_CONSTANT/OPERATOR_CAST LogicalType terminals receive identity marks; same-shaped wrong-path metadata remains unmarked and malformed width, scale, key, or nested-AST metadata is rejected.",
  ));

  const nullValue = policyNodeView?.select_list?.[5]?.value;
  const explicitNullPayload = serialized.replace(nullConstantJson, '{"type":"VALUE_CONSTANT","query_location":13,"value":{"type":{"id":"SQLNULL"},"is_null":true,"value":null}}');
  const nonnullMissingPayload = serialized.replace(nullConstantJson, '{"type":"VALUE_CONSTANT","query_location":13,"value":{"type":{"id":"SQLNULL"},"is_null":false}}');
  checks.push(control(
    "parameter-bridge-null-constant-envelope",
    nullValue?.is_null === true
      && !Object.hasOwn(nullValue, "value")
      && tryPolicyView(explicitNullPayload, limits.maxAstNodes, limits.maxGeneratedBytes) == null
      && tryPolicyView(nonnullMissingPayload, limits.maxAstNodes, limits.maxGeneratedBytes) == null,
    "The actual helper accepts the serializer's null envelope only with an absent payload; explicit null payload and non-null missing payload are rejected.",
  ));

  const orderEnvelope = policyNodeView?.modifiers?.[0]?.orders?.[0];
  const offRouteOrder = serialized.replace(
    '"modifiers":[',
    `"untrusted_order":${orderEnvelopeJson},"modifiers":[`,
  );
  const invalidOrderDirection = serialized.replace('"type":"ASCENDING","null_order":"NULLS LAST"', '"type":"SIDEWAYS","null_order":"NULLS LAST"');
  const invalidOrderNull = serialized.replace('"type":"ASCENDING","null_order":"NULLS LAST"', '"type":"ASCENDING","null_order":"NULLS MIDDLE"');
  const extraOrderKey = serialized.replace(orderEnvelopeJson, `{"type":"ASCENDING","null_order":"NULLS LAST","expression":${orderExpressionJson},"unexpected":true}`);
  const missingOrderExpression = serialized.replace(orderEnvelopeJson, '{"type":"ASCENDING","null_order":"NULLS LAST"}');
  const unknownOrderExpression = serialized.replace(orderExpressionJson, '{"type":"UNKNOWN_EXPRESSION","query_location":14}');
  checks.push(control(
    "parameter-bridge-order-by-envelope",
    bridge.isValidatedOrderByEnvelope(orderEnvelope)
      && !bridge.isValidatedOrderByEnvelope(structuredClone(orderEnvelope))
      && tryPolicyView(offRouteOrder, limits.maxAstNodes, limits.maxGeneratedBytes) == null
      && [invalidOrderDirection, invalidOrderNull, extraOrderKey, missingOrderExpression, unknownOrderExpression]
        .every((candidate) => tryPolicyView(candidate, limits.maxAstNodes, limits.maxGeneratedBytes) == null),
    "Only a helper-cloned ORDER_MODIFIER.orders[] envelope with canonical direction/null-order and an approved expression route is marked; off-route, structural clone, invalid enum, extra key, missing expression, and unknown expression shapes do not pass.",
  ));

  const coalesce = policyNodeView?.select_list?.[6];
  const coalesceNegatives = [
    serialized.replace(coalesceNodeJson, '{"type":"OPERATOR_COALESCE","query_location":15}'),
    serialized.replace(coalesceNodeJson, '{"type":"OPERATOR_COALESCE","query_location":15,"children":null}'),
    serialized.replace(coalesceNodeJson, '{"type":"OPERATOR_COALESCE","query_location":15,"children":[]}'),
    serialized.replace(coalesceNodeJson, '{"type":"OPERATOR_COALESCE","query_location":15,"children":{}}'),
    serialized.replace(coalesceChildrenJson, '[{"type":"BASE_TABLE","query_location":16,"table_name":"tool_execution_fact_v1"},{"type":"VALUE_CONSTANT","query_location":17,"value":{"type":{"id":"INTEGER"},"is_null":false,"value":0}}]'),
    serialized.replace(coalesceChildrenJson, '[{"type":"UNKNOWN_EXPRESSION","query_location":16},{"type":"VALUE_CONSTANT","query_location":17,"value":{"type":{"id":"INTEGER"},"is_null":false,"value":0}}]'),
    serialized.replace('"type":"OPERATOR_COALESCE","query_location":15', '"type":"OPERATOR_UNREGISTERED","query_location":15'),
  ];
  checks.push(control(
    "parameter-bridge-coalesce-nonempty-children",
    coalesce?.type === "OPERATOR_COALESCE"
      && Array.isArray(coalesce.children)
      && coalesce.children.length === 2
      && verifies(transformed.generatedJson)
      && coalesceNegatives.every((candidate) => tryPolicyView(candidate, limits.maxAstNodes, limits.maxGeneratedBytes) == null),
    "The actual helper round-trips source-routed two-expression OPERATOR_COALESCE and rejects missing, null, empty, non-array, relation-child, unknown-expression, and unregistered-operator variants.",
  ));

  const malformed = serialized.replace('"key":"a1","value":1}', '"key":"a1","value":1,"extra":true}');
  const missing = serialized.replace(',{"key":"a_2","value":2}', "");
  const duplicate = serialized.replace('"key":"a_2"', '"key":"a1"');
  checks.push(control(
    "parameter-bridge-malformed-map-controls",
    throwsBridge(malformed) && throwsBridge(missing) && throwsBridge(duplicate),
    "Malformed, missing, and duplicate named-parameter maps are rejected by the actual bridge before generated positional AST use.",
  ));

  const parameterNode = '{"type":"VALUE_PARAMETER","identifier":"a1","query_location":1}';
  const withCteMap = (cteMap) => serialized.replace('"select_list":[', `"cte_map":${cteMap},"select_list":[`);
  const validCteMapShape = `{"map":[{"key":"cte","value":{"query":{"node":${parameterNode}}}}]}`;
  const typedEdgeNegatives = [
    // Relation in an expression-list transition.
    serialized.replace('"select_list":[', '"select_list":[{"type":"BASE_TABLE","query_location":1},'),
    // Expression directly under a cte-map transition.
    withCteMap(parameterNode),
    // The closed cte_map -> map[] -> value -> query -> node envelope cannot
    // accept arbitrary object/array flattening at any intermediate step.
    withCteMap(`[${validCteMapShape}]`),
    withCteMap(`{"map":{"entry":{"value":{"query":{"node":${parameterNode}}}}}}`),
    withCteMap(`{"map":[{"key":"cte","value":[{"query":{"node":${parameterNode}}}]}]}`),
    withCteMap(`{"map":[{"key":"cte","value":{"query":[{"node":${parameterNode}}]}}]}`),
    withCteMap(`{"map":[{"key":"cte","value":{"query":{"node":[${parameterNode}]}}}]}`),
    withCteMap(`{"map":[{"key":"cte","value":{"query":{"node":{"wrapper":${parameterNode}}}}}]}`),
  ];
  checks.push(control(
    "parameter-bridge-typed-edge-and-container-guards",
    typedEdgeNegatives.every((candidate) => throwsBridge(candidate)),
    "Known parser node types are rejected on wrong expression/relation edges and every malformed CTE map/value/query/node object-or-array envelope is closed.",
  ));

  const limit24 = serialized.replace(
    `"modifiers":[${orderModifierJson}]`,
    '"modifiers":[{"type":"LIMIT_MODIFIER","limit":{"type":"VALUE_CONSTANT","query_location":10,"value":24},"offset":null}]',
  );
  const limitBridge = tryBridge(limit24);
  const limitRoundTrip = limitBridge != null && verifiesFrom(limit24, limitBridge.generatedJson)
    && limitBridge.policyAst?.statements?.[0]?.node?.modifiers?.[0]?.limit?.value === "24";
  const relationLimit = limit24.replace('"type":"VALUE_CONSTANT","query_location":10,"value":24', '"type":"BASE_TABLE","query_location":10');
  const functionOrderLimit = serialized.replace(
    '"select_list":[',
    '"select_list":[{"type":"FUNCTION","query_location":10,"order_bys":{"type":"LIMIT_MODIFIER","limit":{"type":"VALUE_CONSTANT","query_location":11,"value":24}}},',
  );
  checks.push(control(
    "parameter-bridge-limit-modifier-typed-controls",
    limitRoundTrip && throwsBridge(relationLimit) && throwsBridge(functionOrderLimit),
    "The actual bridge round-trips SELECT LIMIT 24 while rejecting a relation limit target and LIMIT_MODIFIER under FUNCTION.order_bys.",
  ));

  const equivalent = verifies(transformed.generatedJson);
  const alteredMarker = transformed.generatedJson.replace('"identifier":"1"', '"identifier":"3"');
  const alteredField = transformed.generatedJson.replace('"safe_numeric":42', '"safe_numeric":43');
  checks.push(control(
    "parameter-bridge-equivalence-guards",
    equivalent && !verifies(alteredMarker) && !verifies(alteredField),
    "Only the bridge-produced positional tree is equivalent: an altered marker and an unrelated numeric AST field each fail verification.",
  ));

  const knownLocationNormalized = transformed.generatedJson.replace("18446744073709551615", "0");
  const invalidLocations = ["-1", "1.0", "1e3", "18446744073709551616"]
    .map((value) => serialized.replace("18446744073709551615", value));
  // A recognized node *type* is insufficient: query_location is permitted
  // only at the parser's known node paths. This injects a known SELECT_NODE
  // shape at an otherwise unknown root branch.
  const spoofKnownNodeAtUnknownPath = serialized.replace('"error":false,', '"error":false,"spoof":{"type":"SELECT_NODE","query_location":0},');
  // Regression shape observed in review: a recognized VALUE_PARAMETER placed
  // under SELECT_NODE.unknown_branch. Changing only its query_location after
  // bridge/deparse must never be semantic equivalence.
  const knownNodeAtUnknownSelectPath = serialized.replace('"select_list":[', '"unknown_branch":{"type":"VALUE_PARAMETER","identifier":"a1","query_location":1},"select_list":[');
  const wrongPathGenerated = tryBridge(knownNodeAtUnknownSelectPath);
  const wrongPathLocationChanged = wrongPathGenerated?.generatedJson.replace('"unknown_branch":{"identifier":"1","query_location":1,"type":"VALUE_PARAMETER"}', '"unknown_branch":{"identifier":"1","query_location":2,"type":"VALUE_PARAMETER"}');
  const wrongPathRejected = wrongPathGenerated == null
    || !verifiesFrom(knownNodeAtUnknownSelectPath, wrongPathLocationChanged);
  checks.push(control(
    "parameter-bridge-query-location-guards",
    verifies(knownLocationNormalized)
      && invalidLocations.every((candidate) => throwsBridge(candidate))
      && throwsBridge(spoofKnownNodeAtUnknownPath)
      && wrongPathRejected,
    "Only an approved parser-node path uint64 query_location is semantically normalized; invalid numeric lexemes, overflow, root spoofing, and known-node wrong-path changes are rejected.",
  ));
  return checks;
}

function throwsBridge(candidate) {
  return tryBridge(candidate) == null;
}

function tryBridge(candidate) {
  try {
    return bridge.bridgeNamedParameters({ serialized: candidate, parameters, ...limits });
  } catch {
    return null;
  }
}

function verifies(reparsedSerialized) {
  return verifiesFrom(serialized, reparsedSerialized);
}

function verifiesFrom(originalSerialized, reparsedSerialized) {
  if (typeof reparsedSerialized !== "string") return false;
  try {
    bridge.verifyPositionalBridge({
      originalSerialized,
      reparsedSerialized,
      parameters,
      ...limits,
    });
    return true;
  } catch {
    return false;
  }
}

function tryPolicyView(candidate, maxAstNodes, maxGeneratedBytes) {
  try {
    return bridge.policyAstFromSerialized(candidate, maxAstNodes, maxGeneratedBytes);
  } catch {
    return null;
  }
}

function withNestedPadding(depth) {
  let nested = "null";
  for (let index = 0; index < depth; index += 1) nested = `{"padding":${nested}}`;
  return serialized.replace('"safe_numeric":42', `"safe_numeric":42,"deep_padding":${nested}`);
}

function withWidePadding(count) {
  return serialized.replace('"safe_numeric":42', `"safe_numeric":42,"wide_padding":[${Array.from({ length: count }, () => "0").join(",")}]`);
}

function control(id, pass, details) {
  return { id, status: pass ? "pass" : "fail", details };
}
