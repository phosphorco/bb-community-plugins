const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const PARAMETER_BRIDGE_TRANSFORM_REVISION = "analytics-parameter-bridge-ast-v3";
const PARAMETER_BRIDGE_SOURCE_SHA256 = createHash("sha256")
  .update(readFileSync(__filename))
  .digest("hex");

const MAX_PARAMETERS = 32;
const MAX_AST_DEPTH = 128;
const TOKEN_MULTIPLIER = 96;
const UINT64_MAX = "18446744073709551615";
const MAX_LOGICAL_METADATA_DEPTH = 8;
// These objects are not executable parser nodes. They are marked only after
// reaching one of the two serializer-owned metadata terminals below and after
// validating their complete, closed envelopes. The worker retains its generic
// JSON walk and may exempt only these exact cloned identities.
const VALIDATED_LOGICAL_TYPE_METADATA = new WeakSet();
const VALIDATED_ORDER_BY_ENVELOPES = new WeakSet();
const SCALAR_LOGICAL_TYPE_IDS = new Set([
  "BOOLEAN",
  "TINYINT",
  "UTINYINT",
  "SMALLINT",
  "USMALLINT",
  "INTEGER",
  "UINTEGER",
  "BIGINT",
  "UBIGINT",
  "HUGEINT",
  "UHUGEINT",
  "FLOAT",
  "DOUBLE",
  "DECIMAL",
  "VARCHAR",
  "DATE",
  "TIME",
  "TIME_NS",
  "TIME_TZ",
  "TIMESTAMP",
  "TIMESTAMP_SEC",
  "TIMESTAMP_MS",
  "TIMESTAMP_NS",
  "TIMESTAMP_TZ",
  "INTERVAL",
  "UUID",
  "SQLNULL",
  "INTEGER_LITERAL",
]);
// This is intentionally the same closed node vocabulary as the worker policy.
// A query_location outside these exact parser-node objects is not normalized.
const QUERY_LOCATION_NODE_TYPES = new Set([
  "SELECT_NODE",
  "BASE_TABLE",
  "STAR",
  "COLUMN_REF",
  "FUNCTION",
  "WINDOW_LAG",
  "WINDOW_ROW_NUMBER",
  "WINDOW_RANK",
  "WINDOW_DENSE_RANK",
  "WINDOW",
  "COMPARE_EQUAL",
  "COMPARE_NOTEQUAL",
  "COMPARE_LESSTHAN",
  "COMPARE_LESSTHANOREQUALTO",
  "COMPARE_GREATERTHAN",
  "COMPARE_GREATERTHANOREQUALTO",
  "CONJUNCTION_AND",
  "CONJUNCTION_OR",
  "OPERATOR_NOT",
  "OPERATOR_IS_NULL",
  "OPERATOR_IS_NOT_NULL",
  "OPERATOR_PLUS",
  "OPERATOR_MINUS",
  "OPERATOR_MULTIPLY",
  "OPERATOR_DIVIDE",
  "OPERATOR_CONCAT",
  "OPERATOR_COALESCE",
  "OPERATOR_CAST",
  "VALUE_CONSTANT",
  "VALUE_PARAMETER",
  "CASE_EXPR",
  "ORDER_MODIFIER",
  "EMPTY",
  "CROSS_PRODUCT",
  "COMPARISON_JOIN",
  "ANY_JOIN",
  "JOIN",
  "LEFT_JOIN",
  "RIGHT_JOIN",
  "INNER_JOIN",
]);
// Every permitted query_location-bearing node must be reachable from the
// statement's `node` field by one of these serializer-owned edges. This is
// deliberately separate from node-type admission: a known node placed in an
// arbitrary JSON property is not a parser node.
const EXPRESSION_NODE_TYPES = new Set([
  "STAR",
  "COLUMN_REF",
  "FUNCTION",
  "WINDOW_LAG",
  "WINDOW_ROW_NUMBER",
  "WINDOW_RANK",
  "WINDOW_DENSE_RANK",
  "WINDOW",
  "COMPARE_EQUAL",
  "COMPARE_NOTEQUAL",
  "COMPARE_LESSTHAN",
  "COMPARE_LESSTHANOREQUALTO",
  "COMPARE_GREATERTHAN",
  "COMPARE_GREATERTHANOREQUALTO",
  "CONJUNCTION_AND",
  "CONJUNCTION_OR",
  "OPERATOR_NOT",
  "OPERATOR_IS_NULL",
  "OPERATOR_IS_NOT_NULL",
  "OPERATOR_PLUS",
  "OPERATOR_MINUS",
  "OPERATOR_MULTIPLY",
  "OPERATOR_DIVIDE",
  "OPERATOR_CONCAT",
  "OPERATOR_COALESCE",
  "OPERATOR_CAST",
  "VALUE_CONSTANT",
  "VALUE_PARAMETER",
  "CASE_EXPR",
]);
const RELATION_NODE_TYPES = new Set([
  "BASE_TABLE",
  "EMPTY",
  "CROSS_PRODUCT",
  "COMPARISON_JOIN",
  "ANY_JOIN",
  "JOIN",
  "LEFT_JOIN",
  "RIGHT_JOIN",
  "INNER_JOIN",
]);
const WINDOW_NODE_TYPES = new Set([
  "WINDOW",
  "WINDOW_LAG",
  "WINDOW_ROW_NUMBER",
  "WINDOW_RANK",
  "WINDOW_DENSE_RANK",
]);
const SELECT_MODIFIER_NODE_TYPES = new Set([
  "ORDER_MODIFIER",
  "LIMIT_MODIFIER",
]);
const NODE_CHILD_TRANSITIONS = Object.freeze({
  SELECT_NODE: {
    cte_map: "cte-map",
    select_list: "expression-list",
    from_table: "relation",
    where_clause: "expression",
    group_expressions: "expression-list",
    having: "expression",
    qualify: "expression",
    modifiers: "select-modifier-list",
  },
  FUNCTION: {
    children: "expression-list",
    filter: "expression",
    order_bys: "modifier",
    window: "window",
  },
  WINDOW_LAG: windowTransitions(),
  WINDOW_ROW_NUMBER: windowTransitions(),
  WINDOW_RANK: windowTransitions(),
  WINDOW_DENSE_RANK: windowTransitions(),
  WINDOW: windowTransitions(),
  COMPARE_EQUAL: { left: "expression", right: "expression" },
  COMPARE_NOTEQUAL: { left: "expression", right: "expression" },
  COMPARE_LESSTHAN: { left: "expression", right: "expression" },
  COMPARE_LESSTHANOREQUALTO: { left: "expression", right: "expression" },
  COMPARE_GREATERTHAN: { left: "expression", right: "expression" },
  COMPARE_GREATERTHANOREQUALTO: { left: "expression", right: "expression" },
  CONJUNCTION_AND: { children: "expression-list" },
  CONJUNCTION_OR: { children: "expression-list" },
  OPERATOR_NOT: { child: "expression", children: "expression-list" },
  OPERATOR_IS_NULL: { child: "expression", children: "expression-list" },
  OPERATOR_IS_NOT_NULL: { child: "expression", children: "expression-list" },
  OPERATOR_PLUS: {
    left: "expression",
    right: "expression",
    children: "expression-list",
  },
  OPERATOR_MINUS: {
    left: "expression",
    right: "expression",
    children: "expression-list",
  },
  OPERATOR_MULTIPLY: {
    left: "expression",
    right: "expression",
    children: "expression-list",
  },
  OPERATOR_DIVIDE: {
    left: "expression",
    right: "expression",
    children: "expression-list",
  },
  OPERATOR_CONCAT: {
    left: "expression",
    right: "expression",
    children: "expression-list",
  },
  OPERATOR_COALESCE: { children: "nonempty-expression-list" },
  OPERATOR_CAST: { child: "expression", children: "expression-list" },
  CASE_EXPR: { case_checks: "case-checks", else_expr: "expression" },
  ORDER_MODIFIER: { orders: "orders" },
  LIMIT_MODIFIER: { limit: "expression", offset: "expression" },
  CROSS_PRODUCT: {
    left: "relation",
    right: "relation",
    children: "relation-list",
  },
  COMPARISON_JOIN: {
    left: "relation",
    right: "relation",
    condition: "expression",
  },
  ANY_JOIN: { left: "relation", right: "relation", condition: "expression" },
  JOIN: { left: "relation", right: "relation", condition: "expression" },
  LEFT_JOIN: { left: "relation", right: "relation", condition: "expression" },
  RIGHT_JOIN: { left: "relation", right: "relation", condition: "expression" },
  INNER_JOIN: { left: "relation", right: "relation", condition: "expression" },
});

