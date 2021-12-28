import * as path from 'path'
import { promises as fs } from 'fs'

import { Kysely } from '../kysely.js'
import {
  freeze,
  getLast,
  isFunction,
  isObject,
  isString,
} from '../util/object-utils.js'
import { DialectAdapter } from '../dialect/dialect-adapter.js'

export const MIGRATION_TABLE = 'kysely_migration'
export const MIGRATION_LOCK_TABLE = 'kysely_migration_lock'
export const MIGRATION_LOCK_ID = 'migration_lock'
export const NO_MIGRATIONS: NoMigrations = freeze({ __noMigrations__: true })

export type MigrationsOrFolderPath = Record<string, Migration> | string

export interface Migration {
  up(db: Kysely<any>): Promise<void>
  down?(db: Kysely<any>): Promise<void>
}

/**
 * Type for the NO_MIGRATIONS constant. Never create one of these.
 */
export interface NoMigrations {
  readonly __noMigrations__: true
}

/**
 * All migration methods ({@link MigrationModule.migrateTo | migrateTo},
 * {@link MigrationModule.migrateToLatest | migrateToLatest} etc.) never
 * throw but return this object instead.
 */
export interface MigrationResultSet {
  /**
   * This is defined if something went wrong.
   *
   * An error may have occurred in one of the migrations in which case the
   * {@link results} list contains an item with `status === 'Error'` to
   * indicate which migration failed.
   *
   * An error may also have occurred before Kysely was able to figure out
   * which migrations should be executed, in which case the {@link results}
   * list is undefined.
   */
  readonly error?: unknown

  /**
   * {@link MigrationResult} for each individual migration that was supposed
   * to be executed by the operation.
   *
   * If all went well, each result's `status` is `Success`. If some migration
   * failed, the failed migration's result's `status` is `Error` and all
   * results after that one have `status` ´NotExecuted`.
   *
   * This property can be undefined if an error occurred before Kysely was
   * able to figure out which migrations should be executed.
   *
   * If this list is empty, there were no migrations to execute.
   */
  readonly results?: MigrationResult[]
}

export interface MigrationResult {
  readonly migrationName: string

  /**
   * The direction in which this migration was executed.
   */
  readonly direction: 'Up' | 'Down'

  /**
   * The execution status.
   *
   *  - `Success` means the migration was successfully executed. Note that
   *    if any of the later migrations in the {@link MigrationResult.results}
   *    list failed (have status `Error`) AND the dialect supports transactional
   *    DDL, even the successfull migrations were rolled back.
   *
   *  - `Error` means the migration failed. In this case the
   *    {@link MigrationResult.error} contains the error.
   *
   *  - `NotExecuted` means that the migration was supposed to be executed
   *    but wasn't because an earlier migration failed.
   */
  readonly status: 'Success' | 'Error' | 'NotExecuted'
}

export class MigrationModule {
  readonly #db: Kysely<any>
  readonly #adapter: DialectAdapter

  constructor(db: Kysely<any>, adapter: DialectAdapter) {
    this.#db = db
    this.#adapter = adapter
  }

  /**
   * Runs all migrations that have not yet been run.
   *
   * The only argument must either be a file path to the folder that contains all migrations
   * OR an object that contains all migrations (not just the ones that need to be executed).
   * The keys in the object must be the unique migration names.
   *
   * This method returns a {@link MigrationResultSet} instance and _never_ throws.
   * {@link MigrationResultSet.error} holds the error if something went wrong.
   * {@link MigrationResultSet.results} contains information about which migrations
   * were executed and which failed. See the examples below.
   *
   * This method goes through all possible migrations (passed as the argument) and runs the
   * ones whose names are alphabetically after the last migration that has been run. If the
   * list of executed migrations doesn't match the beginning of the list of possible migrations
   * an error is thrown.
   *
   * ### Examples
   *
   * ```ts
   * const { error, results } = await db.migration.migrateToLatest(
   *   path.join(__dirname, 'migrations')
   * )
   *
   * results?.forEach((it) => {
   *   if (it.status === 'Success') {
   *     console.log(`migration "${it.migrationName}" was executed successfully`)
   *   } else if (it.status === 'Error') {
   *     console.error(`failed to execute migration "${it.migrationName}"`)
   *   }
   * })
   *
   * if (error) {
   *   console.error('failed to run `migrateToLatest`')
   *   console.error(error)
   * }
   * ```
   *
   * In the next example, we use a record of migration objects instead of file folder path.
   * The keys in the object are migration names that can be anything you want. The order of
   * the migrations is determined based on the alphabetical order of the keys in the record.
   * This version of the `migrateToLatest` method can be useful if you are using a bundler
   * like webpack or esbuild.
   *
   * ```ts
   * await db.migration.migrateToLatest({
   *   migration1: {
   *     async up(db: Kysely<any>): Promise<void> {
   *       ...
   *     },
   *
   *     async down(db: Kysely<any>): Promise<void> {
   *       ...
   *     }
   *   },
   *
   *   migration2: {
   *     async up(db: Kysely<any>): Promise<void> {
   *       ...
   *     },
   *
   *     async down(db: Kysely<any>): Promise<void> {
   *       ...
   *     }
   *   },
   *
   *  ...
   * })
   * ```
   */
  migrateToLatest(migrationsFolderPath: string): Promise<MigrationResultSet>
  migrateToLatest(
    allMigrations: Record<string, Migration>
  ): Promise<MigrationResultSet>

