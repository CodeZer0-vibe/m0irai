import { afterEach, expect, it } from "vitest";
import {
  BOOT_PROGRESS_METHOD,
  BOOT_PROGRESS_STAGES,
  SIMULATE_SLOW_BOOT_ENV,
  bootProgressNotification,
  delaySimulatedSlowBoot,
  simulatedSlowBootMs,
  validateBootProgressFrame,
} from "./room-boot-progress.js";

const saved = {
  slow: process.env[SIMULATE_SLOW_BOOT_ENV],
  hermetic: process.env.ZER0_HERMETIC,
};

afterEach(() => {
  restore(SIMULATE_SLOW_BOOT_ENV, saved.slow);
  restore("ZER0_HERMETIC", saved.hermetic);
});

it("emits exactly the three-key notification the terminal decodes, with and without a detail", () => {
  expect(bootProgressNotification("evidence")).toStrictEqual({
    jsonrpc: "2.0",
    method: BOOT_PROGRESS_METHOD,
    params: { stage: "evidence" },
  });
  expect(bootProgressNotification("migrate", "14 -> 14,15,16,20,21")).toStrictEqual({
    jsonrpc: "2.0",
    method: BOOT_PROGRESS_METHOD,
    params: { stage: "migrate", detail: "14 -> 14,15,16,20,21" },
  });
  for (const stage of BOOT_PROGRESS_STAGES) {
    expect(() => {
      validateBootProgressFrame(bootProgressNotification(stage));
    }).not.toThrow();
  }
});

it("refuses every frame that is not exactly a boot-progress notification", () => {
  const rejected: unknown[] = [
    undefined,
    "evidence",
    { jsonrpc: "2.0", method: "zer0/room/event", params: { stage: "evidence" } },
    { jsonrpc: "1.0", method: BOOT_PROGRESS_METHOD, params: { stage: "evidence" } },
    { jsonrpc: "2.0", method: BOOT_PROGRESS_METHOD, params: { stage: "evidence" }, id: "1" },
    { jsonrpc: "2.0", method: BOOT_PROGRESS_METHOD, params: { stage: "not-a-stage" } },
    { jsonrpc: "2.0", method: BOOT_PROGRESS_METHOD, params: { stage: "evidence", extra: 1 } },
    { jsonrpc: "2.0", method: BOOT_PROGRESS_METHOD, params: {} },
    { jsonrpc: "2.0", method: BOOT_PROGRESS_METHOD, params: { stage: "evidence", detail: 7 } },
    { jsonrpc: "2.0", method: BOOT_PROGRESS_METHOD, params: { stage: "evidence", detail: "" } },
  ];
  for (const frame of rejected) {
    expect(() => {
      validateBootProgressFrame(frame);
    }).toThrow(/invalid boot-progress/u);
  }
});

it("refuses a detail carrying a control character or exceeding the line bound", () => {
  const escapeChar = String.fromCodePoint(0x1b);
  const bell = String.fromCodePoint(0x07);
  const del = String.fromCodePoint(0x7f);
  for (const detail of [`${escapeChar}[2J`, `migration${bell}`, `14 ${del} 21`, "x".repeat(81)]) {
    expect(() => {
      validateBootProgressFrame({
        jsonrpc: "2.0",
        method: BOOT_PROGRESS_METHOD,
        params: { stage: "migrate", detail },
      });
    }).toThrow("invalid boot-progress detail");
  }
  // The producer clips rather than throws: an over-long detail is a formatting slip, not a protocol
  // violation, and losing the boot over one would be the defect this lane removes.
  const clipped = bootProgressNotification("migrate", "y".repeat(200));
  expect(() => {
    validateBootProgressFrame(clipped);
  }).not.toThrow();
});

/**
 * The review's I2, its exact input: one ASCII character then 50 U+1F600. That is 101 UTF-16 code units,
 * so a cut at 80 UNITS lands inside the fortieth emoji and emits a lone high surrogate. The TypeScript
 * validator cannot see it (it is neither long nor a control character) and Node's own JSON round trip
 * accepts it, so the frame reaches the wire — where this repo's Rust decoder fails the parse, the line
 * falls through to the room transport, that fails too, and the boot dies.
 *
 * Same defect class the repo ratcheted on at 459540b, "no shortening splits a code point".
 */
it("clips a detail on CODE POINTS, so an astral character on the boundary is never split", () => {
  const detail = `x${"\u{1F600}".repeat(50)}`;
  expect(detail.length).toBe(101);

  const frame = bootProgressNotification("migrate", detail);
  const clippedDetail = String((frame.params as Record<string, unknown>).detail ?? "");

  expect(hasLoneSurrogate(clippedDetail)).toBe(false);
  // The consequence, not just the cause: a lone surrogate cannot survive a UTF-8 round trip, which is
  // exactly what the bytes on the wire are.
  expect(Buffer.from(clippedDetail, "utf8").toString("utf8")).toBe(clippedDetail);
  // 51 code points is INSIDE the bound, so the right answer is to pass it through untouched. Under the
  // old UTF-16 bound the same string was 101 units and got cut in half.
  expect(clippedDetail).toBe(detail);
  expect(() => {
    validateBootProgressFrame(frame);
  }).not.toThrow();

  // And the clip when it genuinely fires: 100 code points in, exactly 80 out, still whole characters.
  const long = "\u{1F600}".repeat(100);
  const longFrame = bootProgressNotification("migrate", long);
  const longDetail = String((longFrame.params as Record<string, unknown>).detail ?? "");
  expect([...longDetail]).toHaveLength(80);
  expect(hasLoneSurrogate(longDetail)).toBe(false);
  expect(Buffer.from(longDetail, "utf8").toString("utf8")).toBe(longDetail);
  expect(() => {
    validateBootProgressFrame(longFrame);
  }).not.toThrow();
});

/** True when any UTF-16 code unit is a surrogate without its partner. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

it("REFUSES the slow-boot seam outside test support, whatever the variable says", () => {
  process.env[SIMULATE_SLOW_BOOT_ENV] = "5000";
  Reflect.deleteProperty(process.env, "ZER0_HERMETIC");
  expect(simulatedSlowBootMs()).toBe(0);

  // Positive control: the SAME value with the test-support marker present is honoured, so the zero
  // above is a refusal and not a broken parser.
  process.env.ZER0_HERMETIC = "1";
  expect(simulatedSlowBootMs()).toBe(5000);
});

it("caps, and reads garbage as off, so a hand-typed value cannot hang a boot", () => {
  process.env.ZER0_HERMETIC = "1";
  const cases: readonly [string, number][] = [
    ["600000", 60_000],
    ["  250 ", 250],
    ["-1", 0],
    ["0", 0],
    ["abc", 0],
    ["", 0],
  ];
  for (const [raw, expected] of cases) {
    process.env[SIMULATE_SLOW_BOOT_ENV] = raw;
    expect(simulatedSlowBootMs()).toBe(expected);
  }
});

it("adds no delay at all when the seam is off", async () => {
  Reflect.deleteProperty(process.env, "ZER0_HERMETIC");
  process.env[SIMULATE_SLOW_BOOT_ENV] = "30000";
  let settled = false;
  const waiting = delaySimulatedSlowBoot().then(() => {
    settled = true;
  });
  await waiting;
  expect(settled).toBe(true);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}