function windowTransitions() {
  return Object.freeze({
    children: "expression-list",
    partitions: "expression-list",
    orders: "orders",
    start_expr: "expression",
    end_expr: "expression",
    offset_expr: "expression",
    default_expr: "expression",
    filter_expr: "expression",
    arg_orders: "orders",
  });
}

const REVIVER_SOURCE_AVAILABLE = (() => {
  let source = null;
  JSON.parse("18446744073709551615", (_key, _value, context) => {
    source = context?.source;
    return _value;
  });
  return source === "18446744073709551615";
})();

class NumericLexeme {
  constructor(source) {
    this.source = source;
  }
}

function bridgeNamedParameters({
  serialized,
  parameters,
  maxAstNodes,
  maxGeneratedBytes,
}) {
  const original = parseSerializedAst(
    serialized,
    maxAstNodes,
    maxGeneratedBytes,
  );
  validateQueryLocations(original);
  const declarations = validateDeclarations(parameters);
  const statement = singleSelectStatement(original);
  const positions = validateNamedMap(statement.named_param_map, declarations);
  const clone = cloneJson(original);
  const clonedStatement = singleSelectStatement(clone);
  const seen = new Set();
  rewriteParameterIdentifiers(clonedStatement, positions, seen);
  if (seen.size !== positions.size) {
    throw new Error("Parser AST does not contain every declared parameter.");
  }
  clonedStatement.named_param_map = positionalNamedMap(positions.size);
  const generatedJson = canonicalJson(clone, maxGeneratedBytes);
  return {
    generatedJson,
    boundValues: Array.from(
      { length: positions.size },
      (_, index) => positions.get(index + 1).value,
    ),
    positionalCount: positions.size,
    // The policy walker only branches on string/object/array structure. Keep
    // every numeric lexeme exact without exposing NumericLexeme as caller data.
    policyAst: policyAst(original),
  };
}

