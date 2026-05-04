const assert = require('node:assert/strict')
const test = require('node:test')

const {
  SchemaValidationError,
  defineSchema,
  sql,
} = require('../dist')
const { generateTypes } = require('../dist/generators/types-generator')
const { renderKnexMigrationWithFiles } = require('../dist/generators/sql-generator')
const { diffSchemas } = require('../dist/migrations/diff')

function baseGenerator() {
  return {
    output: './generated',
    snapshotsDir: './snapshots',
    migrationsDir: './migrations',
  }
}

function postgresDatabase() {
  return {
    name: 'postgres',
    provider: 'postgresql',
    schema: 'public',
    connection: { url: { env: 'DATABASE_URL' } },
  }
}

function sqliteDatabase() {
  return {
    name: 'sqlite',
    provider: 'better-sqlite3',
    connection: { filename: ':memory:' },
  }
}

test('generates PascalCase enums and row/insert/update interfaces', () => {
  const schema = defineSchema({
    database: postgresDatabase(),
    generator: baseGenerator(),
    enums: {
      role: sql.enum('role', ['ADMIN', 'TALENT']),
    },
    tables: {
      user: sql.table('user', {
        id: sql.serial().primaryKey(),
        email: sql.text().unique(),
        role: sql.enumRef('role').default('TALENT'),
        created_at: sql.timestamp().defaultNow(),
      }),
    },
  })

  const output = generateTypes(schema)

  assert.match(output, /export const Role = \{/)
  assert.match(output, /export type Role = typeof Role\[keyof typeof Role\]/)
  assert.match(output, /export interface UserRow \{/)
  assert.match(output, /export interface UserInsert \{/)
  assert.match(output, /export interface UserUpdate \{/)
  assert.doesNotMatch(output, /export type UserRow =/)
})

test('rejects duplicate physical table names', () => {
  assert.throws(
    () => defineSchema({
      database: postgresDatabase(),
      generator: baseGenerator(),
      tables: {
        user: sql.table('account', {
          id: sql.serial().primaryKey(),
        }),
        account: sql.table('account', {
          id: sql.serial().primaryKey(),
        }),
      },
    }),
    SchemaValidationError,
  )
})

test('rejects missing enumRef targets', () => {
  assert.throws(
    () => defineSchema({
      database: postgresDatabase(),
      generator: baseGenerator(),
      tables: {
        user: sql.table('user', {
          id: sql.serial().primaryKey(),
          role: sql.enumRef('missing_role'),
        }),
      },
    }),
    /Enum "missing_role" was not found/,
  )
})

test('rejects automatic updatedAt triggers outside PostgreSQL', () => {
  assert.throws(
    () => defineSchema({
      database: sqliteDatabase(),
      generator: baseGenerator(),
      tables: {
        user: sql.table('user', {
          id: sql.increments().primaryKey(),
          updated_at: sql.timestamp().updatedAt(),
        }),
      },
    }),
    /updatedAt\(\) currently generates an automatic trigger only for PostgreSQL/,
  )
})

test('generates generic Knex schema builder for sqlite', () => {
  const schema = defineSchema({
    database: sqliteDatabase(),
    generator: baseGenerator(),
    tables: {
      user: sql.table('user', {
        id: sql.increments().primaryKey(),
        email: sql.string(255).unique(),
        status: sql.enu(['ACTIVE', 'BLOCKED']).default('ACTIVE'),
        preferences: sql.json().nullable(),
      }),
    },
  })

  const diff = diffSchemas(undefined, schema)
  const rendered = renderKnexMigrationWithFiles(diff.migration)

  assert.match(rendered.content, /await knex\.schema\.createTable\("user"/)
  assert.match(rendered.content, /table\.enu\("status", \["ACTIVE", "BLOCKED"\]\)/)
  assert.doesNotMatch(rendered.content, /CREATE TYPE/)
})

test('moves raw Postgres SQL into one up and one down sidecar when requested', () => {
  const schema = defineSchema({
    database: postgresDatabase(),
    generator: baseGenerator(),
    enums: {
      role: sql.enum('role', ['ADMIN', 'TALENT']),
    },
    tables: {
      user: sql.table('user', {
        id: sql.serial().primaryKey(),
        token: sql.uuid().defaultUuid(),
        role: sql.enumRef('role').default('TALENT'),
        updated_at: sql.timestamp().defaultNow().updatedAt(),
      }),
    },
  })

  const diff = diffSchemas(undefined, schema)
  const rendered = renderKnexMigrationWithFiles(diff.migration, {
    migrationBaseName: '20260425235959_init',
    rawSqlMode: 'files',
  })

  assert.match(rendered.content, /await knex\.schema\.createTable\("user"/)
  assert.match(rendered.content, /await runSqlBlock\(knex, "20260425235959_init\.up\.sql", "up\.001"\)/)
  assert.equal(rendered.sqlFiles.length, 2)
  assert.equal(rendered.sqlFiles.find((file) => file.fileName.endsWith('.up.sql')).fileName, '20260425235959_init.up.sql')
  const upSql = rendered.sqlFiles.find((file) => file.fileName.endsWith('.up.sql')).content
  assert.match(upSql, /-- knexty:block up\.001/)
  assert.match(upSql, /CREATE TYPE "role" AS ENUM/)
  assert.match(upSql, /CREATE EXTENSION IF NOT EXISTS "pgcrypto";/)
  assert.match(upSql, /CREATE TRIGGER "user_updated_at_trigger"/)
})

test('resolves mapped reference table and column names', () => {
  const schema = defineSchema({
    database: postgresDatabase(),
    generator: baseGenerator(),
    tables: {
      account: sql.table('account', {
        id: sql.serial().primaryKey().mapName('account_id'),
      }).mapName('app_account'),
      session: sql.table('session', {
        id: sql.serial().primaryKey(),
        account_id: sql.integer().references('account.id', { onDelete: 'CASCADE' }),
      }),
    },
  })

  const rendered = renderKnexMigrationWithFiles(diffSchemas(undefined, schema).migration)

  assert.match(rendered.content, /\.references\("account_id"\)\.inTable\("app_account"\)/)
})
