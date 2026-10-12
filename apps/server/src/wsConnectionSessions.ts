import { randomUUID } from "node:crypto";

import { Effect, Layer, Scope, ServiceMap } from "effect";
import { RpcSerialization } from "effect/unstable/rpc";

import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "./managedAttachmentPrincipal";

export type WsSessionRole = "owner" | "client";

export const CurrentWsSessionRole = ServiceMap.Reference<WsSessionRole>(
  "synara/ws/CurrentSessionRole",
  { defaultValue: () => "client" },
);

export interface WsConnectionSession {
  readonly role: WsSessionRole;
  readonly attachmentPrincipal: ManagedAttachmentPrincipal;
}

export const WS_CONNECTION_SESSION_HEADER = "x-synara-ws-connection-session";

export interface WsConnectionSessionsShape {
  /** Registers the session for the lifetime of the connection scope. */
  readonly register: (session: WsConnectionSession) => Effect.Effect<string, never, Scope.Scope>;
  readonly lookup: (key: string | undefined) => WsConnectionSession | undefined;
  /** Registers cleanup on a live socket; false means it has already closed. */
  readonly onClose: (key: string, cleanup: () => void) => boolean;
}

export class WsConnectionSessions extends ServiceMap.Service<
  WsConnectionSessions,
  WsConnectionSessionsShape
>()("synara/ws/WsConnectionSessions") {}

export const makeWsConnectionSessions = Effect.sync(() => {
  const sessions = new Map<
    string,
    { readonly session: WsConnectionSession; readonly cleanups: Set<() => void> }
  >();
  return {
    register: (session: WsConnectionSession) =>
      Effect.gen(function* () {
        const key = randomUUID();
        const cleanups = new Set<() => void>();
        sessions.set(key, { session, cleanups });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sessions.delete(key);
            for (const cleanup of cleanups) cleanup();
            cleanups.clear();
          }),
        );
        return key;
      }),
    lookup: (key: string | undefined) =>
      key === undefined ? undefined : sessions.get(key)?.session,
    onClose: (key: string, cleanup: () => void) => {
      const connection = sessions.get(key);
      if (!connection) return false;
      connection.cleanups.add(cleanup);
      return true;
    },
  } satisfies WsConnectionSessionsShape;
});

export const WsConnectionSessionsLive = Layer.effect(
  WsConnectionSessions,
  makeWsConnectionSessions,
);

/**
 * Provides the connection session's identity services to an RPC handler
 * effect. With no session (no or unknown key), the effect keeps the
 * conservative defaults: role "client" and the local-loopback principal.
 */
export function provideWsConnectionSession<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  session: WsConnectionSession | undefined,
): Effect.Effect<A, E, R> {
  return session
    ? effect.pipe(
        Effect.provideService(CurrentWsSessionRole, session.role),
        Effect.provideService(CurrentManagedAttachmentPrincipal, session.attachmentPrincipal),
      )
    : effect;
}

function withoutReservedHeaders(message: unknown, reserved: ReadonlySet<string>): unknown {
  if (Array.isArray(message)) {
    return message.map((entry) => withoutReservedHeaders(entry, reserved));
  }
  if (
    typeof message !== "object" ||
    message === null ||
    (message as { readonly _tag?: unknown })._tag !== "Request"
  ) {
    return message;
  }
  const headers = (message as { readonly headers?: unknown }).headers;
  const kept = Array.isArray(headers)
    ? headers.filter(
        (entry): entry is readonly [string, string] =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          !reserved.has(entry[0].toLowerCase()),
      )
    : [];
  return { ...message, headers: kept };
}

export function withoutClientReservedRpcHeaders(
  serialization: RpcSerialization.RpcSerialization["Service"],
  reservedHeaders: ReadonlyArray<string>,
): RpcSerialization.RpcSerialization["Service"] {
  const reserved: ReadonlySet<string> = new Set(
    reservedHeaders.map((header) => header.toLowerCase()),
  );
  return RpcSerialization.RpcSerialization.of({
    contentType: serialization.contentType,
    includesFraming: serialization.includesFraming,
    makeUnsafe: () => {
      const parser = serialization.makeUnsafe();
      return {
        decode: (data) =>
          parser.decode(data).map((message) => withoutReservedHeaders(message, reserved)),
        encode: parser.encode,
      };
    },
  });
}