function policyAstFromSerialized(serialized, maxAstNodes, maxGeneratedBytes) {
  const parsed = parseSerializedAst(
    serialized,
    maxAstNodes,
    maxGeneratedBytes,
  );
  validateQueryLocations(parsed);
  singleSelectStatement(parsed);
  return policyAst(parsed, validatedPolicyEnvelopes(parsed));
}

function isValidatedLogicalTypeMetadata(value) {
  return plainObject(value) && VALIDATED_LOGICAL_TYPE_METADATA.has(value);
}

function isValidatedOrderByEnvelope(value) {
  return plainObject(value) && VALIDATED_ORDER_BY_ENVELOPES.has(value);
}

function verifyPositionalBridge({
  originalSerialized,
  reparsedSerialized,
  parameters,
  maxAstNodes,
  maxGeneratedBytes,
}) {
  const expected = bridgeNamedParameters({
    serialized: originalSerialized,
    parameters,
    maxAstNodes,
    maxGeneratedBytes,
  });
  const reparsed = parseSerializedAst(
    reparsedSerialized,
    maxAstNodes,
    maxGeneratedBytes,
  );
  validateQueryLocations(reparsed);
  const reparsedStatement = singleSelectStatement(reparsed);
  const positionalCount = validatePositionalAst(reparsedStatement);
  if (positionalCount !== expected.positionalCount) {
    throw new Error(
      "Reparsed positional AST has an unexpected parameter count.",
    );
  }
  const expectedTree = parseSerializedAst(
    expected.generatedJson,
    maxAstNodes,
    maxGeneratedBytes,
  );
  normalizePermittedMetadata(expectedTree);
  normalizePermittedMetadata(reparsed);
  if (
    canonicalJson(expectedTree, maxGeneratedBytes) !==
      canonicalJson(reparsed, maxGeneratedBytes)
  ) {
    throw new Error(
      "Reparsed AST differs from the permitted parameter bridge.",
    );
  }
  return true;
}

