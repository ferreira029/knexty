# knexty

TypeScript-first schema DSL for Knex projects. Postgres has the richest migration support, and the DSL also accepts the default Knex SQL clients and column types.

## What It Does

- Defines database schema in `schema.knex.ts`.
- Generates PascalCase TypeScript enums and row/insert/update interfaces.
- Adds `knex/types/tables` augmentation for typed `db('table_name')` usage.
- Creates schema-first Knex migrations by diffing snapshots.
- Emits Knex schema-builder migrations where possible, using raw SQL only for Postgres-specific objects such as enums, extensions, and triggers.
- Can move those Postgres-specific SQL blocks into sidecar `.sql` files with `migrationSqlMode: 'files'`.
- Supports Knex clients: `postgresql`, `cockroachdb`, `mysql`, `mysql2`, `sqlite3`, `better-sqlite3`, `mssql`, `oracledb`, and `redshift`.
- Supports common Knex column types: `increments`, `bigIncrements`, `integer`, `tinyint`, `smallint`, `mediumint`, `bigInteger`, `bigint`, `text`, `string`, `float`, `double`, `decimal`, `boolean`, `date`, `dateTime`, `time`, `timestamp`, `binary`, `enu`, `json`, `jsonb`, `uuid`, `geometry`, `geography`, `point`, and `specificType`.
- Imports an existing Prisma Postgres schema as a starting point.
- Imports existing SQL migrations as a starting point.
- Generates AI guidance files and VS Code snippets.
- Uses `snake_case` names by default for physical SQL tables, columns, enums, indexes, and constraints.
- Validates schema shape, references, enum usage, provider-specific column support, and duplicate physical names before generation.

## Production Status

Knexty validates schemas during `defineSchema()`, blocks unsafe automatic migrations by default, and includes a package check script:

```sh
pnpm run check
```

For database-backed migration validation, use `docker-compose.e2e.yml` and run `pnpm run check` with `KNEXTY_E2E_ADMIN_DATABASE_URL` and `KNEXTY_E2E_DATABASE_URL`.

See [PRODUCTION.md](./PRODUCTION.md) for the rollout checklist and current limits.

## Minimal Schema

```ts
import { defineSchema, sql } from 'knexty'

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
    role: sql.enum('role', ['ADMIN', 'RECRUITER', 'TALENT']),
  },
  tables: {
    user: sql.table('user', {
      id: sql.increments().primaryKey(),
      email: sql.string(255).unique(),
      role: sql.enumRef('role').default('TALENT'),
      metadata: sql.json().nullable(),
      created_at: sql.timestamp().defaultNow(),
      updated_at: sql.timestamp().updatedAt(),
    }),
  },
})
```

`pg` remains exported as a backwards-compatible alias for `sql`.

## Non-Postgres Example

```ts
import { defineSchema, sql } from 'knexty'

export default defineSchema({
  database: {
    name: 'sqlite',
    provider: 'better-sqlite3',
    connection: { filename: { env: 'SQLITE_DATABASE_PATH' } },
  },
  generator: {
    output: '../src/database/generated/sqlite',
    snapshotsDir: './snapshots/sqlite',
    migrationsDir: './migrations/sqlite',
  },
  tables: {
    user: sql.table('user', {
      id: sql.increments().primaryKey(),
      email: sql.string(255).unique(),
      status: sql.enu(['ACTIVE', 'BLOCKED']).default('ACTIVE'),
      preferences: sql.json().nullable(),
      created_at: sql.timestamp().defaultNow(),
    }),
  },
})
```

Provider notes:

- `enumRef` maps to native Postgres/Cockroach enum types. On other clients, use `enu([...])` or expect enum changes to require a manual migration.
- `updatedAt()` creates a trigger automatically for PostgreSQL. Other clients should use `defaultRaw(...)` or a manual migration when they need database-managed update timestamps.
- `jsonbArray()` and `textArray()` are Postgres-oriented; use `json()`/`jsonb()` or `specificType(...)` for other clients.

## Generated Types

Generated TypeScript keeps SQL names in the table/column keys, but uses idiomatic type names:

```ts
export const Role = {
  ADMIN: 'ADMIN',
  RECRUITER: 'RECRUITER',
  TALENT: 'TALENT',
} as const
export type Role = typeof Role[keyof typeof Role]

export interface UserRow {
  id: number
  email: string
  role: Role
}
```

## CLI

```sh
knexty import-prisma --schema prisma/postgres/schema.prisma --out database/postgres.schema.knex.ts
knexty import-migrations --dir prisma/postgres/migrations --out database/postgres.schema.knex.ts
knexty validate --schema database/postgres.schema.knex.ts
knexty generate --schema database/postgres.schema.knex.ts
knexty baseline --schema database/postgres.schema.knex.ts
knexty migration:make add_users_index --schema database/postgres.schema.knex.ts
knexty migration:make add_users_index --schema database/postgres.schema.knex.ts --sql-files
knexty migrate:latest --schema database/postgres.schema.knex.ts
knexty migrate:rollback --schema database/postgres.schema.knex.ts
knexty snippets --editor vscode
```

With `migrationSqlMode: 'files'`, generated `.ts` migrations use Knex schema builder for tables, columns, indexes, unique constraints, and foreign keys. Postgres-only SQL such as `CREATE TYPE`, `CREATE TRIGGER`, and `CREATE EXTENSION` is written to one `*.up.sql` and one `*.down.sql` sidecar per migration, with internal block markers so the TypeScript migration can run each SQL block in the correct order.

## Safety Defaults

Automatic migrations handle additive changes. Table removal, column removal, enum value removal, and type changes are blocked unless a manual migration is written.
# knexty
