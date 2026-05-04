#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { createJiti } from 'jiti'
import { KnexSchema } from '../dsl'
import { writeGeneratedTypes } from '../generators/types-generator'
import { readSnapshot, writeSnapshot } from '../generators/snapshot'
import { renderKnexMigrationWithFiles } from '../generators/sql-generator'
import { diffSchemas } from '../migrations/diff'
import { runKnexMigrations } from '../migrations/runner'
import { importMigrationsFromDir } from '../migration-importer/importer'
import { importPrismaSchema } from '../prisma-importer/importer'
import { agentMd, claudeMd } from '../templates/docs'
import { vscodeSnippets } from '../templates/snippets'
import { ensureDir, writeTextFile } from '../utils/files'

interface LoadedSchema {
  schema: KnexSchema
  schemaPath: string
  baseDir: string
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  switch (command) {
    case 'init':
      await init(args)
      return
    case 'import-prisma':
      await importPrisma(args)
      return
    case 'import-migrations':
      await importMigrations(args)
      return
    case 'generate':
      await generate(args)
      return
    case 'validate':
      await validate(args)
      return
    case 'baseline':
      await baseline(args)
      return
    case 'migration:make':
      await makeMigration(args)
      return
    case 'migrate:latest':
      await migrate(args, 'latest')
      return
    case 'migrate:rollback':
      await migrate(args, 'rollback')
      return
    case 'migrate:status':
      await migrate(args, 'status')
      return
    case 'snippets':
      await snippets(args)
      return
    case '--help':
    case '-h':
    case undefined:
      printHelp()
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

async function init(args: ParsedArgs) {
  const loaded = args.schema ? loadSchema(args.schema) : undefined
  const baseDir = loaded?.baseDir ?? process.cwd()
  const docsDir = loaded?.schema.generator.docsDir
    ? path.resolve(baseDir, loaded.schema.generator.docsDir)
    : process.cwd()

  writeTextFile(path.join(docsDir, 'CLAUDE.md'), claudeMd())
  writeTextFile(path.join(docsDir, 'AGENT.md'), agentMd())

  const snippetPath = loaded?.schema.generator.vscodeSnippetsPath
    ? path.resolve(baseDir, loaded.schema.generator.vscodeSnippetsPath)
    : path.resolve(process.cwd(), '.vscode/knexty.code-snippets')
  writeTextFile(snippetPath, `${vscodeSnippets()}\n`)

  const samplePath = path.resolve(process.cwd(), 'database/postgres.schema.knex.ts')
  if (!loaded && !fs.existsSync(samplePath)) {
    writeTextFile(samplePath, sampleSchema())
  }

  console.log('Initialized knexty docs and snippets.')
}

async function importPrisma(args: ParsedArgs) {
  const prismaPath = requiredOption(args, 'schema')
  const outPath = requiredOption(args, 'out')
  const content = fs.readFileSync(path.resolve(process.cwd(), prismaPath), 'utf8')
  writeTextFile(path.resolve(process.cwd(), outPath), importPrismaSchema(content))
  console.log(`Wrote ${outPath}`)
}

async function importMigrations(args: ParsedArgs) {
  const migrationsDir = requiredOption(args, 'dir')
  const outPath = requiredOption(args, 'out')
  writeTextFile(
    path.resolve(process.cwd(), outPath),
    importMigrationsFromDir(path.resolve(process.cwd(), migrationsDir)),
  )
  console.log(`Wrote ${outPath}`)
}

async function generate(args: ParsedArgs) {
  const loaded = loadSchema(requiredOption(args, 'schema'))
  writeGeneratedTypes(loaded.schema, loaded.baseDir)
  console.log('Generated Knex TypeScript types.')
}

async function validate(args: ParsedArgs) {
  loadSchema(requiredOption(args, 'schema'))
  console.log('Schema is valid.')
}

async function baseline(args: ParsedArgs) {
  const loaded = loadSchema(requiredOption(args, 'schema'))
  const snapshotDir = path.resolve(loaded.baseDir, loaded.schema.generator.snapshotsDir)
  writeSnapshot(snapshotDir, loaded.schema)
  console.log(`Wrote baseline snapshot to ${snapshotDir}`)
}

async function makeMigration(args: ParsedArgs) {
  const loaded = loadSchema(requiredOption(args, 'schema'))
  const name = args.positionals[0]
  if (!name) {
    throw new Error('Missing migration name. Example: knexty migration:make add_users_index --schema database/postgres.schema.knex.ts')
  }

  const snapshotDir = path.resolve(loaded.baseDir, loaded.schema.generator.snapshotsDir)
  const previous = readSnapshot(snapshotDir)
  const diff = diffSchemas(previous, loaded.schema)

  if (diff.destructive.length > 0 && !args.flags.has('allow-destructive')) {
    throw new Error(
      [
        'Automatic migration blocked because destructive/manual changes were detected:',
        ...diff.destructive.map((item) => `- ${item}`),
      ].join('\n'),
    )
  }

  if (diff.migration.up.length === 0) {
    console.log('No schema changes detected.')
    return
  }

  const migrationsDir = path.resolve(loaded.baseDir, loaded.schema.generator.migrationsDir)
  ensureDir(migrationsDir)
  const fileName = `${timestamp()}_${slug(name)}.ts`
  const migrationBaseName = fileName.replace(/\.ts$/, '')
  const sqlMode = args.flags.has('sql-files')
    ? 'files'
    : loaded.schema.generator.migrationSqlMode ?? 'inline'
  const sqlDirName = loaded.schema.generator.migrationSqlDir ?? 'sql'
  const rendered = renderKnexMigrationWithFiles(diff.migration, {
    migrationBaseName,
    rawSqlMode: sqlMode,
    sqlFilesDirName: sqlDirName,
  })

  writeTextFile(path.join(migrationsDir, fileName), rendered.content)
  for (const sqlFile of rendered.sqlFiles) {
    writeTextFile(path.join(migrationsDir, sqlDirName, sqlFile.fileName), sqlFile.content)
  }

  writeSnapshot(snapshotDir, loaded.schema)
  console.log(`Wrote migration ${path.join(migrationsDir, fileName)}`)
  if (rendered.sqlFiles.length > 0) {
    console.log(`Wrote ${rendered.sqlFiles.length} SQL sidecar file(s) to ${path.join(migrationsDir, sqlDirName)}`)
  }
}

async function migrate(args: ParsedArgs, command: 'latest' | 'rollback' | 'status') {
  const loaded = loadSchema(requiredOption(args, 'schema'))
  await runKnexMigrations(loaded.schema, loaded.baseDir, command)
}

async function snippets(args: ParsedArgs) {
  const editor = args.options.editor ?? 'vscode'
  if (editor !== 'vscode') {
    throw new Error(`Unsupported editor "${editor}". Only "vscode" is supported in v1.`)
  }

  const loaded = args.schema ? loadSchema(args.schema) : undefined
  const snippetPath = loaded?.schema.generator.vscodeSnippetsPath
    ? path.resolve(loaded.baseDir, loaded.schema.generator.vscodeSnippetsPath)
    : path.resolve(process.cwd(), '.vscode/knexty.code-snippets')

  writeTextFile(snippetPath, `${vscodeSnippets()}\n`)
  console.log(`Wrote VS Code snippets to ${snippetPath}`)
}

function loadSchema(schemaPathInput: string): LoadedSchema {
  const schemaPath = path.resolve(process.cwd(), schemaPathInput)
  const jiti = createJiti(schemaPath, { interopDefault: true })
  const moduleValue = jiti(schemaPath) as { default?: KnexSchema } | KnexSchema
  const schema = ('default' in moduleValue ? moduleValue.default : moduleValue) as KnexSchema
  if (!schema?.database || !schema?.generator || !schema?.tables) {
    throw new Error(`Invalid knex schema file: ${schemaPathInput}`)
  }

  return {
    schema,
    schemaPath,
    baseDir: path.dirname(schemaPath),
  }
}

interface ParsedArgs {
  options: Record<string, string>
  flags: Set<string>
  positionals: string[]
  schema?: string
  out?: string
  dir?: string
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    options: {},
    flags: new Set(),
    positionals: [],
  }

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--') {
      result.positionals.push(...args.slice(index + 1))
      break
    }

