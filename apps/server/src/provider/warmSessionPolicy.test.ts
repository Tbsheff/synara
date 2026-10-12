import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { selectWarmSessionEvictions } from "./warmSessionPolicy.ts";

const ids = ["a", "b", "c", "d"].map((id) => ThreadId.makeUnsafe(id));
const next = ThreadId.makeUnsafe("e");

describe("warm session capacity", () => {
  it("reserves a slot by evicting the least recently used idle session", () => {
    expect(
      selectWarmSessionEvictions({ idleThreadIds: ids, threadId: next, limit: 4, reserving: true }),
    ).toEqual([ids[0]]);
  });
  it("touches an existing idle session without taking a second slot", () => {
    expect(
      selectWarmSessionEvictions({
        idleThreadIds: ids,
        threadId: ids[0]!,
        limit: 4,
        reserving: true,
      }),
    ).toEqual([]);
  });
  it("enforces a smaller limit after turns settle", () => {
    expect(
      selectWarmSessionEvictions({
        idleThreadIds: ids,
        threadId: ids[3]!,
        limit: 2,
        reserving: false,
      }),
    ).toEqual(ids.slice(0, 2));
  });
  it("disables pre-warm at zero and retires all idle sessions", () => {
    expect(
      selectWarmSessionEvictions({ idleThreadIds: ids, threadId: next, limit: 0, reserving: true }),
    ).toBeNull();
    expect(
      selectWarmSessionEvictions({
        idleThreadIds: ids,
        threadId: next,
        limit: 0,
        reserving: false,
      }),
    ).toEqual(ids);
  });
});
