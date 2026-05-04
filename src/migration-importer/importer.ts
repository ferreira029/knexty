import fs from 'fs'
import path from 'path'
import { snakeCase } from '../generators/names'

interface SqlEnum {
  name: string
  values: string[]
}

interface SqlColumn {
  originalName: string
  name: string
  expression: string
  primaryKey: boolean
  reference?: {
    table: string
    column: string
    onDelete?: string
  }
}

interface SqlTable {
  originalName: string
  name: string
  columns: SqlColumn[]
  uniques: string[][]
  indexes: string[][]
}

export function importMigrationsFromDir(migrationsDir: string) {
  const files = collectMigrationFiles(migrationsDir)
  const sql = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n\n')
  return importMigrationsSql(sql)
}

export function importMigrationsSql(sql: string) {
  const enums = parseEnums(sql)
  const tables = parseTables(sql)
  applyIndexes(sql, tables)
  applyForeignKeys(sql, tables)
  return renderSchema(enums, Object.values(tables))
}

function collectMigrationFiles(dir: string) {
  const files: string[] = []

  function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(entryPath)
      } else if (entry.isFile() && entry.name === 'migration.sql') {
        files.push(entryPath)
      }
    }
  }

  walk(dir)
  return files.sort()
}

function parseEnums(sql: string) {
  const enums: SqlEnum[] = []
  const regex = /CREATE\s+TYPE\s+"([^"]+)"\s+AS\s+ENUM\s+\(([^;]+)\);/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(sql))) {
    enums.push({
      name: snakeCase(match[1]),
      values: match[2]
        .split(',')
        .map((value) => value.trim().replace(/^'/, '').replace(/'$/, '').replace(/''/g, "'")),
    })
  }

  return enums
}

function parseTables(sql: string) {
  const tables: Record<string, SqlTable> = {}
  const regex = /CREATE\s+TABLE\s+"([^"]+)"\s+\(([\s\S]*?)\n\);/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(sql))) {
    const originalName = match[1]
    const table: SqlTable = {
      originalName,
      name: snakeCase(originalName),
      columns: [],
      uniques: [],
      indexes: [],
    }

    const primaryKeys = parsePrimaryKeys(match[2])
    for (const rawLine of match[2].split(/\r?\n/)) {
      const line = rawLine.trim().replace(/,$/, '')
      if (!line.startsWith('"')) continue

      const column = parseColumn(line, primaryKeys)
      if (column) {
        table.columns.push(column)
      }
    }

    tables[originalName] = table
  }

  return tables
}

function parsePrimaryKeys(body: string) {
  const keys = new Set<string>()
  const regex = /PRIMARY\s+KEY\s+\(([^)]+)\)/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(body))) {
    for (const column of parseQuotedList(match[1])) {
      keys.add(column)
    }
  }

  return keys
}

function parseColumn(line: string, primaryKeys: Set<string>): SqlColumn | undefined {
  const match = line.match(/^"([^"]+)"\s+(.+)$/)
  if (!match) return undefined

  const originalName = match[1]
  const rest = match[2]
  const defaultValue = rest.match(/\sDEFAULT\s+(.+)$/i)?.[1]
  const nullable = !/\sNOT\s+NULL\b/i.test(rest)
  const typeSql = rest
    .replace(/\sDEFAULT\s+.+$/i, '')
    .replace(/\sNOT\s+NULL\b/i, '')
    .trim()

  let expression = typeExpression(typeSql)
  if (primaryKeys.has(originalName)) expression += '.primaryKey()'
  if (nullable && !primaryKeys.has(originalName)) expression += '.nullable()'

  const defaultExpression = defaultValueExpression(defaultValue)
  if (defaultExpression) expression += defaultExpression

  return {
    originalName,
    name: snakeCase(originalName),
    expression,
    primaryKey: primaryKeys.has(originalName),
  }
}

function applyIndexes(sql: string, tables: Record<string, SqlTable>) {
  const regex = /CREATE\s+(UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+"([^"]+)"\s*\(([^;]+)\);/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(sql))) {
    const isUnique = Boolean(match[1])
    const table = tables[match[3]]
    if (!table) continue

    const columns = parseQuotedList(match[4]).map(snakeCase)
    if (columns.length === 0) continue

    if (isUnique) {
      table.uniques.push(columns)
    } else {
      table.indexes.push(columns)
    }
  }
}

function applyForeignKeys(sql: string, tables: Record<string, SqlTable>) {
  const regex =
    /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+FOREIGN\s+KEY\s+\("([^"]+)"\)\s+REFERENCES\s+"([^"]+)"\("([^"]+)"\)\s+ON\s+DELETE\s+([A-Z ]+)\s+ON\s+UPDATE\s+([A-Z ]+);/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(sql))) {
    const [, sourceTable, , sourceColumn, targetTable, targetColumn, onDelete] = match
    const table = tables[sourceTable]
    const column = table?.columns.find((item) => item.originalName === sourceColumn)
    if (!column) continue

    column.reference = {
      table: snakeCase(targetTable),
      column: snakeCase(targetColumn),
      onDelete: normalizeOnDelete(onDelete),
    }
  }
}

