const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Client } = require('pg')
const knexFactory = require('knex')

const cliPath = path.resolve(__dirname, '../dist/cli/index.js')
const packageEntry = path.resolve(__dirname, '../dist/index.js').replace(/\\/g, '/')

const adminUrl = process.env.KNEXTY_E2E_ADMIN_DATABASE_URL
const baseUrl = process.env.KNEXTY_E2E_DATABASE_URL

test('postgres migrations run against a real database', async (t) => {
  if (!adminUrl || !baseUrl) {
    t.skip('Set KNEXTY_E2E_ADMIN_DATABASE_URL and KNEXTY_E2E_DATABASE_URL to run this test.')
    return
  }

  const databaseName = `knexty_e2e_${process.pid}_${Date.now()}`
  const databaseUrl = databaseUrlForDatabase(baseUrl, databaseName)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knexty-postgres-e2e-'))

  await createDatabase(adminUrl, databaseName)

  try {
    const schemaPath = path.join(tempDir, 'schema.knex.ts')

    fs.writeFileSync(schemaPath, schemaSource('v1'))
    runCli(tempDir, databaseUrl, ['validate', '--schema', schemaPath])
    runCli(tempDir, databaseUrl, ['migration:make', 'init_auth', '--schema', schemaPath])

    const migrationsDir = path.join(tempDir, 'migrations')
    const migrationFiles = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.ts'))
    assert.equal(migrationFiles.length, 1)
    assert.ok(fs.existsSync(path.join(migrationsDir, 'sql')))

    runCli(tempDir, databaseUrl, ['migrate:latest', '--schema', schemaPath])

    const db = knexFactory({ client: 'pg', connection: databaseUrl })
    try {
      await assertInitialSchema(db)
      await assertCascadeDelete(db)
      await assertUpdatedAtTrigger(db)
    } finally {
      await db.destroy()
    }

    runCli(tempDir, databaseUrl, ['baseline', '--schema', schemaPath])
    const baselineOutput = runCli(tempDir, databaseUrl, ['migration:make', 'noop', '--schema', schemaPath])
    assert.match(baselineOutput, /No schema changes detected/)

    fs.writeFileSync(schemaPath, schemaSource('v2'))
    runCli(tempDir, databaseUrl, ['validate', '--schema', schemaPath])
    runCli(tempDir, databaseUrl, ['migration:make', 'add_user_profile_fields', '--schema', schemaPath])
    runCli(tempDir, databaseUrl, ['migrate:latest', '--schema', schemaPath])

    const upgradedDb = knexFactory({ client: 'pg', connection: databaseUrl })
    try {
      await assertUpgradedSchema(upgradedDb)
    } finally {
      await upgradedDb.destroy()
    }

    runCli(tempDir, databaseUrl, ['migrate:rollback', '--schema', schemaPath])

    const rolledBackDb = knexFactory({ client: 'pg', connection: databaseUrl })
    try {
      await assertLatestRollback(rolledBackDb)
    } finally {
      await rolledBackDb.destroy()
    }

    runCli(tempDir, databaseUrl, ['migrate:rollback', '--schema', schemaPath])

    const emptyDb = knexFactory({ client: 'pg', connection: databaseUrl })
    try {
      await assertInitialRollback(emptyDb)
    } finally {
      await emptyDb.destroy()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
    await dropDatabase(adminUrl, databaseName)
  }
})

function runCli(cwd, databaseUrl, args) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    encoding: 'utf8',
  })
}

function schemaSource(version) {
  const displayNameColumn = version === 'v2' ? '\n        display_name: sql.text().nullable(),' : ''
  const roleValues = version === 'v2'
    ? "['ADMIN', 'TALENT', 'RECRUITER']"
    : "['ADMIN', 'TALENT']"

  return `import { defineSchema, sql } from '${packageEntry}'

export default defineSchema({
  database: {
    name: 'postgres',
    provider: 'postgresql',
    schema: 'public',
    connection: { url: { env: 'DATABASE_URL' } },
  },
  generator: {
    output: './generated',
    snapshotsDir: './snapshots',
    migrationsDir: './migrations',
    migrationSqlMode: 'files',
    migrationSqlDir: 'sql',
  },
  enums: {
    role: sql.enum('role', ${roleValues}),
  },
  tables: {
    user: sql.table('user', {
      id: sql.serial().primaryKey(),
      token: sql.uuid().unique().defaultUuid(),
      email: sql.text().unique(),
      role: sql.enumRef('role').default('TALENT'),${displayNameColumn}
      metadata: sql.jsonb().nullable(),
      created_at: sql.timestamp().defaultNow(),
      updated_at: sql.timestamp().defaultNow().updatedAt(),
    }).index(['email']),
    profile: sql.table('profile', {
      id: sql.serial().primaryKey(),
      user_id: sql.integer().unique().references('user.id', { onDelete: 'CASCADE' }),
      label: sql.text().nullable(),
      created_at: sql.timestamp().defaultNow(),
      updated_at: sql.timestamp().defaultNow().updatedAt(),
    }).index(['user_id']),
  },
})
`
}

