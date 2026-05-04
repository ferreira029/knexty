import { ColumnDefinition, TableDefinition } from '../dsl'

export function tableName(table: TableDefinition) {
  return table.dbName ?? table.name
}

export function columnName(column: ColumnDefinition) {
  return column.dbName ?? column.name
}

export function typeName(name: string, suffix: string) {
  return `${pascalCase(name)}${suffix}`
}

export function pascalCase(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
}

export function snakeCase(value: string) {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function quoteIdent(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

export function quoteString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

export function defaultConstraintName(table: string, columns: string[]) {
  return snakeCase(`${table}_${columns.join('_')}_key`)
}

export function defaultIndexName(table: string, columns: string[]) {
  return snakeCase(`${table}_${columns.join('_')}_idx`)
}

export function defaultForeignKeyName(table: string, column: string) {
  return snakeCase(`${table}_${column}_fkey`)
}
