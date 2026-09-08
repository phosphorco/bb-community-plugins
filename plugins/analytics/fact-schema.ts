const FACT_TABLE = "tool_execution_fact_v1";

const FACT_COLUMNS_SQL = `
  source_event_id: 'VARCHAR',
  thread_id: 'VARCHAR',
  turn_id: 'VARCHAR',
  sequence: 'BIGINT',
  project_id: 'VARCHAR',
  provider_id: 'VARCHAR',
  created_at_ms: 'BIGINT',
  turn_started_at_ms: 'BIGINT',
  turn_completed_at_ms: 'BIGINT',
  capability_kind: 'VARCHAR',
  capability_key: 'VARCHAR',
  status: 'VARCHAR',
  duration_ms: 'BIGINT',
  failed: 'BOOLEAN',
  error_class: 'VARCHAR',
  error_signature: 'VARCHAR',
  command_binary: 'VARCHAR',
  command_argument_1: 'VARCHAR',
  command_argument_2: 'VARCHAR',
  command_uses_help: 'BOOLEAN',
  command_shape: 'VARCHAR',
  command_shell_wrapped: 'BOOLEAN',
  command_attribution_eligible: 'BOOLEAN'
`;

export function emptyFactTableSql(): string {
  return `
    CREATE OR REPLACE TABLE ${FACT_TABLE} AS SELECT
      NULL::VARCHAR AS source_event_id,
      NULL::VARCHAR AS thread_id,
      NULL::VARCHAR AS turn_id,
      NULL::BIGINT AS sequence,
      NULL::VARCHAR AS project_id,
      NULL::VARCHAR AS provider_id,
      NULL::BIGINT AS created_at_ms,
      NULL::BIGINT AS turn_started_at_ms,
      NULL::BIGINT AS turn_completed_at_ms,
      NULL::VARCHAR AS capability_kind,
      NULL::VARCHAR AS capability_key,
      NULL::VARCHAR AS status,
      NULL::BIGINT AS duration_ms,
      NULL::BOOLEAN AS failed,
      NULL::VARCHAR AS error_class,
      NULL::VARCHAR AS error_signature,
      NULL::VARCHAR AS command_binary,
      NULL::VARCHAR AS command_argument_1,
      NULL::VARCHAR AS command_argument_2,
      false AS command_uses_help,
      NULL::VARCHAR AS command_shape,
      false AS command_shell_wrapped,
      false AS command_attribution_eligible
    WHERE false
  `;
}

/** The file name is an internal fixed value, never an authored SQL value. */
export function materializeFactTableSql(fileName: string): string {
  return `
    CREATE OR REPLACE TABLE ${FACT_TABLE} AS
    SELECT * FROM read_json_auto(
      '${fileName}',
      format = 'newline_delimited',
      columns = { ${FACT_COLUMNS_SQL} }
    )
  `;
}