async function assertInitialSchema(db) {
  const tables = await db('information_schema.tables')
    .select('table_name')
    .where('table_schema', 'public')
    .whereIn('table_name', ['user', 'profile'])

  assert.deepEqual(tables.map((table) => table.table_name).sort(), ['profile', 'user'])

  const roleType = await db.raw("select enumlabel from pg_enum join pg_type on pg_type.oid = enumtypid where typname = 'role' order by enumsortorder")
  assert.deepEqual(roleType.rows.map((row) => row.enumlabel), ['ADMIN', 'TALENT'])

  const trigger = await db.raw("select tgname from pg_trigger where tgname = 'user_updated_at_trigger'")
  assert.equal(trigger.rows.length, 1)
}

async function assertCascadeDelete(db) {
  const [user] = await db('user')
    .insert({ email: 'cascade@example.com', metadata: { source: 'e2e' } })
    .returning(['id'])

  await db('profile').insert({ user_id: user.id, label: 'candidate' })
  await db('user').where({ id: user.id }).delete()

  const count = await db('profile').where({ user_id: user.id }).count({ count: '*' }).first()
  assert.equal(Number(count.count), 0)
}

async function assertUpdatedAtTrigger(db) {
  const [user] = await db('user')
    .insert({ email: 'trigger@example.com', metadata: { version: 1 } })
    .returning(['id', 'updated_at'])

  await wait(1100)

  const [updated] = await db('user')
    .where({ id: user.id })
    .update({ metadata: { version: 2 } })
    .returning(['updated_at'])

  assert.ok(new Date(updated.updated_at).getTime() > new Date(user.updated_at).getTime())
}

async function assertUpgradedSchema(db) {
  const column = await db('information_schema.columns')
    .select('column_name')
    .where({ table_schema: 'public', table_name: 'user', column_name: 'display_name' })
    .first()

  assert.equal(column.column_name, 'display_name')

  const [user] = await db('user')
    .insert({
      email: 'recruiter@example.com',
      role: 'RECRUITER',
      display_name: 'Recruiter',
    })
    .returning(['role', 'display_name'])

  assert.equal(user.role, 'RECRUITER')
  assert.equal(user.display_name, 'Recruiter')
}

async function assertLatestRollback(db) {
  const column = await db('information_schema.columns')
    .select('column_name')
    .where({ table_schema: 'public', table_name: 'user', column_name: 'display_name' })
    .first()

  assert.equal(column, undefined)

  const tables = await db('information_schema.tables')
    .select('table_name')
    .where('table_schema', 'public')
    .whereIn('table_name', ['user', 'profile'])

  assert.deepEqual(tables.map((table) => table.table_name).sort(), ['profile', 'user'])
}

async function assertInitialRollback(db) {
  const tables = await db('information_schema.tables')
    .select('table_name')
    .where('table_schema', 'public')
    .whereIn('table_name', ['user', 'profile'])

  assert.equal(tables.length, 0)

  const roleType = await db.raw("select typname from pg_type where typname = 'role'")
  assert.equal(roleType.rows.length, 0)
}

async function createDatabase(url, databaseName) {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE ${quoteIdent(databaseName)}`)
  } finally {
    await client.end()
  }
}

async function dropDatabase(url, databaseName) {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [databaseName],
    )
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)}`)
  } finally {
    await client.end()
  }
}

function databaseUrlForDatabase(url, databaseName) {
  const parsed = new URL(url)
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

function quoteIdent(value) {
  return `"${value.replace(/"/g, '""')}"`
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
