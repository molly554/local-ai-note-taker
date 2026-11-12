// For search.bench.mjs only: the Store's code needs the project's test runner to load (see README.md).
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default { root: dirname(fileURLToPath(import.meta.url)), test: { include: ['search.bench.mjs'], globals: true, testTimeout: 900_000 } }
