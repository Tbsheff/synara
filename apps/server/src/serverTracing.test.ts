import { Deferred, Effect, Layer, Tracer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import * as NodeSqliteClient from "./persistence/NodeSqliteClient";
import { ServerTracingLive } from "./serverTracing";

function makeCountingTracer() {
  let spans = 0;
  const tracer = Tracer.make({
    span: (options) => {
      spans += 1;
      return new Tracer.NativeSpan(options);
    },
  });
  return { tracer, spans: () => spans };
}

const runServerShapedProgram = (base: Layer.Layer<never>) => {
  const counting = makeCountingTracer();
  const program = Effect.gen(function* () {
    const forkedSqlDone = yield* Deferred.make<void>();
    const services = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE probe (id INTEGER PRIMARY KEY)`;
        yield* Effect.forkScoped(
          sql
            .withTransaction(sql`INSERT INTO probe (id) VALUES (1)`)
            .pipe(Effect.andThen(Deferred.succeed(forkedSqlDone, undefined))),
        );
      }),
    );
    const layer = Layer.empty.pipe(
      Layer.provideMerge(services),
      Layer.provideMerge(NodeSqliteClient.layerMemory()),
      Layer.provideMerge(base),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`;
      yield* Deferred.await(forkedSqlDone);
    }).pipe(Effect.provide(layer));
  });
  return Effect.runPromise(
    program.pipe(Effect.scoped, Effect.provideService(Tracer.Tracer, counting.tracer)),
  ).then(() => counting.spans());
};

it("creates no tracing spans for SQL anywhere under the server layer", async () => {
  await expect(runServerShapedProgram(Layer.empty)).resolves.toBeGreaterThanOrEqual(4);
  await expect(runServerShapedProgram(ServerTracingLive)).resolves.toBe(0);
});
