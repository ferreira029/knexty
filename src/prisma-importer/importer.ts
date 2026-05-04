import { snakeCase } from '../generators/names'

const SCALAR_TYPES = new Set(['Boolean', 'DateTime', 'Decimal', 'Float', 'Int', 'Json', 'String'])

interface ParsedModel {
  name: string
  tableMap?: string
  columns: string[]
  uniques: string[][]
  indexes: string[][]
}

interface RelationReference {
  table: string
  column: string
  onDelete?: string
}

export function importPrismaSchema(prismaSchema: string) {
  const enums = parseEnums(prismaSchema)
  const enumNames = new Set(enums.map((item) => item.name))
  const enumNameMap = Object.fromEntries(enums.map((item) => [item.name, snakeCase(item.name)]))
  const models = parseModels(prismaSchema, enumNames, enumNameMap)

  return renderSchema(enums, models, enumNameMap)
}

function parseEnums(input: string) {
  const enums: Array<{ name: string; values: string[] }> = []
  const enumRegex = /enum\s+(\w+)\s*\{([\s\S]*?)\}/g
  let match: RegExpExecArray | null

  while ((match = enumRegex.exec(input))) {
    const values = match[2]
      .split(/\r?\n/)
      .map(stripLineComment)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('@'))
      .map((line) => line.split(/\s+/)[0])

    enums.push({ name: match[1], values })
  }

  return enums
}

function parseModels(input: string, enumNames: Set<string>, enumNameMap: Record<string, string>) {
  const models: ParsedModel[] = []
  const modelRegex = /model\s+(\w+)\s*\{([\s\S]*?)\}/g
  let match: RegExpExecArray | null

  while ((match = modelRegex.exec(input))) {
    const name = match[1]
    const lines = match[2]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    const relationReferences = parseRelationReferences(lines)
    const columns: string[] = []
    const uniques: string[][] = []
    const indexes: string[][] = []
    let tableMap: string | undefined

    for (const line of lines) {
      const noComment = stripLineComment(line).trim()
      if (!noComment) continue

      if (noComment.startsWith('@@map')) {
        tableMap = matchStringArg(noComment)
        continue
      }

      if (noComment.startsWith('@@unique')) {
        uniques.push(parseFieldList(noComment).map(snakeCase))
        continue
      }

      if (noComment.startsWith('@@index')) {
        indexes.push(parseFieldList(noComment).map(snakeCase))
        continue
      }

      if (noComment.startsWith('@@')) continue

      const field = parseField(noComment)
      if (!field) continue

      const baseType = stripType(field.type)
      const isScalar = SCALAR_TYPES.has(baseType) || enumNames.has(baseType)
      if (!isScalar) continue

      columns.push(renderColumn(field.name, field.type, field.attrs, enumNames, enumNameMap, relationReferences[field.name]))
    }

    models.push({ name, tableMap, columns, uniques, indexes })
  }

  return models
}

function parseRelationReferences(lines: string[]) {
  const references: Record<string, RelationReference> = {}

  for (const line of lines) {
    const field = parseField(stripLineComment(line).trim())
    if (!field || !field.attrs.includes('@relation')) continue

    const relation = extractRelationArgs(field.attrs)
    if (!relation.fields.length || !relation.references.length) continue

    for (let index = 0; index < relation.fields.length; index += 1) {
      references[relation.fields[index]] = {
        table: stripType(field.type),
        column: relation.references[index] ?? relation.references[0],
        onDelete: relation.onDelete,
      }
    }
  }

  return references
}

