import { MAILUO_SCHEMA_SQL } from "./schema.ts";

export type MailuoMigrationDatabase = {
  exec(sql: string): void;
  getUserVersion(): number;
};

export const MAILUO_MIGRATIONS = [
  {
    version: 1,
    sql: "ALTER TABLE meetings ADD COLUMN kind TEXT NOT NULL DEFAULT 'meeting'",
  },
] as const;

export const MAILUO_SCHEMA_VERSION = MAILUO_MIGRATIONS.at(-1)?.version ?? 0;

function runTransaction(database: MailuoMigrationDatabase, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");

  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure when rollback also fails.
    }

    throw error;
  }
}

function assertSupportedVersion(userVersion: number): void {
  if (!Number.isSafeInteger(userVersion) || userVersion < 0) {
    throw new RangeError(`Invalid SQLite user_version: ${userVersion}`);
  }

  if (userVersion > MAILUO_SCHEMA_VERSION) {
    throw new Error(
      `SQLite schema version ${userVersion} is newer than supported version ${MAILUO_SCHEMA_VERSION}`,
    );
  }
}

export function initializeMailuoSchema(database: MailuoMigrationDatabase): void {
  runTransaction(database, () => {
    let userVersion = database.getUserVersion();
    assertSupportedVersion(userVersion);
    database.exec(MAILUO_SCHEMA_SQL);

    // simplified: migrations are a linear SQL sequence; add a versioned callback only when a
    // future migration needs a data transform that cannot be expressed as SQL.
    for (const migration of MAILUO_MIGRATIONS) {
      if (migration.version <= userVersion) {
        continue;
      }

      if (migration.version !== userVersion + 1) {
        throw new Error(
          `Missing SQLite migration between versions ${userVersion} and ${migration.version}`,
        );
      }

      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      userVersion = migration.version;
    }
  });
}
