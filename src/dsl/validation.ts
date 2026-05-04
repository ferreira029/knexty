import {
  ColumnDefinition,
  ColumnType,
  KnexSchema,
  Provider,
  TableDefinition,
} from './types'

export type SchemaValidationSeverity = 'error' | 'warning'

export interface SchemaValidationIssue {
  path: string
  message: string
  severity: SchemaValidationSeverity
}

export class SchemaValidationError extends Error {
  constructor(public readonly issues: SchemaValidationIssue[]) {
    super(
      [
        'Invalid knexty schema:',
        ...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
      ].join('\n'),
    )
    this.name = 'SchemaValidationError'
  }
}

const PROVIDERS: readonly Provider[] = [
  'postgresql',
  'cockroachdb',
  'mysql',
  'mysql2',
  'sqlite3',
  'better-sqlite3',
  'mssql',
  'oracledb',
  'redshift',
]

const COLUMN_TYPES: readonly ColumnType[] = [
  'bigint',
  'bigIncrements',
  'bigInteger',
  'binary',
  'boolean',
  'date',
  'dateTime',
  'decimal',
  'double',
  'enum',
  'enu',
  'float',
  'geography',
  'geometry',
  'increments',
  'integer',
  'json',
  'jsonb',
  'jsonbArray',
  'mediumint',
  'point',
  'serial',
  'smallint',
  'specificType',
  'string',
  'text',
  'textArray',
  'time',
  'timestamp',
  'tinyint',
  'uuid',
]

const providerSet = new Set<string>(PROVIDERS)
const columnTypeSet = new Set<string>(COLUMN_TYPES)
const sqliteProviders = new Set<Provider>(['sqlite3', 'better-sqlite3'])

export function assertValidSchema(schema: KnexSchema): void {
  const errors = validateSchema(schema).filter((issue) => issue.severity === 'error')
  if (errors.length > 0) {
    throw new SchemaValidationError(errors)
  }
}

export function validateSchema(schema: KnexSchema): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = []

  if (!schema || typeof schema !== 'object') {
    return [error('schema', 'Schema must be an object.')]
  }

  validateDatabase(schema, issues)
  validateGenerator(schema, issues)
  validateEnums(schema, issues)
  validateTables(schema, issues)

  return issues
}

function validateDatabase(schema: KnexSchema, issues: SchemaValidationIssue[]) {
  const database = schema.database
  if (!database || typeof database !== 'object') {
    issues.push(error('database', 'Database config is required.'))
    return
  }

  validateNonEmptyString(database.name, 'database.name', issues)
  if (!isProvider(database.provider)) {
    issues.push(error('database.provider', `Unsupported provider "${String(database.provider)}".`))
    return
  }

  if (database.schema !== undefined) {
    validateNonEmptyString(database.schema, 'database.schema', issues)
  }

  const connection = database.connection
  if (!connection || typeof connection !== 'object') {
    issues.push(error('database.connection', 'Connection config is required.'))
    return
  }

  if (!connection.url && !connection.filename && connection.config === undefined) {
    issues.push(
      error(
        'database.connection',
        'Provide connection.url, connection.filename, or connection.config.',
      ),
    )
  }

  if (sqliteProviders.has(database.provider) && !connection.filename && connection.config === undefined) {
    issues.push(
      error(
        'database.connection.filename',
        `${database.provider} needs connection.filename or connection.config.`,
      ),
    )
  }

  if (!sqliteProviders.has(database.provider) && !connection.url && connection.config === undefined) {
    issues.push(
      error(
        'database.connection.url',
        `${database.provider} needs connection.url or connection.config.`,
      ),
    )
  }
}

function validateGenerator(schema: KnexSchema, issues: SchemaValidationIssue[]) {
  const generator = schema.generator
  if (!generator || typeof generator !== 'object') {
    issues.push(error('generator', 'Generator config is required.'))
    return
  }

  validateNonEmptyString(generator.output, 'generator.output', issues)
  validateNonEmptyString(generator.snapshotsDir, 'generator.snapshotsDir', issues)
  validateNonEmptyString(generator.migrationsDir, 'generator.migrationsDir', issues)

  if (generator.typesFile !== undefined) validateNonEmptyString(generator.typesFile, 'generator.typesFile', issues)
  if (generator.knexTypesFile !== undefined) validateNonEmptyString(generator.knexTypesFile, 'generator.knexTypesFile', issues)
  if (generator.migrationSqlDir !== undefined) validateNonEmptyString(generator.migrationSqlDir, 'generator.migrationSqlDir', issues)
  if (generator.docsDir !== undefined) validateNonEmptyString(generator.docsDir, 'generator.docsDir', issues)
  if (generator.vscodeSnippetsPath !== undefined) validateNonEmptyString(generator.vscodeSnippetsPath, 'generator.vscodeSnippetsPath', issues)

  if (
    generator.migrationSqlMode !== undefined
    && generator.migrationSqlMode !== 'inline'
    && generator.migrationSqlMode !== 'files'
  ) {
    issues.push(error('generator.migrationSqlMode', 'Use "inline" or "files".'))
  }
}

