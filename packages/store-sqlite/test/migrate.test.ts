import { describe, expect, it } from 'vitest';
import { MigrationChecksumError, runMigrations } from '../src/migrate.js';
import { MIGRATIONS_DIR, freshStore } from './helpers.js';

describe('migration runner', () => {
  it('throws when an applied migration checksum has been edited since it was applied', () => {
    const f = freshStore();
    // Simulate history being edited: the row in `migrations` no longer
    // matches the sha256 of the on-disk 0001_initial.sql file.
    f.db
      .prepare("UPDATE migrations SET checksum = 'deliberately-wrong-checksum' WHERE version = 1")
      .run();

    expect(() => runMigrations(f.db, MIGRATIONS_DIR)).toThrow(MigrationChecksumError);
    f.cleanup();
  });

  it('applying migrations again after a tampered checksum still throws via store.migrate()', async () => {
    const f = freshStore();
    f.db.prepare("UPDATE migrations SET checksum = 'tampered' WHERE version = 1").run();
    await expect(f.store.migrate()).rejects.toThrow(MigrationChecksumError);
    f.cleanup();
  });
});
