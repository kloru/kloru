/** A value or the reason there isn't one. Expected failures are returned, not thrown. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const map = <T, U, E>(r: Result<T, E>, f: (v: T) => U): Result<U, E> => (r.ok ? ok(f(r.value)) : r);

export const andThen = <T, U, E>(r: Result<T, E>, f: (v: T) => Result<U, E>): Result<U, E> => (r.ok ? f(r.value) : r);