function validateEnums(schema: KnexSchema, issues: SchemaValidationIssue[]) {
  const enums = schema.enums ?? {}
  const physicalNames = new Map<string, string>()

  for (const [enumKey, enumDefinition] of Object.entries(enums)) {
    const path = `enums.${enumKey}`
    if (!enumDefinition || enumDefinition.kind !== 'enum') {
      issues.push(error(path, 'Enum definition must be created with sql.enum().'))
      continue
    }

    validateNonEmptyString(enumDefinition.name, `${path}.name`, issues)
    if (physicalNames.has(enumDefinition.name)) {
      issues.push(
        error(
          `${path}.name`,
          `Duplicate enum SQL name "${enumDefinition.name}" also used by ${physicalNames.get(enumDefinition.name)}.`,
        ),
      )
    } else {
      physicalNames.set(enumDefinition.name, path)
    }

    if (!Array.isArray(enumDefinition.values) || enumDefinition.values.length === 0) {
      issues.push(error(`${path}.values`, 'Enum must contain at least one value.'))
      continue
    }

    validateUniqueList(enumDefinition.values, `${path}.values`, issues)
    for (const [index, value] of enumDefinition.values.entries()) {
      validateNonEmptyString(value, `${path}.values.${index}`, issues)
    }
  }
}

function validateTables(schema: KnexSchema, issues: SchemaValidationIssue[]) {
  const tables = schema.tables ?? {}
  const actualTableNames = new Map<string, string>()

  for (const [modelName, table] of Object.entries(tables)) {
    const path = `tables.${modelName}`
    if (!table || table.kind !== 'table') {
      issues.push(error(path, 'Table definition must be created with sql.table().'))
      continue
    }

    validateNonEmptyString(table.name, `${path}.name`, issues)
    const actualTableName = tableName(table)
    if (actualTableNames.has(actualTableName)) {
      issues.push(
        error(
          `${path}.name`,
          `Duplicate table SQL name "${actualTableName}" also used by ${actualTableNames.get(actualTableName)}.`,
        ),
      )
    } else {
      actualTableNames.set(actualTableName, path)
    }

    validateColumns(schema, table, path, issues)
    validateTableConstraints(table, path, issues)
  }
}

function validateColumns(
  schema: KnexSchema,
  table: TableDefinition,
  tablePath: string,
  issues: SchemaValidationIssue[],
) {
  const columns = table.columns ?? {}
  const columnEntries = Object.entries(columns)
  const actualColumnNames = new Map<string, string>()

  if (columnEntries.length === 0) {
    issues.push(error(`${tablePath}.columns`, 'Table must contain at least one column.'))
    return
  }

  for (const [columnKey, column] of columnEntries) {
    const path = `${tablePath}.columns.${columnKey}`
    if (!column || column.kind !== 'column') {
      issues.push(error(path, 'Column definition must be created with sql.<type>().'))
      continue
    }

    validateColumn(schema, table, column, path, issues)

    const actualColumnName = columnName(column)
    if (actualColumnNames.has(actualColumnName)) {
      issues.push(
        error(
          `${path}.name`,
          `Duplicate column SQL name "${actualColumnName}" also used by ${actualColumnNames.get(actualColumnName)}.`,
        ),
      )
    } else {
      actualColumnNames.set(actualColumnName, path)
    }
  }
}

