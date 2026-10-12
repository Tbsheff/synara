import type * as Effect from "effect/Effect";

const additiveOnlyMigrations = new WeakSet<object>();

export function additiveOnlyMigration<A, E, R>(
  migration: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  additiveOnlyMigrations.add(migration);
  return migration;
}

export function isAdditiveOnlyMigration(migration: object): boolean {
  return additiveOnlyMigrations.has(migration);
}
