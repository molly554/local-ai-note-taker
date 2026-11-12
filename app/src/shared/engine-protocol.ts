/** Messages between the main process and the notes model's worker (src/engine/worker.ts) */
/** the notes model's context: what is worth asking for (an hour's meeting read whole), and the least taken */
export const CONTEXT = 32_768
export const MIN_CONTEXT = 8192

export type EngineMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type EngineRequest =
  /** contextSize: the most worth having; the worker takes what memory allows down to minContext */
  | { id: number; type: 'load'; modelPath: string; contextSize: number; minContext: number }
  | { id: number; type: 'unload' }
  /** tokens in each text, by the loaded model's tokenizer */
  | { id: number; type: 'count'; texts: string[] }
  /** thoughtBudget: thinking tokens allowed before the answer (0: none); temperature: instead of the model family's, for answers that must come out the same each time */
  | { id: number; type: 'chat'; messages: EngineMessage[]; maxTokens?: number; thoughtBudget: number; temperature?: number }
  /** read the messages in, the last one (the user's) only as far as its text goes, answering nothing */
  | { id: number; type: 'preload'; messages: EngineMessage[] }
  /** each text as a vector, by the embedding model (loaded on first use, kept beside the notes model) */
  | { id: number; type: 'embed'; modelPath: string; texts: string[] }
  | { id: number; type: 'unload-embed' }
  | { id: number; type: 'abort'; targetId: number }
  /** Windows and Linux: which graphics the engine can use, before a model is picked (a Mac never asks) */
  | { id: number; type: 'probe' }

export type EngineEvent =
  | { id: number; type: 'result'; data: unknown }
  | { id: number; type: 'token'; text: string; thought?: boolean }
  /** where a reply's time went, for the log */
  | { id: number; type: 'timing'; text: string }
  | { id: number; type: 'error'; message: string; code?: 'OOM' }