function renderSchema(
  enums: Array<{ name: string; values: string[] }>,
  models: ParsedModel[],
  enumNameMap: Record<string, string>,
) {
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
    ...enums.map((item) => `    ${enumNameMap[item.name]}: sql.enum('${enumNameMap[item.name]}', ${renderArray(item.values)}),`),
    '  },',
    '  tables: {',
  ]

  for (const model of models) {
    const schemaKey = snakeCase(model.name)
    const tableName = model.tableMap ?? schemaKey

    chunks.push(`    ${schemaKey}: sql.table('${tableName}', {`)
    chunks.push(...model.columns.map((column) => `      ${column},`))
    chunks.push('    })')
    for (const unique of model.uniques) {
      chunks.push(`      .unique(${renderArray(unique)})`)
    }
    for (const index of model.indexes) {
      chunks.push(`      .index(${renderArray(index)})`)
    }
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]},`
  }

  chunks.push('  },', '})', '')
  return chunks.join('\n')
}

function renderColumn(
  name: string,
  type: string,
  attrs: string,
  enumNames: Set<string>,
  enumNameMap: Record<string, string>,
  reference?: RelationReference,
) {
  const baseType = stripType(type)
  const isArray = type.replace('?', '').endsWith('[]')
  const isOptional = type.endsWith('?')
  const isAutoIncrementId = attrs.includes('@id') && attrs.includes('@default(autoincrement())')
  let expression: string

  if (isAutoIncrementId) {
    expression = 'sql.serial()'
  } else if (baseType === 'Boolean') {
    expression = 'sql.boolean()'
  } else if (baseType === 'DateTime') {
    expression = 'sql.timestamp()'
  } else if (baseType === 'Decimal') {
    expression = 'sql.decimal(65, 30)'
  } else if (baseType === 'Float') {
    expression = 'sql.float()'
  } else if (baseType === 'Int') {
    expression = 'sql.integer()'
  } else if (baseType === 'Json' && isArray) {
    expression = 'sql.jsonbArray()'
  } else if (baseType === 'Json') {
    expression = 'sql.jsonb()'
  } else if (baseType === 'String' && attrs.includes('@db.Uuid')) {
    expression = 'sql.uuid()'
  } else if (baseType === 'String' && isArray) {
    expression = 'sql.textArray()'
  } else if (baseType === 'String') {
    expression = 'sql.text()'
  } else if (enumNames.has(baseType)) {
    expression = `sql.enumRef('${enumNameMap[baseType] ?? snakeCase(baseType)}')`
  } else {
    expression = 'sql.text()'
  }

  if (attrs.includes('@id')) expression += '.primaryKey()'
  if (attrs.includes('@unique')) expression += '.unique()'
  if (isOptional) expression += '.nullable()'

  const mappedName = matchAttributeStringArg(attrs, '@map')
  const columnKey = mappedName ?? snakeCase(name)

  const defaultValue = parseDefault(attrs, baseType, isArray)
  if (defaultValue && !isAutoIncrementId) {
    expression += defaultValue
  }

  if (attrs.includes('@updatedAt')) {
    expression += '.updatedAt()'
  }

  if (reference) {
    const options = reference.onDelete ? `, { onDelete: '${reference.onDelete}' }` : ''
    expression += `.references('${snakeCase(reference.table)}.${snakeCase(reference.column)}'${options})`
  }

  return `${columnKey}: ${expression}`
}

function parseDefault(attrs: string, baseType: string, isArray: boolean) {
  if (attrs.includes('@default(uuid())')) return '.defaultUuid()'
  if (attrs.includes('@default(now())')) return '.defaultNow()'

  const match = attrs.match(/@default\(([^)]*)\)/)
  if (!match) return ''

  const value = match[1].trim()
  if (value === 'autoincrement()') return ''
  if (value === 'true' || value === 'false') return `.default(${value})`
  if (/^-?\d+(\.\d+)?$/.test(value)) return `.default(${value})`
  if (value === '[]' && baseType === 'String' && isArray) return ".defaultRaw('ARRAY[]::TEXT[]')"
  if (value === '[]' && baseType === 'Json' && isArray) return ".defaultRaw('ARRAY[]::JSONB[]')"
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return `.default(${JSON.stringify(value.slice(1, -1))})`
  }

  return `.default('${value}')`
}

function parseField(line: string) {
  const match = line.match(/^(\w+)\s+([A-Za-z0-9_\[\]\?]+)\s*(.*)$/)
  if (!match) return undefined
  return {
    name: match[1],
    type: match[2],
    attrs: match[3] ?? '',
  }
}

function stripType(type: string) {
  return type.replace(/\?$/, '').replace(/\[\]$/, '')
}

function stripLineComment(line: string) {
  return line.replace(/\s*\/\/.*$/, '')
}

function matchStringArg(line: string) {
  const match = line.match(/\("([^"]+)"\)/)
  return match?.[1]
}

function matchAttributeStringArg(attrs: string, attribute: string) {
  const escaped = attribute.replace('@', '\\@')
  const match = attrs.match(new RegExp(`${escaped}\\("([^"]+)"\\)`))
  return match?.[1]
}

function parseFieldList(line: string) {
  const match = line.match(/\[([^\]]+)\]/)
  if (!match) return []
  return match[1]
    .split(',')
    .map((field) => field.trim().replace(/['"]/g, ''))
    .filter(Boolean)
}

function extractRelationArgs(attrs: string) {
  return {
    fields: parseNamedList(attrs, 'fields'),
    references: parseNamedList(attrs, 'references'),
    onDelete: normalizeOnDelete(attrs.match(/onDelete:\s*(\w+)/)?.[1]),
  }
}

function parseNamedList(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}:\\s*\\[([^\\]]+)\\]`))
  if (!match) return []
  return match[1].split(',').map((item) => item.trim())
}

function normalizeOnDelete(value?: string) {
  if (!value) return undefined
  const map: Record<string, string> = {
    Cascade: 'CASCADE',
    NoAction: 'NO ACTION',
    Restrict: 'RESTRICT',
    SetDefault: 'SET DEFAULT',
    SetNull: 'SET NULL',
  }
  return map[value] ?? value.toUpperCase()
}

function renderArray(values: string[]) {
  return `[${values.map((value) => `'${value}'`).join(', ')}]`
}
