import {
  ColumnDefinition,
  DefaultValue,
  EnumDefinition,
  KnexSchema,
  Provider,
  TableDefinition,
} from '../dsl'
import {
  columnName,
  defaultConstraintName,
  defaultForeignKeyName,
  defaultIndexName,
  quoteIdent,
  quoteString,
  tableName,
} from './names'

export interface SqlMigration {
  up: MigrationStep[]
  down: MigrationStep[]
}

export interface RenderedSqlFile {
  fileName: string
  content: string
}

export interface RenderKnexMigrationOptions {
  migrationBaseName?: string
  rawSqlMode?: 'inline' | 'files'
  sqlFilesDirName?: string
}

export interface RenderedKnexMigration {
  content: string
  sqlFiles: RenderedSqlFile[]
}

export type MigrationStep =
  | string
  | { kind: 'raw'; sql: string }
  | { kind: 'createTable'; schema: KnexSchema; table: TableDefinition }
  | { kind: 'dropTable'; tableName: string }
  | { kind: 'addColumn'; schema: KnexSchema; table: TableDefinition; column: ColumnDefinition }
  | { kind: 'dropColumn'; tableName: string; columnName: string }
  | { kind: 'createIndex'; tableName: string; columns: string[]; name?: string }
  | { kind: 'dropIndex'; tableName: string; columns: string[]; name?: string }
  | { kind: 'addUnique'; tableName: string; columns: string[]; name?: string }
  | { kind: 'dropUnique'; tableName: string; columns: string[]; name?: string }

interface RenderContext {
  rawSqlMode: 'inline' | 'files'
  migrationBaseName: string
  sqlFilesDirName: string
  sqlFiles: RenderedSqlFile[]
  counters: Record<'up' | 'down', number>
}

export function createEnumSql(enumDefinition: EnumDefinition, provider: Provider = 'postgresql'): SqlMigration {
  if (!supportsNativeEnums(provider)) {
    return { up: [], down: [] }
  }

  const values = enumDefinition.values.map(quoteString).join(', ')
  return {
    up: [`CREATE TYPE ${quoteIdent(enumDefinition.name)} AS ENUM (${values});`],
    down: [`DROP TYPE IF EXISTS ${quoteIdent(enumDefinition.name)};`],
  }
}

export function addEnumValueSql(enumName: string, value: string, provider: Provider = 'postgresql'): SqlMigration {
  if (!supportsNativeEnums(provider)) {
    return { up: [], down: [] }
  }

  return {
    up: [`ALTER TYPE ${quoteIdent(enumName)} ADD VALUE IF NOT EXISTS ${quoteString(value)};`],
    down: [`-- PostgreSQL cannot safely remove enum value ${quoteString(value)} from ${quoteIdent(enumName)} automatically.`],
  }
}

export function createTableSql(schema: KnexSchema, table: TableDefinition): SqlMigration {
  const actualTableName = tableName(table)
  const columns = Object.values(table.columns)
  const up: MigrationStep[] = [{ kind: 'createTable', schema, table }]
  if (supportsUpdatedAtTrigger(schema.database.provider)) {
    for (const column of columns.filter((item) => item.updatedAt)) {
      up.push(...updatedAtTriggerSql(actualTableName, columnName(column)))
    }
  }

  if (usesPgCryptoExtension(schema.database.provider) && columns.some((column) => column.defaultValue?.kind === 'uuid')) {
    up.unshift('CREATE EXTENSION IF NOT EXISTS "pgcrypto";')
  }

  return {
    up,
    down: [{ kind: 'dropTable', tableName: actualTableName }],
  }
}

export function addColumnSql(
  schema: KnexSchema,
  table: TableDefinition,
  column: ColumnDefinition,
): SqlMigration {
  const actualTableName = tableName(table)
  const up: MigrationStep[] = [{ kind: 'addColumn', schema, table, column }]
  const down: MigrationStep[] = [{ kind: 'dropColumn', tableName: actualTableName, columnName: columnName(column) }]

  if (supportsUpdatedAtTrigger(schema.database.provider) && column.updatedAt) {
    up.push(...updatedAtTriggerSql(actualTableName, columnName(column)))
  }

  if (usesPgCryptoExtension(schema.database.provider) && column.defaultValue?.kind === 'uuid') {
    up.unshift('CREATE EXTENSION IF NOT EXISTS "pgcrypto";')
  }

  return { up, down }
}

