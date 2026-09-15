/**
 * @file src/shared/types/schema-guard.ts
 * @purpose Type-level helpers letting each domain module assert its Zod schema and TypeScript interface stay in sync at compile time.
 * @exports OptionalUndefined, SchemaMatches, AssertTrue
 * @depends zod
 */
import type { z } from "zod";

/**
 * Widens the named keys of `T` to also permit `undefined`, matching how a Zod
 * `.optional()` field infers versus an `exactOptionalPropertyTypes` interface.
 */
export type OptionalUndefined<T, Key extends keyof T> = Omit<T, Key> & {
  [Property in Key]?: T[Property] | undefined;
};

/**
 * Resolves to `true` only when `z.infer<Schema>` and `Interface` are mutually
 * assignable; otherwise resolves to a tuple literal naming the drift direction,
 * which fails the `AssertTrue` constraint at the guard site.
 */
export type SchemaMatches<
  Schema extends z.ZodTypeAny,
  Interface,
> = z.infer<Schema> extends Interface
  ? Interface extends z.infer<Schema>
    ? true
    : ["interface has fields not in schema"]
  : ["schema produces fields not in interface"];

/**
 * Compile-time assertion that its argument type is exactly `true`.
 */
export type AssertTrue<T extends true> = T;
