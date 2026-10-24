/**
 * Branded (nominal) types.
 *
 * Why: every CompanyOS identifier is a string at runtime, so without branding a
 * `TaskId` is silently interchangeable with a `RoleId`. Branding makes the
 * compiler reject that class of bug, at zero runtime cost (`brand`/`unbrand`
 * are erased by the type system and are pure identity functions).
 *
 * Core-only, dependency-free (ADR-0001/ADR-0005).
 */

declare const brandSymbol: unique symbol;

/** A `T` that is only assignable when explicitly branded with `B`. */
export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

/** Brand a plain value (identity at runtime). */
export const brand = <T, B extends string>(value: T): Brand<T, B> => value as Brand<T, B>;

/** Strip the brand (identity at runtime) — used at serialization boundaries. */
export const unbrand = <T, B extends string>(value: Brand<T, B>): T => value as T;

/** Structural equality that ignores the brand. */
export const sameId = <T extends string>(left: T, right: T): boolean => left === right;