function validateColumn(
  schema: KnexSchema,
  table: TableDefinition,
  column: ColumnDefinition,
  path: string,
  issues: SchemaValidationIssue[],
) {
  validateNonEmptyString(column.name, `${path}.name`, issues)
  if (column.dbName !== undefined) validateNonEmptyString(column.dbName, `${path}.dbName`, issues)

  if (!columnTypeSet.has(column.type)) {
    issues.push(error(`${path}.type`, `Unsupported column type "${String(column.type)}".`))
    return
  }

  if (column.type === 'enum') {
    if (!column.enumName) {
      issues.push(error(`${path}.enumName`, 'enumRef() requires an enum name.'))
    } else if (!findEnum(schema, column.enumName)) {
      issues.push(error(`${path}.enumName`, `Enum "${column.enumName}" was not found in schema.enums.`))
    }
  }

  if (column.type === 'enu') {
    if (!column.enumValues?.length) {
      issues.push(error(`${path}.enumValues`, 'enu() requires at least one value.'))
    } else {
      validateUniqueList(column.enumValues, `${path}.enumValues`, issues)
    }
  }

  if (column.type === 'specificType') {
    validateNonEmptyString(column.specificType, `${path}.specificType`, issues)
  }

  if (column.length !== undefined && (!Number.isInteger(column.length) || column.length <= 0)) {
    issues.push(error(`${path}.length`, 'Length must be a positive integer.'))
  }

  if (column.precision !== undefined && (!Number.isInteger(column.precision) || column.precision <= 0)) {
    issues.push(error(`${path}.precision`, 'Precision must be a positive integer.'))
  }

  if (column.scale !== undefined && (!Number.isInteger(column.scale) || column.scale < 0)) {
    issues.push(error(`${path}.scale`, 'Scale must be a non-negative integer.'))
  }

  if (
    column.precision !== undefined
    && column.scale !== undefined
    && column.scale > column.precision
  ) {
    issues.push(error(`${path}.scale`, 'Scale cannot be greater than precision.'))
  }

  if (column.reference) {
    const targetTable = findTable(schema, column.reference.table)
    if (!targetTable) {
      issues.push(error(`${path}.reference.table`, `Referenced table "${column.reference.table}" was not found.`))
    } else if (!findColumn(targetTable, column.reference.column)) {
      issues.push(
        error(
          `${path}.reference.column`,
          `Referenced column "${column.reference.column}" was not found on table "${column.reference.table}".`,
        ),
      )
    }
  }

  validateProviderColumnSupport(schema.database.provider, column, path, issues)

  if (column.primaryKey && column.nullable) {
    issues.push(error(`${path}.nullable`, 'Primary key columns cannot be nullable.'))
  }

  if (column.updatedAt && !column.defaultValue) {
    issues.push(
      warning(
        `${path}.updatedAt`,
        'updatedAt() only changes the value on UPDATE; add defaultNow() when inserts should receive an initial timestamp.',
      ),
    )
  }

  void table
}

function validateProviderColumnSupport(
  provider: Provider,
  column: ColumnDefinition,
  path: string,
  issues: SchemaValidationIssue[],
) {
  if (column.updatedAt && provider !== 'postgresql') {
    issues.push(
      error(
        `${path}.updatedAt`,
        'updatedAt() currently generates an automatic trigger only for PostgreSQL.',
      ),
    )
  }

  if ((column.type === 'jsonbArray' || column.type === 'textArray') && !isPostgresLike(provider)) {
    issues.push(error(`${path}.type`, `${column.type} is only supported for PostgreSQL/CockroachDB.`))
  }

  if (column.type === 'serial' && provider !== 'postgresql' && !column.primaryKey) {
    issues.push(
      error(
        `${path}.type`,
        'serial() as a non-primary column is PostgreSQL-specific; use increments() or specificType().',
      ),
    )
  }
}

function validateTableConstraints(
  table: TableDefinition,
  tablePath: string,
  issues: SchemaValidationIssue[],
) {
  for (const [index, unique] of table.uniques.entries()) {
    validateColumnList(table, unique.columns, `${tablePath}.uniques.${index}.columns`, issues)
  }

  for (const [index, indexDefinition] of table.indexes.entries()) {
    validateColumnList(table, indexDefinition.columns, `${tablePath}.indexes.${index}.columns`, issues)
  }
}

function validateColumnList(
  table: TableDefinition,
  columns: string[],
  path: string,
  issues: SchemaValidationIssue[],
) {
  if (!Array.isArray(columns) || columns.length === 0) {
    issues.push(error(path, 'Column list must contain at least one column.'))
    return
  }

  validateUniqueList(columns, path, issues)
  for (const [index, column] of columns.entries()) {
    if (!findColumn(table, column)) {
      issues.push(error(`${path}.${index}`, `Column "${column}" was not found on table "${table.modelName}".`))
    }
  }
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  issues: SchemaValidationIssue[],
) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(error(path, 'Must be a non-empty string.'))
  }
}

function validateUniqueList(values: string[], path: string, issues: SchemaValidationIssue[]) {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      issues.push(error(`${path}.${index}`, `Duplicate value "${value}".`))
    }
    seen.add(value)
  }
}

function findEnum(schema: KnexSchema, name: string) {
  return schema.enums[name] ?? Object.values(schema.enums).find((item) => item.name === name)
}

function findTable(schema: KnexSchema, name: string) {
  return schema.tables[name] ?? Object.values(schema.tables).find((table) => tableName(table) === name)
}

function findColumn(table: TableDefinition, name: string) {
  return table.columns[name] ?? Object.values(table.columns).find((column) => {
    return column.name === name || columnName(column) === name
  })
}

function tableName(table: TableDefinition) {
  return table.dbName ?? table.name
}

function columnName(column: ColumnDefinition) {
  return column.dbName ?? column.name
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && providerSet.has(value)
}

function isPostgresLike(provider: Provider) {
  return provider === 'postgresql' || provider === 'cockroachdb'
}

function error(path: string, message: string): SchemaValidationIssue {
  return { path, message, severity: 'error' }
}

function warning(path: string, message: string): SchemaValidationIssue {
  return { path, message, severity: 'warning' }
}