export function createIndexMigrationSql(table: TableDefinition, columns: string[], name?: string): SqlMigration {
  const actualTableName = tableName(table)
  const actualColumns = columns.map((column) => resolveColumnName(table, column))
  return {
    up: [{ kind: 'createIndex', tableName: actualTableName, columns: actualColumns, name }],
    down: [{ kind: 'dropIndex', tableName: actualTableName, columns: actualColumns, name }],
  }
}

export function createUniqueMigrationSql(table: TableDefinition, columns: string[], name?: string): SqlMigration {
  const actualTableName = tableName(table)
  const actualColumns = columns.map((column) => resolveColumnName(table, column))
  const constraint = name ?? defaultConstraintName(actualTableName, actualColumns)
  return {
    up: [{ kind: 'addUnique', tableName: actualTableName, columns: actualColumns, name: constraint }],
    down: [{ kind: 'dropUnique', tableName: actualTableName, columns: actualColumns, name: constraint }],
  }
}

export function renderKnexMigration(migration: SqlMigration, options: RenderKnexMigrationOptions = {}) {
  return renderKnexMigrationWithFiles(migration, options).content
}

export function renderKnexMigrationWithFiles(
  migration: SqlMigration,
  options: RenderKnexMigrationOptions = {},
): RenderedKnexMigration {
  const context: RenderContext = {
    rawSqlMode: options.rawSqlMode ?? 'inline',
    migrationBaseName: options.migrationBaseName ?? 'migration',
    sqlFilesDirName: options.sqlFilesDirName ?? 'sql',
    sqlFiles: [],
    counters: { up: 0, down: 0 },
  }

  const upLines = renderMigrationSteps(migration.up, 'up', context)
  const downLines = renderMigrationSteps([...migration.down].reverse(), 'down', context)
  const usesSqlFiles = context.sqlFiles.length > 0
  const imports = usesSqlFiles
    ? [
        "import { readFile } from 'node:fs/promises'",
        "import { join } from 'node:path'",
        "import type { Knex } from 'knex'",
      ]
    : ["import type { Knex } from 'knex'"]

  return {
    content: [
      ...imports,
      '',
      'export async function up(knex: Knex): Promise<void> {',
      ...upLines,
      '}',
      '',
      'export async function down(knex: Knex): Promise<void> {',
      ...downLines,
      '}',
      ...(usesSqlFiles
        ? [
            '',
            'async function runSqlBlock(knex: Knex, fileName: string, blockName: string) {',
            `  const sql = await readFile(join(__dirname, ${literal(context.sqlFilesDirName)}, fileName), 'utf8')`,
            '  const marker = `-- knexty:block ${blockName}`',
            "  const endMarker = '-- knexty:end'",
            '  const start = sql.indexOf(marker)',
            '  if (start === -1) {',
            "    throw new Error(`SQL block ${blockName} was not found in ${fileName}.`)",
            '  }',
            '  const bodyStart = start + marker.length',
            '  const end = sql.indexOf(endMarker, bodyStart)',
            '  if (end === -1) {',
            "    throw new Error(`SQL block ${blockName} is missing an end marker in ${fileName}.`)",
            '  }',
            '  await knex.raw(sql.slice(bodyStart, end).trim())',
            '}',
          ]
        : []),
      '',
    ].join('\n'),
    sqlFiles: context.sqlFiles,
  }
}

function renderMigrationSteps(steps: MigrationStep[], direction: 'up' | 'down', context: RenderContext): string[] {
  const lines: string[] = []
  const rawBuffer: string[] = []

  const flushRaw = () => {
    if (rawBuffer.length === 0) {
      return
    }

    lines.push(...renderRaw(rawBuffer.join('\n'), direction, context))
    rawBuffer.length = 0
  }

  for (const step of steps) {
    const normalized = typeof step === 'string' ? { kind: 'raw' as const, sql: step } : step

    if (normalized.kind === 'raw' && context.rawSqlMode === 'files') {
      const trimmed = normalized.sql.trim()
      if (trimmed.startsWith('--')) {
        flushRaw()
        lines.push(renderSqlComment(trimmed))
      } else {
        rawBuffer.push(trimmed)
      }
      continue
    }

    flushRaw()
    lines.push(...renderMigrationStep(step, direction, context))
  }

  flushRaw()
  return lines
}

