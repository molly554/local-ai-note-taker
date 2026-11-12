/**
 * What the windows send is checked before it is used: a page should never be able to make main throw, or reach a
 * file outside a meeting's folder, by sending something odd.
 */

/** a meeting id (a UUID): letters, digits and dashes only, so it is always safe in a path */
export const isId = (x: unknown): x is string => typeof x === 'string' && /^[\w-]{1,64}$/.test(x)

/** text from a page, at most `max` characters; anything that isn't text is undefined */
export const text = (x: unknown, max: number): string | undefined => (typeof x === 'string' ? x.slice(0, max) : undefined)
