import { ColumnDefinition, KnexSchema, TableDefinition } from '../dsl'
import {
  addColumnSql,
  addEnumValueSql,
  createEnumSql,
  createIndexMigrationSql,
  createTableSql,
  createUniqueMigrationSql,
  MigrationStep,
  SqlMigration,
} from '../generators/sql-generator'

export interface DiffResult {
  migration: SqlMigration
  destructive: string[]
  hasChanges: boolean
}

export function diffSchemas(previous: KnexSchema | undefined, current: KnexSchema): DiffResult {
  const up: MigrationStep[] = []
  const down: MigrationStep[] = []
  const destructive: string[] = []

  if (!previous) {
    for (const enumDefinition of Object.values(current.enums)) {
      append(createEnumSql(enumDefinition, current.database.provider), up, down)
    }
    for (const table of Object.values(current.tables)) {
      append(createTableSql(current, table), up, down)
    }
    return { migration: { up, down }, destructive, hasChanges: up.length > 0 }
  }

  for (const [enumName, enumDefinition] of Object.entries(current.enums)) {
    const previousEnum = previous.enums[enumName]
    if (!previousEnum) {
      append(createEnumSql(enumDefinition, current.database.provider), up, down)
      continue
    }

    for (const value of enumDefinition.values) {
      if (!previousEnum.values.includes(value)) {
        if (!isPostgresLike(current.database.provider)) {
          destructive.push(`Enum value change requires a manual migration for ${current.database.provider}: ${enumName}.${value}`)
          continue
        }

        append(addEnumValueSql(enumName, value, current.database.provider), up, down)
      }
    }

    for (const value of previousEnum.values) {
      if (!enumDefinition.values.includes(value)) {
        destructive.push(`Enum value removal requires a manual migration: ${enumName}.${value}`)
      }
    }
  }

  for (const enumName of Object.keys(previous.enums)) {
    if (!current.enums[enumName]) {
      destructive.push(`Enum removal requires a manual migration: ${enumName}`)
    }
  }

  for (const [modelName, table] of Object.entries(current.tables)) {
    const previousTable = previous.tables[modelName]
    if (!previousTable) {
      append(createTableSql(current, table), up, down)
      continue
    }

    diffTable(previousTable, table, current, up, down, destructive)
  }

  for (const modelName of Object.keys(previous.tables)) {
    if (!current.tables[modelName]) {
      destructive.push(`Table removal requires a manual migration: ${modelName}`)
    }
  }

  return {
    migration: { up, down },
    destructive,
    hasChanges: up.length > 0 || destructive.length > 0,
  }
}

function diffTable(
  previous: TableDefinition,
  current: TableDefinition,
  schema: KnexSchema,
  up: MigrationStep[],
  down: MigrationStep[],
  destructive: string[],
) {
  for (const [columnName, column] of Object.entries(current.columns)) {
    const previousColumn = previous.columns[columnName]
    if (!previousColumn) {
      if (!column.nullable && !column.defaultValue && !column.generated) {
        destructive.push(
          `Adding required column without default requires a manual migration: ${current.modelName}.${columnName}`,
        )
        continue
      }

      append(addColumnSql(schema, current, column), up, down)
      continue
    }

    if (!sameColumn(previousColumn, column)) {
      destructive.push(`Column change requires a manual migration: ${current.modelName}.${columnName}`)
    }
  }

  for (const columnName of Object.keys(previous.columns)) {
    if (!current.columns[columnName]) {
      destructive.push(`Column removal requires a manual migration: ${current.modelName}.${columnName}`)
    }
  }

  for (const unique of current.uniques) {
    if (!previous.uniques.some((item) => sameColumnList(item.columns, unique.columns))) {
      append(createUniqueMigrationSql(current, unique.columns, unique.name), up, down)
    }
  }

  for (const index of current.indexes) {
    if (!previous.indexes.some((item) => sameColumnList(item.columns, index.columns))) {
      append(createIndexMigrationSql(current, index.columns, index.name), up, down)
    }
  }
}

function append(fragment: SqlMigration, up: MigrationStep[], down: MigrationStep[]) {
  up.push(...fragment.up)
  down.push(...fragment.down)
}

function sameColumn(left: ColumnDefinition, right: ColumnDefinition) {
  return JSON.stringify(sortColumn(left)) === JSON.stringify(sortColumn(right))
}

function sortColumn(column: ColumnDefinition) {
  return {
    dbName: column.dbName,
    type: column.type,
    enumName: column.enumName,
    nullable: column.nullable,
    primaryKey: column.primaryKey,
    unique: column.unique,
    generated: column.generated,
    updatedAt: column.updatedAt,
    defaultValue: column.defaultValue,
    precision: column.precision,
    scale: column.scale,
    length: column.length,
    textType: column.textType,
    useTz: column.useTz,
    specificType: column.specificType,
    enumValues: column.enumValues,
    unsigned: column.unsigned,
    comment: column.comment,
    collation: column.collation,
    reference: column.reference,
  }
}

function sameColumnList(left: string[], right: string[]) {
  return left.length === right.length && left.every((column, index) => column === right[index])
}

function isPostgresLike(provider: KnexSchema['database']['provider']) {
  return provider === 'postgresql' || provider === 'cockroachdb'
}