function renderMigrationStep(step: MigrationStep, direction: 'up' | 'down', context: RenderContext): string[] {
  const normalized = typeof step === 'string' ? { kind: 'raw' as const, sql: step } : step

  switch (normalized.kind) {
    case 'raw':
      return renderRaw(normalized.sql, direction, context)
    case 'createTable':
      return renderCreateTable(normalized.schema, normalized.table)
    case 'dropTable':
      return [`  await knex.schema.dropTableIfExists(${literal(normalized.tableName)})`]
    case 'addColumn':
      return renderAlterTable(normalized.table, [
        renderColumnBuilder(normalized.schema, normalized.column),
        ...renderColumnConstraints(normalized.schema, normalized.table, normalized.column),
      ])
    case 'dropColumn':
      return [
        `  await knex.schema.alterTable(${literal(normalized.tableName)}, (table) => {`,
        `    table.dropColumn(${literal(normalized.columnName)})`,
        '  })',
      ]
    case 'createIndex':
      return renderAlterTableByName(normalized.tableName, [
        `table.index(${literalArray(normalized.columns)}, ${literal(normalized.name ?? defaultIndexName(normalized.tableName, normalized.columns))})`,
      ])
    case 'dropIndex':
      return renderAlterTableByName(normalized.tableName, [
        `table.dropIndex(${literalArray(normalized.columns)}, ${literal(normalized.name ?? defaultIndexName(normalized.tableName, normalized.columns))})`,
      ])
    case 'addUnique':
      return renderAlterTableByName(normalized.tableName, [
        `table.unique(${literalArray(normalized.columns)}, { indexName: ${literal(normalized.name ?? defaultConstraintName(normalized.tableName, normalized.columns))} })`,
      ])
    case 'dropUnique':
      return renderAlterTableByName(normalized.tableName, [
        `table.dropUnique(${literalArray(normalized.columns)}, ${literal(normalized.name ?? defaultConstraintName(normalized.tableName, normalized.columns))})`,
      ])
    default:
      return renderRaw(`-- Unsupported migration step in ${direction}.`, direction, context)
  }
}

function renderRaw(sql: string, direction: 'up' | 'down', context: RenderContext): string[] {
  const trimmed = sql.trim()
  if (trimmed.startsWith('--')) {
    return [renderSqlComment(trimmed)]
  }

  if (context.rawSqlMode === 'files') {
    context.counters[direction] += 1
    const blockName = `${direction}.${String(context.counters[direction]).padStart(3, '0')}`
    const fileName = `${context.migrationBaseName}.${direction}.sql`
    const content = [`-- knexty:block ${blockName}`, trimmed, '-- knexty:end', ''].join('\n')
    const existingFile = context.sqlFiles.find((file) => file.fileName === fileName)

    if (existingFile) {
      existingFile.content += content
    } else {
      context.sqlFiles.push({ fileName, content })
    }

    return [`  await runSqlBlock(knex, ${literal(fileName)}, ${literal(blockName)})`]
  }

  return [`  await knex.raw(${JSON.stringify(sql)})`]
}

function renderSqlComment(sqlComment: string) {
  return `  // ${sqlComment.replace(/^--\s?/, '')}`
}

function renderCreateTable(schema: KnexSchema, table: TableDefinition): string[] {
  const actualTableName = tableName(table)
  const columns = Object.values(table.columns)
  return [
    `  await knex.schema.createTable(${literal(actualTableName)}, (table) => {`,
    ...columns.map((column) => `    ${renderColumnBuilder(schema, column)}`),
    ...renderTableConstraints(schema, table).map((statement) => `    ${statement}`),
    '  })',
  ]
}

function renderAlterTable(table: TableDefinition, statements: string[]): string[] {
  return renderAlterTableByName(tableName(table), statements)
}

function renderAlterTableByName(actualTableName: string, statements: string[]): string[] {
  return [
    `  await knex.schema.alterTable(${literal(actualTableName)}, (table) => {`,
    ...statements.map((statement) => `    ${statement}`),
    '  })',
  ]
}

function renderTableConstraints(schema: KnexSchema, table: TableDefinition) {
  const actualTableName = tableName(table)
  const columns = Object.values(table.columns)
  const primaryColumns = columns.filter((column) => column.primaryKey).map(columnName)
  const statements: string[] = []
  const singlePrimaryGeneratedIncrement = primaryColumns.length === 1
    && columns.some((column) => columnName(column) === primaryColumns[0] && isGeneratedIncrement(column))

  if (primaryColumns.length > 0 && !singlePrimaryGeneratedIncrement) {
    statements.push(
      `table.primary(${literalArray(primaryColumns)}, { constraintName: ${literal(`${actualTableName}_pkey`)} })`,
    )
  }

  for (const unique of uniqueDefinitions(table)) {
    const columns = unique.columns.map((column) => resolveColumnName(table, column))
    statements.push(
      `table.unique(${literalArray(columns)}, { indexName: ${literal(unique.name ?? defaultConstraintName(actualTableName, columns))} })`,
    )
  }

  for (const column of columns) {
    statements.push(...renderColumnConstraints(schema, table, column))
  }

  for (const index of table.indexes) {
    const columns = index.columns.map((column) => resolveColumnName(table, column))
    statements.push(
      `table.index(${literalArray(columns)}, ${literal(index.name ?? defaultIndexName(actualTableName, columns))})`,
    )
  }

  return statements
}