function parseSerializedAst(serialized, maxAstNodes, maxBytes) {
  if (
    !REVIVER_SOURCE_AVAILABLE || typeof serialized !== "string" ||
    !Number.isSafeInteger(maxAstNodes) || maxAstNodes < 1 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
    Buffer.byteLength(serialized) > maxBytes
  ) throw new Error("Serialized parser AST exceeds the bridge limits.");
  let root;
  try {
    root = JSON.parse(serialized, (_key, value, context) => {
      if (typeof value !== "number") return value;
      if (typeof context?.source !== "string" || !jsonNumber(context.source)) {
        throw new Error("JSON numeric source is unavailable.");
      }
      return new NumericLexeme(context.source);
    });
  } catch {
    throw new Error("Parser did not return a valid lossless JSON AST.");
  }
  validateTreeBounds(root, maxAstNodes);
  return root;
}

function validateTreeBounds(root, maxAstNodes) {
  const maxTokens = maxAstNodes * TOKEN_MULTIPLIER;
  let tokens = 0;
  const walk = (value, depth) => {
    if (++tokens > maxTokens || depth > MAX_AST_DEPTH) {
      throw new Error("Parser AST exceeds the bridge node or depth limit.");
    }
    if (
      value == null || typeof value !== "object" ||
      value instanceof NumericLexeme
    ) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("Parser AST contains an unsupported object value.");
    }
    for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(root, 0);
}

function validateDeclarations(parameters) {
  if (!Array.isArray(parameters) || parameters.length > MAX_PARAMETERS) {
    throw new Error("Parameter declarations exceed the bridge limit.");
  }
  const declarations = new Map();
  for (const parameter of parameters) {
    if (
      parameter == null || typeof parameter !== "object" ||
      Array.isArray(parameter) ||
      !exactKeys(parameter, ["name", "logicalType", "value"]) ||
      !parameterName(parameter.name) || declarations.has(parameter.name)
    ) throw new Error("Parameter declarations are malformed.");
    declarations.set(parameter.name, parameter);
  }
  return declarations;
}

function singleSelectStatement(root) {
  if (
    !plainObject(root) || root.error !== false ||
    !exactKeys(root, ["error", "statements"]) ||
    !Array.isArray(root.statements) ||
    root.statements.length !== 1 || !plainObject(root.statements[0]) ||
    !exactKeys(root.statements[0], ["node", "named_param_map"]) ||
    !plainObject(root.statements[0].node) ||
    root.statements[0].node.type !== "SELECT_NODE" ||
    !Object.hasOwn(root.statements[0], "named_param_map")
  ) throw new Error("Parser AST must contain exactly one SELECT statement.");
  return root.statements[0];
}

function validateNamedMap(map, declarations) {
  if (!Array.isArray(map) || map.length !== declarations.size) {
    throw new Error("Parser AST named parameter map is incomplete.");
  }
  const positions = new Map();
  const names = new Set();
  for (const entry of map) {
    if (!plainObject(entry) || !exactKeys(entry, ["key", "value"])) {
      throw new Error("Parser AST named parameter map is malformed.");
    }
    const name = entry.key;
    const position = positiveSafeInteger(entry.value);
    if (
      !parameterName(name) || !declarations.has(name) || names.has(name) ||
      positions.has(position) || position > declarations.size
    ) throw new Error("Parser AST named parameter map is not a bijection.");
    names.add(name);
    positions.set(position, declarations.get(name));
  }
  for (let position = 1; position <= declarations.size; position++) {
    if (!positions.has(position)) {
      throw new Error(
        "Parser AST named parameter positions are not contiguous.",
      );
    }
  }
  return positions;
}

function rewriteParameterIdentifiers(statement, positions, seen) {
  walkJson(statement, (node) => {
    if (!plainObject(node) || node.type !== "VALUE_PARAMETER") return;
    if (typeof node.identifier !== "string") {
      throw new Error("Parser AST parameter marker is malformed.");
    }
    const match = [...positions].find(([, parameter]) =>
      parameter.name === node.identifier
    );
    if (!match) {
      throw new Error(
        "Parser AST parameter marker is absent from its named map.",
      );
    }
    const [position] = match;
    seen.add(position);
    node.identifier = String(position);
  });
}

