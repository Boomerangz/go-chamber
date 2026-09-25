import type { ModelInfo, Session } from './api'

// effortsFor lists the efforts to offer: the chosen model's, or for the
// default model every effort any model accepts.
export function effortsFor(models: ModelInfo[], modelId: string): string[] {
  const chosen = models.find((m) => m.id === modelId) ?? (modelId === '' ? models.find((m) => m.default) : undefined)
  if (chosen) return chosen.efforts ?? []
  const all: string[] = []
  for (const m of models) for (const e of m.efforts ?? []) if (!all.includes(e)) all.push(e)
  return all
}

export function modelLabel(models: ModelInfo[], session: Pick<Session, 'model' | 'effort'>): string {
  const name = session.model ? models.find((m) => m.id === session.model)?.name ?? session.model : 'Default model'
  return session.effort ? `${name} · ${session.effort}` : name
}
