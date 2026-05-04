export type Provider =
  | 'postgresql'
  | 'cockroachdb'
  | 'mysql'
  | 'mysql2'
  | 'sqlite3'
  | 'better-sqlite3'
  | 'mssql'
  | 'oracledb'
  | 'redshift'

export type OnDeleteAction =
  | 'CASCADE'
  | 'RESTRICT'
  | 'SET NULL'
  | 'SET DEFAULT'
  | 'NO ACTION'

export interface DatabaseConfig {
  name: string
  provider: Provider
  schema?: string
  connection: {
    url?: string | { env: string }
    filename?: string | { env: string }
    config?: unknown
  }
}

export interface GeneratorConfig {
  output: string
  typesFile?: string
  knexTypesFile?: string
  snapshotsDir: string
  migrationsDir: string
  migrationSqlMode?: 'inline' | 'files'
  migrationSqlDir?: string
  docsDir?: string
  vscodeSnippetsPath?: string
}

export interface EnumDefinition {
  kind: 'enum'
  name: string
  values: string[]
}

export type ColumnType =
  | 'bigint'
  | 'bigIncrements'
  | 'bigInteger'
  | 'binary'
  | 'boolean'
  | 'date'
  | 'dateTime'
  | 'decimal'
  | 'double'
  | 'enum'
  | 'enu'
  | 'float'
  | 'geography'
  | 'geometry'
  | 'increments'
  | 'integer'
  | 'json'
  | 'jsonb'
  | 'jsonbArray'
  | 'mediumint'
  | 'point'
  | 'serial'
  | 'smallint'
  | 'specificType'
  | 'string'
  | 'text'
  | 'textArray'
  | 'time'
  | 'timestamp'
  | 'tinyint'
  | 'uuid'

export type DefaultValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'now' }
  | { kind: 'raw'; sql: string }
  | { kind: 'uuid' }

export interface ColumnReference {
  table: string
  column: string
  onDelete?: OnDeleteAction
}

export interface ColumnDefinition {
  kind: 'column'
  name: string
  dbName?: string
  type: ColumnType
  enumName?: string
  enumValues?: string[]
  nullable: boolean
  primaryKey: boolean
  unique: boolean
  generated: boolean
  updatedAt: boolean
  defaultValue?: DefaultValue
  length?: number
  precision?: number
  scale?: number
  textType?: string
  useTz?: boolean
  specificType?: string
  unsigned?: boolean
  comment?: string
  collation?: string
  reference?: ColumnReference
}

export interface UniqueDefinition {
  columns: string[]
  name?: string
}

export interface IndexDefinition {
  columns: string[]
  name?: string
}

export interface TableDefinition {
  kind: 'table'
  modelName: string
  name: string
  dbName?: string
  columns: Record<string, ColumnDefinition>
  uniques: UniqueDefinition[]
  indexes: IndexDefinition[]
}

export interface KnexSchema {
  database: DatabaseConfig
  generator: GeneratorConfig
  enums: Record<string, EnumDefinition>
  tables: Record<string, TableDefinition>
}

export type SchemaInput = {
  database: DatabaseConfig
  generator: GeneratorConfig
  enums?: Record<string, EnumDefinition>
  tables: Record<string, TableBuilder | TableDefinition>
}

export class ColumnBuilder {
  private readonly value: ColumnDefinition

  constructor(type: ColumnType, options: Partial<ColumnDefinition> = {}) {
    this.value = {
      kind: 'column',
      name: '',
      type,
      nullable: false,
      primaryKey: false,
      unique: false,
      generated: ['bigIncrements', 'increments', 'serial'].includes(type),
      updatedAt: false,
      ...options,
    }
  }

  named(name: string): this {
    this.value.name = name
    return this
  }

  notNull(): this {
    this.value.nullable = false
    return this
  }

  nullable(): this {
    this.value.nullable = true
    return this
  }

  primaryKey(): this {
    this.value.primaryKey = true
    this.value.nullable = false
    return this
  }

  unique(): this {
    this.value.unique = true
    return this
  }

  unsigned(): this {
    this.value.unsigned = true
    return this
  }

  comment(value: string): this {
    this.value.comment = value
    return this
  }

  collate(value: string): this {
    this.value.collation = value
    return this
  }

  generated(): this {
    this.value.generated = true
    return this
  }

  default(value: string | number | boolean | null): this {
    this.value.defaultValue = { kind: 'literal', value }
    return this
  }

  defaultRaw(sql: string): this {
    this.value.defaultValue = { kind: 'raw', sql }
    return this
  }

  defaultNow(): this {
    this.value.defaultValue = { kind: 'now' }
    return this
  }

  defaultUuid(): this {
    this.value.defaultValue = { kind: 'uuid' }
    return this
  }

  updatedAt(): this {
    this.value.updatedAt = true
    return this
  }

  mapName(dbName: string): this {
    this.value.dbName = dbName
    return this
  }

  references(target: string, options: { onDelete?: OnDeleteAction } = {}): this {
    const [table, column] = target.split('.')
    if (!table || !column) {
      throw new Error(`Invalid reference "${target}". Use "Table.column".`)
    }

    this.value.reference = {
      table,
      column,
      onDelete: options.onDelete,
    }
    return this
  }

  onDelete(action: OnDeleteAction): this {
    if (!this.value.reference) {
      throw new Error('onDelete() must be called after references().')
    }

    this.value.reference.onDelete = action
    return this
  }

  toDefinition(name?: string): ColumnDefinition {
    return {
      ...this.value,
      name: name ?? this.value.name,
    }
  }
}

export class TableBuilder {
  private readonly value: TableDefinition

  constructor(name: string, columns: Record<string, ColumnBuilder | ColumnDefinition>) {
    this.value = {
      kind: 'table',
      modelName: name,
      name,
      columns: normalizeColumns(columns),
      uniques: [],
      indexes: [],
    }
  }

  mapName(dbName: string): this {
    this.value.dbName = dbName
    return this
  }

  unique(columns: string[], name?: string): this {
    this.value.uniques.push({ columns, name })
    return this
  }

  index(columns: string[], name?: string): this {
    this.value.indexes.push({ columns, name })
    return this
  }

  toDefinition(modelName?: string): TableDefinition {
    return {
      ...this.value,
      modelName: modelName ?? this.value.modelName,
    }
  }
}

function normalizeColumns(columns: Record<string, ColumnBuilder | ColumnDefinition>) {
  return Object.fromEntries(
    Object.entries(columns).map(([name, column]) => {
      const definition =
        column instanceof ColumnBuilder ? column.toDefinition(name) : { ...column, name }
      return [name, definition]
    }),
  )
}