function positionalNamedMap(count) {
  return Array.from({ length: count }, (_, index) => ({
    key: String(index + 1),
    value: new NumericLexeme(String(index + 1)),
  }));
}

function validatePositionalAst(statement) {
  if (!Array.isArray(statement.named_param_map)) {
    throw new Error("Reparsed AST has no positional parameter map.");
  }
  const expected = new Set();
  for (const entry of statement.named_param_map) {
    if (!plainObject(entry) || !exactKeys(entry, ["key", "value"])) {
      throw new Error("Reparsed AST parameter map is malformed.");
    }
    const position = positiveSafeInteger(entry.value);
    if (entry.key !== String(position) || expected.has(position)) {
      throw new Error("Reparsed AST parameter map is not positional.");
    }
    expected.add(position);
  }
  for (let position = 1; position <= expected.size; position++) {
    if (!expected.has(position)) {
      throw new Error(
        "Reparsed AST positional parameter map is not contiguous.",
      );
    }
  }
  const seen = new Set();
  walkJson(statement, (node) => {
    if (!plainObject(node) || node.type !== "VALUE_PARAMETER") return;
    const position = positiveSafeInteger(node.identifier);
    if (!expected.has(position)) {
      throw new Error("Reparsed AST marker is absent from its positional map.");
    }
    seen.add(position);
  });
  if (seen.size !== expected.size) {
    throw new Error("Reparsed AST omits a positional parameter marker.");
  }
  return expected.size;
}

function validateQueryLocations(root) {
  const permittedNodes = permittedLocationNodes(root);
  walkJson(root, (node) => {
    if (!plainObject(node) || !Object.hasOwn(node, "query_location")) return;
    if (!permittedNodes.has(node)) {
      throw new Error(
        "Parser AST query_location is outside an approved node path.",
      );
    }
    if (!QUERY_LOCATION_NODE_TYPES.has(node.type)) {
      throw new Error("Parser AST query_location is not on an approved node.");
    }
    uint64Location(node.query_location);
  });
}

function permittedLocationNodes(root) {
  const statement = singleSelectStatement(root);
  const nodes = new WeakSet();
  collectPermittedParserNode(statement.node, new Set(["SELECT_NODE"]), nodes);
  return nodes;
}

function validatedPolicyEnvelopes(root) {
  const statement = singleSelectStatement(root);
  const logicalMetadata = new WeakSet();
  const orderByEnvelopes = new WeakSet();
  collectPermittedParserNode(
    statement.node,
    new Set(["SELECT_NODE"]),
    new WeakSet(),
    (node) => {
      if (node.type === "VALUE_CONSTANT") {
        validateValueTerminal(node.value, logicalMetadata, 0);
      } else if (node.type === "OPERATOR_CAST") {
        validateLogicalTypeTerminal(node.cast_type, logicalMetadata, 0);
      }
    },
    (order) => validateOrderByEnvelope(order, orderByEnvelopes),
  );
  return { logicalMetadata, orderByEnvelopes };
}

function collectPermittedParserNode(
  node,
  expectedTypes,
  permittedNodes,
  visit,
  visitOrder,
) {
  if (!plainObject(node) || !expectedTypes.has(node.type)) {
    throw new Error(
      "Parser AST node has an unexpected type at an approved path.",
    );
  }
  permittedNodes.add(node);
  visit?.(node);
  if (
    node.type === "OPERATOR_COALESCE" &&
    (!Object.hasOwn(node, "children") || !Array.isArray(node.children) ||
      node.children.length === 0)
  ) throw new Error("Parser AST COALESCE has no arguments.");
  for (
    const [key, transition] of Object.entries(
      NODE_CHILD_TRANSITIONS[node.type] ?? {},
    )
  ) {
    if (Object.hasOwn(node, key)) {
      collectTransition(
        node[key],
        transition,
        permittedNodes,
        visit,
        visitOrder,
      );
    }
  }
}