function renderColumnConstraints(schema: KnexSchema, table: TableDefinition, column: ColumnDefinition) {
  if (!column.reference) {
    return []
  }

  const actualTableName = tableName(table)
  const targetTable = findTable(schema, column.reference.table)
  const targetTableName = targetTable ? tableName(targetTable) : column.reference.table
  const targetColumnName = targetTable
    ? resolveColumnName(targetTable, column.reference.column)
    : column.reference.column
  const pieces = [
    `table.foreign(${literal(columnName(column))}, ${literal(defaultForeignKeyName(actualTableName, columnName(column)))})`,
    `.references(${literal(targetColumnName)})`,
    `.inTable(${literal(targetTableName)})`,
  ]

  if (column.reference.onDelete) {
    pieces.push(`.onDelete(${literal(column.reference.onDelete)})`)
  }

  return [pieces.join('')]
}

function renderColumnBuilder(schema: KnexSchema, column: ColumnDefinition) {
  const builder = columnBuilder(schema, column)
  const chain: string[] = [builder]

  if (!column.nullable && !isGeneratedPrimary(column)) {
    chain.push('.notNullable()')
  }

  if (column.unsigned) {
    chain.push('.unsigned()')
  }

  if (column.defaultValue && !(isGeneratedIncrement(column) && column.generated)) {
    chain.push(`.defaultTo(${defaultValueExpression(column.defaultValue)})`)
  }

  if (column.comment) {
    chain.push(`.comment(${literal(column.comment)})`)
  }

  if (column.collation) {
    chain.push(`.collate(${literal(column.collation)})`)
  }

  return chain.join('')
}

function columnBuilder(schema: KnexSchema, column: ColumnDefinition) {
  const name = literal(columnName(column))
  switch (column.type) {
    case 'bigint':
      return `table.bigInteger(${name})`
    case 'bigIncrements':
      return column.primaryKey
        ? `table.bigIncrements(${name})`
        : `table.bigIncrements(${name}, { primaryKey: false })`
    case 'bigInteger':
      return `table.bigInteger(${name})`
    case 'binary':
      return column.length ? `table.binary(${name}, ${column.length})` : `table.binary(${name})`
    case 'boolean':
      return `table.boolean(${name})`
    case 'date':
      return `table.date(${name})`
    case 'dateTime':
      return `table.dateTime(${name}, ${optionsObject({ useTz: column.useTz, precision: column.precision })})`
    case 'decimal':
      return column.precision && column.scale !== undefined
        ? `table.decimal(${name}, ${column.precision}, ${column.scale})`
        : `table.decimal(${name})`
    case 'double':
      return column.precision && column.scale !== undefined
        ? `table.double(${name}, ${column.precision}, ${column.scale})`
        : `table.double(${name})`
    case 'enum':
      return enumColumnBuilder(schema, column, name)
    case 'enu':
      return `table.enu(${name}, ${literalArray(column.enumValues ?? [])})`
    case 'float':
      return column.precision && column.scale !== undefined
        ? `table.float(${name}, ${column.precision}, ${column.scale})`
        : `table.float(${name})`
    case 'geography':
      return `table.geography(${name})`
    case 'geometry':
      return `table.geometry(${name})`
    case 'increments':
      return column.primaryKey
        ? `table.increments(${name})`
        : `table.increments(${name}, { primaryKey: false })`
    case 'integer':
      return `table.integer(${name})`
    case 'json':
      return `table.json(${name})`
    case 'jsonb':
      return `table.jsonb(${name})`
    case 'jsonbArray':
      return `table.specificType(${name}, 'JSONB[]')`
    case 'mediumint':
      return `table.mediumint(${name})`
    case 'point':
      return `table.point(${name})`
    case 'serial':
      return column.primaryKey ? `table.increments(${name})` : `table.specificType(${name}, 'SERIAL')`
    case 'smallint':
      return `table.smallint(${name})`
    case 'specificType':
      return `table.specificType(${name}, ${literal(column.specificType ?? 'TEXT')})`
    case 'string':
      return column.length ? `table.string(${name}, ${column.length})` : `table.string(${name})`
    case 'text':
      return column.textType ? `table.text(${name}, ${literal(column.textType)})` : `table.text(${name})`
    case 'textArray':
      return `table.specificType(${name}, 'TEXT[]')`
    case 'time':
      return `table.time(${name})`
    case 'timestamp':
      return `table.timestamp(${name}, ${optionsObject({ useTz: column.useTz, precision: column.precision ?? 3 })})`
    case 'tinyint':
      return column.length ? `table.tinyint(${name}, ${column.length})` : `table.tinyint(${name})`
    case 'uuid':
      return `table.uuid(${name})`
    default:
      return `table.text(${name})`
  }
}

