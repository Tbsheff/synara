import { Layer, References } from "effect";

export const ServerTracingLive = Layer.succeed(References.TracerEnabled, false);