function collectTransition(
  value,
  transition,
  permittedNodes,
  visit,
  visitOrder,
) {
  if (value == null) return;
  if (transition === "expression") {
    return collectPermittedParserNode(
      value,
      EXPRESSION_NODE_TYPES,
      permittedNodes,
      visit,
      visitOrder,
    );
  }
  if (transition === "relation") {
    return collectPermittedParserNode(
      value,
      RELATION_NODE_TYPES,
      permittedNodes,
      visit,
      visitOrder,
    );
  }
  if (transition === "window") {
    return collectPermittedParserNode(
      value,
      WINDOW_NODE_TYPES,
      permittedNodes,
      visit,
      visitOrder,
    );
  }
  if (transition === "modifier") {
    return collectPermittedParserNode(
      value,
      new Set(["ORDER_MODIFIER"]),
      permittedNodes,
      visit,
      visitOrder,
    );
  }
  if (
    transition === "expression-list" ||
    transition === "nonempty-expression-list" ||
    transition === "relation-list" ||
    transition === "select-modifier-list"
  ) {
    if (
      !Array.isArray(value) ||
      (transition === "nonempty-expression-list" && value.length === 0)
    ) {
      throw new Error("Parser AST child list has an unexpected shape.");
    }
    const expected = transition === "expression-list" ||
        transition === "nonempty-expression-list"
      ? EXPRESSION_NODE_TYPES
      : transition === "relation-list"
      ? RELATION_NODE_TYPES
      : SELECT_MODIFIER_NODE_TYPES;
    for (const item of value) {
      collectPermittedParserNode(
        item,
        expected,
        permittedNodes,
        visit,
        visitOrder,
      );
    }
    return;
  }
  if (transition === "cte-map") {
    return collectCteMap(value, permittedNodes, visit, visitOrder);
  }
  if (transition === "case-checks") {
    return collectCaseChecks(value, permittedNodes, visit, visitOrder);
  }
  if (transition === "orders") {
    return collectOrders(value, permittedNodes, visit, visitOrder);
  }
  throw new Error("Parser AST contains an unrecognized node transition.");
}

function collectCteMap(value, permittedNodes, visit, visitOrder) {
  if (!plainObject(value) || !Array.isArray(value.map)) {
    throw new Error("Parser AST CTE map has an unexpected shape.");
  }
  for (const entry of value.map) {
    if (
      !plainObject(entry) || !plainObject(entry.value) ||
      !plainObject(entry.value.query) || !plainObject(entry.value.query.node)
    ) throw new Error("Parser AST CTE map entry has an unexpected shape.");
    collectPermittedParserNode(
      entry.value.query.node,
      new Set(["SELECT_NODE"]),
      permittedNodes,
      visit,
      visitOrder,
    );
  }
}

function collectCaseChecks(value, permittedNodes, visit, visitOrder) {
  if (!Array.isArray(value)) {
    throw new Error("Parser AST case checks have an unexpected shape.");
  }
  for (const item of value) {
    if (!plainObject(item)) {
      throw new Error("Parser AST case check has an unexpected shape.");
    }
    if (item.when_expr != null) {
      collectPermittedParserNode(
        item.when_expr,
        EXPRESSION_NODE_TYPES,
        permittedNodes,
        visit,
        visitOrder,
      );
    }
    if (item.then_expr != null) {
      collectPermittedParserNode(
        item.then_expr,
        EXPRESSION_NODE_TYPES,
        permittedNodes,
        visit,
        visitOrder,
      );
    }
  }
}

function collectOrders(value, permittedNodes, visit, visitOrder) {
  if (!Array.isArray(value)) {
    throw new Error("Parser AST orders have an unexpected shape.");
  }
  for (const item of value) {
    visitOrder?.(item);
    if (!plainObject(item) || item.expression == null) {
      throw new Error("Parser AST order has an unexpected shape.");
    }
    collectPermittedParserNode(
      item.expression,
      EXPRESSION_NODE_TYPES,
      permittedNodes,
      visit,
      visitOrder,
    );
  }
}

