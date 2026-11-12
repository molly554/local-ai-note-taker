import { createLlm } from './llm'
import { createHandler } from './handler'
import type { EngineRequest } from '../shared/engine-protocol'

/** The notes model's process: requests from the main process (src/main/engine.ts) */
const handle = createHandler(createLlm(), (e) => process.parentPort.postMessage(e))
process.parentPort.on('message', ({ data }: { data: EngineRequest }) => { void handle(data) })
