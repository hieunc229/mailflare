# Databases

Mailflare stores its data in **Cloudflare D1** by default. Nothing needs configuring for that: deploy with the `DB` binding from `wrangler.jsonc` and you are done.

Set `DATABASE_URL` to use another database instead. Every database [Drizzle ORM](https://orm.drizzle.team) supports is covered by three dialects:

| Dialect | Drivers (`DATABASE_DRIVER`) | Typical services |
| --- | --- | --- |
| SQLite | `d1` (default), `libsql`, `better-sqlite3`, `bun-sqlite` | Cloudflare D1, Turso / libSQL, a local file |
| PostgreSQL | `node-postgres`, `postgres-js`, `neon`, `pglite` | Supabase, Neon, Vercel Postgres, RDS, Cloud SQL, self-hosted, embedded PGlite |
| MySQL | `mysql2`, `planetscale` | MySQL 8, MariaDB 11, TiDB, PlanetScale, Aurora |

The driver is inferred from the URL. Set `DATABASE_DRIVER` only to override it. Names such as `pg`, `postgres`, `supabase`, `vercel`, `turso`, `mysql`, `tidb` and `mariadb` are accepted as aliases.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Connection string. Unset means D1 (Workers) or the local SQLite file (self-hosted). |
| `DATABASE_DRIVER` | Optional driver override, see the table above. |
| `DATABASE_AUTH_TOKEN` | Auth token for libSQL / Turso. |

On Cloudflare Workers set them as Worker variables or secrets (`npx wrangler secret put DATABASE_URL`). Self-hosted, put them in the container environment (`.env.docker`).

### Per database

| Database | `DATABASE_URL` | Notes |
| --- | --- | --- |
| Cloudflare D1 | unset | Default. Apply migrations with `npm run db:migrate:remote` or from Admin → Settings. |
| Turso / libSQL | `libsql://my-db.turso.io` + `DATABASE_AUTH_TOKEN` | Runs on Workers and Node. |
| Local SQLite file | `file:./data/mailflare.db` | Node only (better-sqlite3). The self-hosted default is already a SQLite file in `DATA_DIR`. |
| Bun SQLite | `file:./mailflare.db` + `DATABASE_DRIVER=bun-sqlite` | Bun only. |
| PostgreSQL | `postgres://user:pass@host:5432/db` | node-postgres. Add `?sslmode=require` where TLS is required. |
| Supabase | the pooler or direct URL from the dashboard | node-postgres. Use the transaction pooler on Workers. |
| Neon / Vercel Postgres | `postgres://…neon.tech/db?sslmode=require` | Detected from the hostname; uses Neon's HTTP driver (works on Workers). `DATABASE_DRIVER=node-postgres` selects TCP instead. |
| postgres.js | any `postgres://` URL + `DATABASE_DRIVER=postgres-js` | |
| PGlite | `pglite://./data/pg` or `pglite://memory` | Embedded Postgres, Node only; useful for development and tests. |
| MySQL / MariaDB / TiDB | `mysql://user:pass@host:3306/db` | mysql2. TiDB Cloud hosts get TLS automatically; `?ssl=true` forces it elsewhere. |
| PlanetScale | `mysql://user:pass@aws.connect.psdb.cloud/db` | Detected from the hostname; HTTP driver, works on Workers. |
| Hyperdrive (Workers) | `DATABASE_DRIVER=node-postgres` (or `mysql2`) and a `HYPERDRIVE` binding | The binding's connection string is used when `DATABASE_URL` is unset. |

Create an empty database (and user) first. Mailflare creates its tables.

### Workers and the schema dialect

The table definitions are built for the active dialect when the app starts, so on Workers `DATABASE_URL` (or `DATABASE_DRIVER` with a Hyperdrive binding) must be available as a variable or secret, not only at request time. Changing database means a new, empty database: use **Backups** to move data (below).

## Migrations

Migrations are plain SQL, one directory per dialect, applied by the same code everywhere (Admin → Settings, `/api/setup/prepare`, and automatically on start when self-hosted):

| Dialect | Directory | Ledger table |
| --- | --- | --- |
| SQLite | `drizzle/migrations` | `d1_migrations` |
| PostgreSQL | `drizzle/migrations-pg` | `mailflare_migrations` |
| MySQL | `drizzle/migrations-mysql` | `mailflare_migrations` |

PostgreSQL and MySQL start from a single baseline generated from the current schema (`0000_baseline.sql`), followed by `0001_triggers_and_seeds.sql` for what drizzle-kit cannot generate (seed rows and triggers). SQLite keeps its full history.

Changing the schema (`src/db/schema/index.ts`) means generating a migration for each dialect:

```bash
npm run db:generate        # SQLite  -> drizzle/migrations
npm run db:generate:pg     # PostgreSQL -> drizzle/migrations-pg
npm run db:generate:mysql  # MySQL -> drizzle/migrations-mysql
npm run db:bundle          # rebuild the bundles the Worker applies
```

`tests/database-dialects.test.mjs` fails if the dialects drift apart (different tables or columns, a stale bundle, an unindexable MySQL column).

## What is the same everywhere

The application code is written once. `getDb(env)` and `env.DB` work as before: on other databases `env.DB` is an adapter with the D1 interface (`prepare`, `bind`, `batch`) over the configured driver, and the Drizzle instance is built for the right dialect. Stored values are identical across dialects: timestamps are whole seconds in a `bigint`, booleans are booleans (`tinyint(1)` on MySQL), so SQL fragments and **backups are portable**: a backup taken on D1 restores onto PostgreSQL or MySQL and back.

Also kept on every dialect: foreign keys and cascades, the JMAP change log and mailbox revisions (via triggers), automatic `trashed_at` tracking, and seed rows.

## What differs

| Area | SQLite / D1 | PostgreSQL | MySQL / MariaDB |
| --- | --- | --- | --- |
| Message search | FTS5 index, prefix and column matching | `ILIKE`-style substring scan of subject, addresses and body; accelerated by `pg_trgm` indexes when the extension can be created | Substring `LIKE` scan |
| Search index page (Admin) | Rebuild available | Not applicable (always "indexed") | Not applicable |
| `agent_send_approvals` duplicate-delivery guard | Partial unique index | Partial unique index | Plain index (MySQL has no partial indexes); the status claim still prevents double sends |
| Wide covering indexes on `messages` | Full | Full | Trimmed to fit InnoDB's 3072-byte key limit; expression keys (`coalesce(thread_id, id)`) dropped. Conversation view is slower on very large mailboxes |
| One agent job per mailbox | Atomic in the claim statement | Atomic | Checked just before the claim (small race window) |
| `batch` atomicity | Atomic | Atomic | Atomic for DML; MySQL commits DDL implicitly, so a failed migration can leave earlier statements applied |
| `neon` (HTTP) | n/a | Batches run as separate statements (the HTTP protocol has no interactive transaction); use `node-postgres` for atomic batches | n/a |

Why search is the main difference: FTS5 is an SQLite extension, PostgreSQL's equivalent (`tsvector`) and MySQL's `FULLTEXT` have different grammars and ranking, and the search syntax (`from:`, `subject:`, quoted phrases, `-term`) is translated into plain predicates on those dialects instead. That is correct but unindexed, so searches scan the messages of the mailbox being searched. For large mailboxes, D1/SQLite, or PostgreSQL with `pg_trgm`, searches faster.

Other things to know:

- **Moving between databases** is done with **Admin → Backups**: take a backup, point `DATABASE_URL` at the new empty database, finish setup, restore. Raw mail and attachments live in object storage and are unaffected — including when `STORAGE_DRIVER=database`, where their rows are deliberately excluded from backups so each backup does not embed the ones before it.
- **Connections.** Self-hosted (Node) uses a connection pool. On Workers a TCP connection cannot outlive a request, so each query opens its own connection; put Hyperdrive (or a pooler such as Supabase's, Neon's or PlanetScale's) in front, or pick an HTTP driver (`neon`, `planetscale`, `libsql`).
- **Case sensitivity.** SQLite and PostgreSQL compare text case-sensitively; MySQL's default collations do not, so on MySQL two accounts whose emails differ only by case collide on the unique index.
- **Reserved words.** All SQL is generated with quoted identifiers; hand-written SQL in your own migrations should quote `key`, `read`, `repeat`, `change` and friends for MySQL.
- **Not covered:** SingleStore and other Drizzle dialects outside SQLite, PostgreSQL and MySQL.

## Trying it locally

```bash
# PostgreSQL without a server
npm run db:smoke -- pglite://memory

# Against real servers
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=mailflare postgres:17
docker run -d -p 3306:3306 -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=mailflare mysql:8.4
MAILFLARE_DB_DIALECT=postgres npm run db:smoke -- postgres://postgres:pw@127.0.0.1:5432/mailflare
MAILFLARE_DB_DIALECT=mysql npm run db:smoke -- mysql://root:pw@127.0.0.1:3306/mailflare
```

`db:smoke` applies the migrations and exercises the query shapes the app relies on (inserts, upserts, `returning`, triggers, batches, search, backups, bookings). Set `MAILFLARE_DB_DIALECT` to match the URL when running it (the app derives it from `DATABASE_URL` by itself).

Self-hosted with Docker Compose and PostgreSQL (add next to the `mailflare` service, then set `DATABASE_URL=postgres://mailflare:change-me@db:5432/mailflare` in `.env.docker`):

```yaml
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: mailflare
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: mailflare
    volumes:
      - mailflare-db:/var/lib/postgresql/data
```

Run the app itself against another database:

```bash
DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/mailflare npm run dev:node
```