function validateOrderByEnvelope(value, envelopes) {
  if (
    !plainObject(value) ||
    !exactKeys(value, ["type", "null_order", "expression"]) ||
    !new Set(["ORDER_DEFAULT", "ASCENDING", "DESCENDING"]).has(value.type) ||
    !new Set(["ORDER_DEFAULT", "NULLS FIRST", "NULLS LAST"]).has(
      value.null_order,
    )
  ) throw new Error("Parser AST order envelope is malformed.");
  envelopes.add(value);
}

function validateValueTerminal(value, metadata, depth) {
  if (
    !plainObject(value) ||
    typeof value.is_null !== "boolean"
  ) throw new Error("Parser AST constant value metadata is malformed.");
  validateLogicalTypeTerminal(value.type, metadata, depth + 1);
  if (value.is_null) {
    if (!exactKeys(value, ["type", "is_null"])) {
      throw new Error("Parser AST null constant metadata is malformed.");
    }
    return;
  }
  if (!exactKeys(value, ["type", "is_null", "value"])) {
    throw new Error("Parser AST constant value metadata is malformed.");
  }
  if (
    value.value !== null && typeof value.value !== "string" &&
    typeof value.value !== "boolean" && !(value.value instanceof NumericLexeme)
  ) throw new Error("Parser AST constant has an unsupported payload.");
}

function validateLogicalTypeTerminal(value, metadata, depth) {
  if (depth > MAX_LOGICAL_METADATA_DEPTH || !plainObject(value)) {
    throw new Error("Parser AST logical type metadata is malformed.");
  }
  if (
    !closedKeys(value, ["id", "type_info"], ["id"]) ||
    typeof value.id !== "string" || !SCALAR_LOGICAL_TYPE_IDS.has(value.id)
  ) throw new Error("Parser AST logical type is outside the scalar policy.");
  const typeInfo = value.type_info;
  if (value.id === "DECIMAL") {
    if (typeInfo == null) {
      throw new Error("Parser AST decimal metadata is missing.");
    }
    metadata.add(value);
    validateDecimalTypeInfo(typeInfo, metadata);
    return;
  }
  if (value.id === "INTEGER_LITERAL") {
    if (typeInfo == null) {
      throw new Error("Parser AST integer literal metadata is missing.");
    }
    metadata.add(value);
    validateIntegerLiteralTypeInfo(typeInfo, metadata, depth + 1);
    return;
  }
  if (typeInfo != null) {
    throw new Error("Parser AST scalar type has unexpected metadata.");
  }
}

function validateDecimalTypeInfo(value, metadata) {
  if (
    !plainObject(value) ||
    !closedKeys(
      value,
      ["type", "alias", "extension_info", "width", "scale"],
      ["type", "width", "scale"],
    ) ||
    value.type !== "DECIMAL_TYPE_INFO" || !emptyBaseTypeInfo(value) ||
    !decimalWidth(value.width) || !decimalScale(value.scale, value.width)
  ) throw new Error("Parser AST decimal metadata is malformed.");
  metadata.add(value);
}

function validateIntegerLiteralTypeInfo(value, metadata, depth) {
  if (
    !plainObject(value) ||
    !closedKeys(
      value,
      ["type", "alias", "extension_info", "constant_value"],
      ["type", "constant_value"],
    ) ||
    value.type !== "INTEGER_LITERAL_TYPE_INFO" || !emptyBaseTypeInfo(value)
  ) throw new Error("Parser AST integer literal metadata is malformed.");
  metadata.add(value);
  validateValueTerminal(value.constant_value, metadata, depth + 1);
}

function emptyBaseTypeInfo(value) {
  return (!Object.hasOwn(value, "alias") || value.alias === "") &&
    (!Object.hasOwn(value, "extension_info") ||
      value.extension_info === null);
}

function decimalWidth(value) {
  const width = metadataSafeInteger(value);
  return width != null && width >= 1 && width <= 38;
}

function decimalScale(value, width) {
  const scale = metadataSafeInteger(value);
  const decimalWidth = metadataSafeInteger(width);
  return scale != null && decimalWidth != null && scale >= 0 &&
    scale <= decimalWidth;
}

