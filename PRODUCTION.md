# Production Readiness

Knexty is designed to be safe for gradual adoption in production systems, but schema migration tools deserve a conservative rollout.

## What Is Covered

- TypeScript DSL validation runs inside `defineSchema()`.
- Generated TypeScript is checked with `tsc --noEmit`.
- Automated tests cover schema validation, type generation, non-Postgres rendering, SQL sidecars, and mapped references.
- Additive migrations are generated automatically from snapshots.
- Destructive changes are blocked by default and must be handled manually or with `--allow-destructive`.
- Postgres raw SQL blocks can be kept in sidecar `.sql` files with `migrationSqlMode: 'files'`.
- `updatedAt()` is database-managed only for PostgreSQL, using a trigger.

## Recommended Production Flow

1. Commit `schema.knex.ts`, generated types, snapshots, and migrations together.
2. Run `knexty validate --schema ...`, `knexty generate --schema ...`, and `knexty migration:make ... --schema ...` locally.
3. Review generated migrations before deploying.
4. Use `knexty baseline --schema ...` for an existing database before creating new migrations.
5. Run migrations in staging against a copy or representative dataset.
6. Keep destructive operations as explicit hand-written migrations.

## Release Checks

Run from this package:

```sh
pnpm run check
```

This performs:

- TypeScript typecheck.
- Package build.
- Node test suite.

For the real Postgres migration E2E, start the test database and run the same check with database URLs:

```sh
docker compose -f docker-compose.e2e.yml up -d --wait
KNEXTY_E2E_ADMIN_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/postgres \
KNEXTY_E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/linkedtech \
pnpm run check
docker compose -f docker-compose.e2e.yml down -v
```

The Postgres E2E covers CLI validation, `migration:make`, SQL sidecars, `migrate:latest`, `baseline`, no-op diffs, additive migrations, enum value additions, FK cascade, `updated_at` trigger behavior, and rollback.

## Current Limits

- Postgres has the most complete behavior.
- Other Knex clients are supported for DSL and generated migration syntax, but provider-specific SQL should be reviewed carefully.
- Enum value removal is manual.
- Column renames and table renames are manual.
- `jsonbArray()` and `textArray()` are PostgreSQL/CockroachDB features.
- Database-managed `updatedAt()` triggers are PostgreSQL-only in this version.