  async migrateToLatest(
    migrationsOrFolderPath: MigrationsOrFolderPath
  ): Promise<MigrationResultSet> {
    return this.#migrate(
      migrationsOrFolderPath,
      ({ migrations }) => migrations.length - 1
    )
  }

  /**
   * Migrate up/down to a specific migration.
   *
   * Otherwise works just like {@link migrateToLatest}. The first argument
   * behaves the same, the output is the same etc.
   *
   * ### Examples
   *
   * ```ts
   * await db.migration.migrateTo(
   *   path.join(__dirname, 'migrations'),
   *   'some_migration'
   * )
   * ```
   *
   * If you specify the name of the first migration, this method migrates
   * down to the first migration, but doesn't run the `down` migration for
   * the first migration. In case you want to migrate down ALL migrations
   * you can use a special constant `NO_MIGRATIONS`:
   *
   * ```ts
   * await db.migration.migrateTo(
   *   path.join(__dirname, 'migrations'),
   *   NO_MIGRATIONS,
   * )
   * ```
   */
  migrateTo(
    migrationsFolderPath: string,
    targetMigrationName: string | NoMigrations
  ): Promise<MigrationResultSet>

  migrateTo(
    allMigrations: Record<string, Migration>,
    targetMigrationName: string | NoMigrations
  ): Promise<MigrationResultSet>

  async migrateTo(
    migrationsOrFolderPath: MigrationsOrFolderPath,
    targetMigrationName: string | NoMigrations
  ): Promise<MigrationResultSet> {
    return this.#migrate(migrationsOrFolderPath, ({ migrations }) => {
      if (targetMigrationName === NO_MIGRATIONS) {
        return -1
      }

      const index = migrations.findIndex(
        (it) => it.name === targetMigrationName
      )

      if (index === -1) {
        throw new Error(`migration "${targetMigrationName}" doesn't exist`)
      }

      return index
    })
  }

  /**
   * Migrate one step up.
   *
   * Otherwise works just like {@link migrateToLatest}. The only argument
   * behaves the same, the output is the same etc.
   *
   * ### Examples
   *
   * ```ts
   * await db.migration.migrateUp(
   *   path.join(__dirname, 'migrations'),
   * )
   * ```
   */
  migrateUp(migrationsFolderPath: string): Promise<MigrationResultSet>

  migrateUp(
    allMigrations: Record<string, Migration>
  ): Promise<MigrationResultSet>

  async migrateUp(
    migrationsOrFolderPath: MigrationsOrFolderPath
  ): Promise<MigrationResultSet> {
    return this.#migrate(
      migrationsOrFolderPath,
      ({ currentIndex, migrations }) =>
        Math.min(currentIndex + 1, migrations.length - 1)
    )
  }

  /**
   * Migrate one step down.
   *
   * Otherwise works just like {@link migrateToLatest}. The only argument
   * behaves the same, the output is the same etc.
   *
   * ### Examples
   *
   * ```ts
   * await db.migration.migrateDown(
   *   path.join(__dirname, 'migrations'),
   * )
   * ```
   */
  migrateDown(migrationsFolderPath: string): Promise<MigrationResultSet>

  migrateDown(
    allMigrations: Record<string, Migration>
  ): Promise<MigrationResultSet>

  async migrateDown(
    migrationsOrFolderPath: MigrationsOrFolderPath
  ): Promise<MigrationResultSet> {
    return this.#migrate(migrationsOrFolderPath, ({ currentIndex }) =>
      Math.max(currentIndex - 1, -1)
    )
  }

  async #migrate(
    migrationsOrFolderPath: MigrationsOrFolderPath,
    getTargetMigration: (state: MigrationState) => number | undefined
  ): Promise<MigrationResultSet> {
    try {
      await this.#ensureMigrationTablesExists()

      return await this.#runMigrations(
        migrationsOrFolderPath,
        getTargetMigration
      )
    } catch (error) {
      if (error instanceof MigrationResultSetError) {
        return error.resultSet
      }

      return { error }
    }
  }

  async #ensureMigrationTablesExists(): Promise<void> {
    await this.#ensureMigrationTableExists()
    await this.#ensureMigrationLockTableExists()
    await this.#ensureLockRowExists()
  }

  async #ensureMigrationTableExists(): Promise<void> {
    if (!(await this.#doesTableExists(MIGRATION_TABLE))) {
      try {
        await this.#db.schema
          .createTable(MIGRATION_TABLE)
          .ifNotExists()
          .addColumn('name', 'varchar(255)', (col) =>
            col.notNull().primaryKey()
          )
          // The migration run time as ISO string. This is not a real date type as we
          // can't know which data type is supported by all future dialects.
          .addColumn('timestamp', 'varchar(255)', (col) => col.notNull())
          .execute()
      } catch (error) {
        // At least on PostgreSQL, `if not exists` doesn't guarantee the `create table`
        // query doesn't throw if the table already exits. That's why we check if
        // the table exist here and ignore the error if it does.
        if (!(await this.#doesTableExists(MIGRATION_TABLE))) {
          throw error
        }
      }
    }
  }

  async #ensureMigrationLockTableExists(): Promise<void> {
    if (!(await this.#doesTableExists(MIGRATION_LOCK_TABLE))) {
      try {
        await this.#db.schema
          .createTable(MIGRATION_LOCK_TABLE)
          .ifNotExists()
          .addColumn('id', 'varchar(255)', (col) => col.notNull().primaryKey())
          .addColumn('is_locked', 'integer', (col) =>
            col.notNull().defaultTo(0)
          )
          .execute()
      } catch (error) {
        // At least on PostgreSQL, `if not exists` doesn't guarantee the `create table`
        // query doesn't throw if the table already exits. That's why we check if
        // the table exist here and ignore the error if it does.
        if (!(await this.#doesTableExists(MIGRATION_LOCK_TABLE))) {
          throw error
        }
      }
    }
  }

  async #ensureLockRowExists(): Promise<void> {
    if (!(await this.#doesLockRowExists())) {
      try {
        await this.#db
          .insertInto(MIGRATION_LOCK_TABLE)
          .values({ id: MIGRATION_LOCK_ID })
          .execute()
      } catch (error) {
        if (!(await this.#doesLockRowExists())) {
          throw error
        }
      }
    }
  }

  async #doesTableExists(tableName: string): Promise<boolean> {
    const metadata = await this.#db.introspection.getMetadata({
      withInternalKyselyTables: true,
    })

    return !!metadata.tables.find((it) => it.name === tableName)
  }

  async #doesLockRowExists(): Promise<boolean> {
    const lockRow = await this.#db
      .selectFrom(MIGRATION_LOCK_TABLE)
      .where('id', '=', MIGRATION_LOCK_ID)
      .select('id')
      .executeTakeFirst()

    return !!lockRow
  }

  async #runMigrations(
    migrationsOrFolderPath: MigrationsOrFolderPath,
    getTargetMigration: (state: MigrationState) => number | undefined
  ): Promise<MigrationResultSet> {
    const run = async (db: Kysely<any>): Promise<MigrationResultSet> => {
      try {
        await this.#adapter.acquireMigrationLock(db)

        const state = await this.#getState(db, migrationsOrFolderPath)

        if (state.migrations.length === 0) {
          return { results: [] }
        }

        const targetIndex = getTargetMigration(state)

        if (targetIndex === undefined) {
          return { results: [] }
        }

        if (targetIndex < state.currentIndex) {
          return await this.#migrateDown(db, state, targetIndex)
        } else if (targetIndex > state.currentIndex) {
          return await this.#migrateUp(db, state, targetIndex)
        }

        return { results: [] }
      } finally {
        await this.#adapter.releaseMigrationLock(db)
      }
    }

    if (this.#adapter.supportsTransactionalDdl) {
      return this.#db.transaction().execute(run)
    } else {
      return this.#db.connection().execute(run)
    }
  }

  async #getState(
    db: Kysely<any>,
    migrationsOrFolderPath: MigrationsOrFolderPath
  ): Promise<MigrationState> {
    const migrations = await this.#resolveMigrations(migrationsOrFolderPath)
    const executedMigrations = await this.#getExecutedMigrations(db)

    this.#ensureMigrationsNotCorrupted(migrations, executedMigrations)

    return freeze({
      migrations,
      currentIndex: migrations.findIndex(
        (it) => it.name === getLast(executedMigrations)
      ),
    })
  }

  async #resolveMigrations(
    migrationsOrFolderPath: Record<string, Migration> | string
  ): Promise<ReadonlyArray<NamedMigration>> {
    const allMigrations = isString(migrationsOrFolderPath)
      ? await this.#readMigrationsFromFolder(migrationsOrFolderPath)
      : migrationsOrFolderPath

    return Object.keys(allMigrations)
      .sort()
      .map((name) => ({
        ...allMigrations[name],
        name,
      }))
  }

  async #readMigrationsFromFolder(
    migrationsFolderPath: string
  ): Promise<Record<string, Migration>> {
    const files = await fs.readdir(migrationsFolderPath)
    const migrations: Record<string, Migration> = {}

    for (const file of files) {
      if (
        (file.endsWith('.js') || file.endsWith('.ts')) &&
        !file.endsWith('.d.ts')
      ) {
        const migration = await import(path.join(migrationsFolderPath, file))

        if (isMigration(migration)) {
          migrations[file.substring(0, file.length - 3)] = migration
        }
      }
    }

    return migrations
  }

  async #getExecutedMigrations(
    db: Kysely<any>
  ): Promise<ReadonlyArray<string>> {
    const executedMigrations = await db
      .selectFrom(MIGRATION_TABLE)
      .select('name')
      .orderBy('name')
      .execute()

    return executedMigrations.map((it) => it.name)
  }

  #ensureMigrationsNotCorrupted(
    migrations: ReadonlyArray<NamedMigration>,
    executedMigrations: ReadonlyArray<string>
  ) {
    for (const executed of executedMigrations) {
      if (!migrations.some((it) => it.name === executed)) {
        throw new Error(
          `corrupted migrations: previously executed migration ${executed} is missing`
        )
      }
    }

    // Now we know all executed migrations exist in the `migrations` list.
    // Next we need to make sure that the executed migrations are the first
    // ones in the migration list.
    for (let i = 0; i < executedMigrations.length; ++i) {
      if (migrations[i].name !== executedMigrations[i]) {
        throw new Error(
          `corrupted migrations: expected previously executed migration ${executedMigrations[i]} to be at index ${i} but ${migrations[i].name} was found in its place. New migrations must always have a name that comes alphabetically after the last executed migration.`
        )
      }
    }
  }

  async #migrateDown(
    db: Kysely<any>,
    state: MigrationState,
    targetIndex: number
  ): Promise<MigrationResultSet> {
    const results: MigrationResult[] = []

    for (let i = state.currentIndex; i > targetIndex; --i) {
      results.push({
        migrationName: state.migrations[i].name,
        direction: 'Down',
        status: 'NotExecuted',
      })
    }

    for (let i = 0; i < results.length; ++i) {
      const migration = state.migrations.find(
        (it) => it.name === results[i].migrationName
      )!

      try {
        if (migration.down) {
          await migration.down(db)
          await db
            .deleteFrom(MIGRATION_TABLE)
            .where('name', '=', migration.name)
            .execute()

          results[i] = {
            migrationName: migration.name,
            direction: 'Down',
            status: 'Success',
          }
        }
      } catch (error) {
        results[i] = {
          migrationName: migration.name,
          direction: 'Down',
          status: 'Error',
        }

        throw new MigrationResultSetError({
          error,
          results,
        })
      }
    }

    return { results }
  }

  async #migrateUp(
    db: Kysely<any>,
    state: MigrationState,
    targetIndex: number
  ): Promise<MigrationResultSet> {
    const results: MigrationResult[] = []

    for (let i = state.currentIndex + 1; i <= targetIndex; ++i) {
      results.push({
        migrationName: state.migrations[i].name,
        direction: 'Up',
        status: 'NotExecuted',
      })
    }

    for (let i = 0; i < results.length; ++i) {
      const migration = state.migrations.find(
        (it) => it.name === results[i].migrationName
      )!

      try {
        await migration.up(db)
        await db
          .insertInto(MIGRATION_TABLE)
          .values({
            name: migration.name,
            timestamp: new Date().toISOString(),
          })
          .execute()

        results[i] = {
          migrationName: migration.name,
          direction: 'Up',
          status: 'Success',
        }
      } catch (error) {
        results[i] = {
          migrationName: migration.name,
          direction: 'Up',
          status: 'Error',
        }

        throw new MigrationResultSetError({
          error,
          results,
        })
      }
    }

    return { results }
  }
}

interface NamedMigration extends Migration {
  readonly name: string
}

interface MigrationState {
  // All migrations sorted by name.
  readonly migrations: ReadonlyArray<NamedMigration>

  // Index of the last executed migration.
  readonly currentIndex: number
}

class MigrationResultSetError extends Error {
  readonly #resultSet: MigrationResultSet

  constructor(result: MigrationResultSet) {
    super()
    this.#resultSet = result
  }

  get resultSet(): MigrationResultSet {
    return this.#resultSet
  }
}

function isMigration(obj: unknown): obj is Migration {
  return isObject(obj) && isFunction(obj.up)
}