function defaultValueExpression(defaultValue: DefaultValue) {
  switch (defaultValue.kind) {
    case 'literal':
      return defaultValue.value === null ? 'null' : JSON.stringify(defaultValue.value)
    case 'now':
      return 'knex.fn.now()'
    case 'raw':
      return `knex.raw(${JSON.stringify(defaultValue.sql)})`
    case 'uuid':
      return 'knex.fn.uuid()'
    default:
      return 'null'
  }
}

function enumColumnBuilder(schema: KnexSchema, column: ColumnDefinition, name: string) {
  const enumDefinition = column.enumName ? findEnumDefinition(schema, column.enumName) : undefined
  const enumValues = enumDefinition?.values
  if (!supportsNativeEnums(schema.database.provider) && enumValues) {
    return `table.enu(${name}, ${literalArray(enumValues)})`
  }

  return `table.specificType(${name}, ${literal(quoteIdent(enumDefinition?.name ?? column.enumName ?? 'unknown_enum'))})`
}

function isGeneratedPrimary(column: ColumnDefinition) {
  return isGeneratedIncrement(column) && column.primaryKey
}

function isGeneratedIncrement(column: ColumnDefinition) {
  return ['bigIncrements', 'increments', 'serial'].includes(column.type)
}

function supportsNativeEnums(provider: Provider) {
  return provider === 'postgresql' || provider === 'cockroachdb'
}

function supportsUpdatedAtTrigger(provider: Provider) {
  return provider === 'postgresql'
}

function usesPgCryptoExtension(provider: Provider) {
  return provider === 'postgresql'
}

function optionsObject(options: { useTz?: boolean; precision?: number }) {
  const entries = Object.entries(options).filter(([, value]) => value !== undefined)
  if (entries.length === 0) {
    return '{}'
  }

  return `{ ${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')} }`
}

function literal(value: string) {
  return JSON.stringify(value)
}

function literalArray(values: string[]) {
  return `[${values.map(literal).join(', ')}]`
}

function uniqueDefinitions(table: TableDefinition): Array<{ columns: string[]; name?: string }> {
  const columnUniques: Array<{ columns: string[]; name?: string }> = Object.values(table.columns)
    .filter((column) => column.unique)
    .map((column) => ({ columns: [columnName(column)] }))

  return [...columnUniques, ...table.uniques]
}

function findEnumDefinition(schema: KnexSchema, name: string) {
  return schema.enums[name] ?? Object.values(schema.enums).find((item) => item.name === name)
}

function findTable(schema: KnexSchema, name: string) {
  return schema.tables[name] ?? Object.values(schema.tables).find((table) => tableName(table) === name)
}

function resolveColumnName(table: TableDefinition, name: string) {
  const column = table.columns[name] ?? Object.values(table.columns).find((item) => {
    return item.name === name || columnName(item) === name
  })

  return column ? columnName(column) : name
}

function updatedAtTriggerSql(actualTableName: string, actualColumnName: string) {
  const functionName = 'linkedtech_set_updated_at'
  const triggerName = `${actualTableName}_${actualColumnName}_trigger`

  return [
    [
      `CREATE OR REPLACE FUNCTION ${quoteIdent(functionName)}() RETURNS TRIGGER AS $$`,
      'BEGIN',
      `  NEW.${quoteIdent(actualColumnName)} = CURRENT_TIMESTAMP;`,
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
    ].join('\n'),
    `DROP TRIGGER IF EXISTS ${quoteIdent(triggerName)} ON ${quoteIdent(actualTableName)};`,
    [
      `CREATE TRIGGER ${quoteIdent(triggerName)}`,
      `BEFORE UPDATE ON ${quoteIdent(actualTableName)}`,
      'FOR EACH ROW',
      `EXECUTE FUNCTION ${quoteIdent(functionName)}();`,
    ].join('\n'),
  ]
}