    if (value.startsWith('--')) {
      const name = value.slice(2)
      const next = args[index + 1]
      if (!next || next.startsWith('--')) {
        result.flags.add(name)
        continue
      }
      result.options[name] = next
      index += 1
      continue
    }

    result.positionals.push(value)
  }

  result.schema = result.options.schema
  result.out = result.options.out
  result.dir = result.options.dir
  return result
}

function requiredOption(args: ParsedArgs, name: 'dir' | 'schema' | 'out') {
  const value = args[name]
  if (!value) {
    throw new Error(`Missing required option --${name}`)
  }
  return value
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+$/, '')
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function printHelp() {
  console.log(`knexty

Commands:
  init [--schema schema.knex.ts]
  import-prisma --schema prisma/postgres/schema.prisma --out database/postgres.schema.knex.ts
  import-migrations --dir prisma/postgres/migrations --out database/postgres.schema.knex.ts
  validate --schema database/postgres.schema.knex.ts
  generate --schema database/postgres.schema.knex.ts
  baseline --schema database/postgres.schema.knex.ts
  migration:make <name> --schema database/postgres.schema.knex.ts [--allow-destructive] [--sql-files]
  migrate:latest --schema database/postgres.schema.knex.ts
  migrate:rollback --schema database/postgres.schema.knex.ts
  migrate:status --schema database/postgres.schema.knex.ts
  snippets --editor vscode [--schema database/postgres.schema.knex.ts]
`)
}

function sampleSchema() {
  return `import { defineSchema, sql } from 'knexty'

export default defineSchema({
  database: {
    name: 'postgres',
    provider: 'postgresql',
    schema: 'public',
    connection: { url: { env: 'DATABASE_URL' } },
  },
  generator: {
    output: '../src/database/generated/postgres',
    snapshotsDir: './snapshots/postgres',
    migrationsDir: './migrations/postgres',
    migrationSqlMode: 'files',
    migrationSqlDir: 'sql',
  },
  enums: {
    role: sql.enum('role', ['ADMIN', 'TALENT']),
  },
  tables: {
    user: sql.table('user', {
      id: sql.increments().primaryKey(),
      email: sql.string(255).unique(),
      role: sql.enumRef('role').default('TALENT'),
      createdAt: sql.timestamp().defaultNow(),
      updatedAt: sql.timestamp().updatedAt(),
    }),
  },
})
`
}
