import { validateCatalog, type Catalog } from '@yogurt/picker'

/**
 * The catalog that shipped with this build. Nothing is fetched at launch: nothing leaves the Mac except the update
 * check, so new models arrive with an app update.
 */
export function loadCatalog(opts: { bundled: unknown; licenses: string[] }): Catalog {
  const r = validateCatalog(opts.bundled, opts.licenses)
  if (!r.ok) throw new Error('Bundled catalog is invalid: ' + r.errors.join('; '))
  return r.catalog
}