function renderSchema(enums: SqlEnum[], tables: SqlTable[]) {
  const chunks = [
    "import { defineSchema, sql } from 'knexty'",
    '',
    'export default defineSchema({',
    '  database: {',
    "    name: 'postgres',",
    "    provider: 'postgresql',",
    "    schema: 'public',",
    "    connection: { url: { env: 'DATABASE_URL' } },",
    '  },',
    '  generator: {',
    "    output: '../src/database/generated/postgres',",
    "    typesFile: 'types.ts',",
    "    knexTypesFile: 'knex-tables.d.ts',",
    "    snapshotsDir: './snapshots/postgres',",
    "    migrationsDir: './migrations/postgres',",
    "    docsDir: '..',",
    "    vscodeSnippetsPath: '../.vscode/knexty.code-snippets',",
    '  },',
    '  enums: {',
    ...enums.map((item) => `    ${item.name}: sql.enum('${item.name}', ${renderArray(item.values)}),`),
    '  },',
    '  tables: {',
  ]

  for (const table of tables) {
    chunks.push(`    ${table.name}: sql.table('${table.name}', {`)
    for (const column of table.columns) {
      const referenceSuffix = column.reference
        ? `.references('${column.reference.table}.${column.reference.column}'${column.reference.onDelete ? `, { onDelete: '${column.reference.onDelete}' }` : ''})`
        : ''
      chunks.push(`      ${column.name}: ${column.expression}${referenceSuffix},`)
    }
    chunks.push('    })')
    for (const unique of dedupeColumnLists(table.uniques)) {
      chunks.push(`      .unique(${renderArray(unique)})`)
    }
    for (const index of dedupeColumnLists(table.indexes)) {
      chunks.push(`      .index(${renderArray(index)})`)
    }
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]},`
  }

  chunks.push('  },', '})', '')
  return chunks.join('\n')
}

function typeExpression(typeSql: string) {
  if (typeSql === 'SERIAL') return 'sql.serial()'
  if (typeSql === 'UUID') return 'sql.uuid()'
  if (typeSql === 'TEXT') return 'sql.text()'
  if (typeSql === 'TEXT[]') return 'sql.textArray()'
  if (typeSql === 'INTEGER') return 'sql.integer()'
  if (typeSql === 'BOOLEAN') return 'sql.boolean()'
  if (typeSql === 'JSONB') return 'sql.jsonb()'
  if (typeSql === 'JSONB[]') return 'sql.jsonbArray()'
  if (typeSql === 'DOUBLE PRECISION') return 'sql.float()'
  if (/^TIMESTAMP/i.test(typeSql)) return 'sql.timestamp()'

  const decimal = typeSql.match(/^DECIMAL\((\d+),\s*(\d+)\)$/i)
  if (decimal) return `sql.decimal(${decimal[1]}, ${decimal[2]})`
  if (typeSql === 'DECIMAL') return 'sql.decimal()'

  const enumMatch = typeSql.match(/^"([^"]+)"$/)
  if (enumMatch) return `sql.enumRef('${snakeCase(enumMatch[1])}')`

  return `sql.text().defaultRaw(${JSON.stringify(typeSql)})`
}

function defaultValueExpression(value?: string) {
  if (!value) return ''
  const normalized = value.trim()
  if (normalized === 'CURRENT_TIMESTAMP') return '.defaultNow()'
  if (normalized === 'true' || normalized === 'false') return `.default(${normalized})`
  if (/^-?\d+(\.\d+)?$/.test(normalized)) return `.default(${normalized})`
  if (/^ARRAY\[\]::/i.test(normalized)) return `.defaultRaw(${JSON.stringify(normalized)})`
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    return `.default(${JSON.stringify(normalized.slice(1, -1).replace(/''/g, "'"))})`
  }
  return `.defaultRaw(${JSON.stringify(normalized)})`
}

function parseQuotedList(value: string) {
  return [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function normalizeOnDelete(value: string) {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized === 'NO ACTION') return 'NO ACTION'
  if (normalized === 'SET NULL') return 'SET NULL'
  if (normalized === 'SET DEFAULT') return 'SET DEFAULT'
  if (normalized === 'CASCADE') return 'CASCADE'
  if (normalized === 'RESTRICT') return 'RESTRICT'
  return undefined
}

function dedupeColumnLists(lists: string[][]) {
  const seen = new Set<string>()
  return lists.filter((columns) => {
    const key = columns.join('\0')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function renderArray(values: string[]) {
  return `[${values.map((value) => `'${value}'`).join(', ')}]`
}