function metadataSafeInteger(value) {
  if (
    !(value instanceof NumericLexeme) || !/^(?:0|[1-9]\d*)$/.test(value.source)
  ) {
    return null;
  }
  const numeric = Number(value.source);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function normalizePermittedMetadata(root) {
  const permittedNodes = permittedLocationNodes(root);
  walkJson(root, (node) => {
    if (!plainObject(node) || !Object.hasOwn(node, "query_location")) return;
    if (!permittedNodes.has(node)) {
      throw new Error(
        "Parser AST query_location is outside an approved node path.",
      );
    }
    if (!QUERY_LOCATION_NODE_TYPES.has(node.type)) {
      throw new Error("Parser AST query_location is not on an approved node.");
    }
    uint64Location(node.query_location);
    node.query_location = new NumericLexeme("0");
  });
  const statement = singleSelectStatement(root);
  if (Array.isArray(statement.named_param_map)) {
    statement.named_param_map.sort((left, right) =>
      positiveSafeInteger(left.value) - positiveSafeInteger(right.value)
    );
  }
}

function uint64Location(value) {
  if (
    !(value instanceof NumericLexeme) ||
    !/^(?:0|[1-9]\d{0,19})$/.test(value.source)
  ) {
    throw new Error(
      "Parser AST query_location is not an unsigned decimal uint64.",
    );
  }
  if (
    value.source.length === UINT64_MAX.length &&
    value.source > UINT64_MAX
  ) throw new Error("Parser AST query_location exceeds uint64.");
}

function positiveSafeInteger(value) {
  if (value instanceof NumericLexeme) {
    if (!/^[1-9]\d*$/.test(value.source)) {
      throw new Error(
        "Parser AST parameter position is not a positive integer.",
      );
    }
    const numeric = Number(value.source);
    if (!Number.isSafeInteger(numeric)) {
      throw new Error(
        "Parser AST parameter position is outside the safe range.",
      );
    }
    return numeric;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  throw new Error("Parser AST parameter position is not a positive integer.");
}

function walkJson(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
  } else if (plainObject(value)) {
    for (const item of Object.values(value)) walkJson(item, visit);
  }
}

function cloneJson(value) {
  if (value instanceof NumericLexeme) return new NumericLexeme(value.source);
  if (Array.isArray(value)) return value.map(cloneJson);
  if (plainObject(value)) {
    const clone = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      clone[key] = cloneJson(item);
    }
    return clone;
  }
  return value;
}

function policyAst(value, validatedEnvelopes) {
  if (value instanceof NumericLexeme) return value.source;
  if (Array.isArray(value)) {
    return value.map((item) => policyAst(item, validatedEnvelopes));
  }
  if (plainObject(value)) {
    const clone = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      clone[key] = policyAst(item, validatedEnvelopes);
    }
    if (validatedEnvelopes?.logicalMetadata?.has(value)) {
      VALIDATED_LOGICAL_TYPE_METADATA.add(clone);
    }
    if (validatedEnvelopes?.orderByEnvelopes?.has(value)) {
      VALIDATED_ORDER_BY_ENVELOPES.add(clone);
    }
    return clone;
  }
  return value;
}

function canonicalJson(value, maxBytes) {
  const encoded = encodeJson(value);
  if (Buffer.byteLength(encoded) > maxBytes) {
    throw new Error("Generated parser AST exceeds the bridge limit.");
  }
  return encoded;
}

function encodeJson(value) {
  if (value instanceof NumericLexeme) return value.source;
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${encodeJson(value[key])}`
      ).join(",")
    }}`;
  }
  throw new Error("Parser AST contains an unsupported JSON value.");
}

function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    !(value instanceof NumericLexeme) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function closedKeys(value, keys, required) {
  return Object.keys(value).every((key) => keys.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function jsonNumber(value) {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
}

function parameterName(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

module.exports = {
  PARAMETER_BRIDGE_SOURCE_SHA256,
  PARAMETER_BRIDGE_TRANSFORM_REVISION,
  bridgeNamedParameters,
  isValidatedLogicalTypeMetadata,
  isValidatedOrderByEnvelope,
  policyAstFromSerialized,
  verifyPositionalBridge,
};
