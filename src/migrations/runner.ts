import fs from 'fs'
import path from 'path'
import { KnexSchema } from '../dsl'

type MigrationCommand = 'latest' | 'rollback' | 'status'

export async function runKnexMigrations(
  schema: KnexSchema,
  baseDir: string,
  command: MigrationCommand,
) {
  loadDotEnv(process.cwd())
  registerTsNode()

  const knexFactory = requireFromCwd('knex')
  const connection = connectionConfig(schema)
  const db = knexFactory({
    client: knexClient(schema),
    connection,
    ...(schema.database.schema && usesSearchPath(schema) ? { searchPath: [schema.database.schema] } : {}),
    migrations: {
      directory: path.resolve(baseDir, schema.generator.migrationsDir),
      extension: 'ts',
      loadExtensions: ['.ts', '.js'],
      tableName: `${schema.database.name}_knex_migrations`,
    },
  })

  try {
    if (command === 'latest') {
      const result = await db.migrate.latest()
      console.log(result)
    } else if (command === 'rollback') {
      const result = await db.migrate.rollback()
      console.log(result)
    } else {
      const completed = await db.migrate.list()
      console.log(completed)
    }
  } finally {
    await db.destroy()
  }
}

function usesSearchPath(schema: KnexSchema) {
  return schema.database.provider === 'postgresql' || schema.database.provider === 'cockroachdb'
}

function knexClient(schema: KnexSchema) {
  switch (schema.database.provider) {
    case 'postgresql':
      return 'pg'
    case 'cockroachdb':
      return 'cockroachdb'
    case 'better-sqlite3':
      return 'better-sqlite3'
    default:
      return schema.database.provider
  }
}

function connectionConfig(schema: KnexSchema) {
  const configured = schema.database.connection
  if (configured.config) {
    return configured.config
  }

  if (configured.filename) {
    return { filename: resolveConnectionValue(configured.filename) }
  }

  if (configured.url) {
    return resolveConnectionValue(configured.url)
  }

  throw new Error(`Missing database connection config for ${schema.database.name}.`)
}

function resolveConnectionValue(valueOrEnv: string | { env: string }) {
  if (typeof valueOrEnv === 'string') {
    return valueOrEnv
  }

  const value = process.env[valueOrEnv.env]
  if (!value) {
    throw new Error(`Missing database connection env var: ${valueOrEnv.env}`)
  }

  return value
}

function registerTsNode() {
  process.env.TS_NODE_COMPILER_OPTIONS ??= JSON.stringify({
    module: 'CommonJS',
    moduleResolution: 'Node',
  })

  try {
    requireFromCwd('ts-node/register/transpile-only')
  } catch {
    try {
      require('ts-node/register/transpile-only')
    } catch {
      // TypeScript migrations still work if the host app has another loader.
    }
  }
}

function requireFromCwd(moduleName: string) {
  const resolved = require.resolve(moduleName, { paths: [process.cwd(), __dirname] })
  return require(resolved)
}

function loadDotEnv(cwd: string) {
  const envPath = path.join(cwd, '.env')
  if (!fs.existsSync(envPath)) {
    return
  }

  const content = fs.readFileSync(envPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator === -1) continue

    const key = trimmed.slice(0, separator).trim()
    const rawValue = trimmed.slice(separator + 1).trim()
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '')
  }
}
