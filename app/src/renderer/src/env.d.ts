/// <reference types="vite/client" />
import type { YogurtApi } from '../../shared/types'

declare global {
  interface Window { yogurt: YogurtApi }
}
