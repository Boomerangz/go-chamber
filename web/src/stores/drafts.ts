import { create } from 'zustand'

// Drafts keep what the owner was writing to each session: the text survives
// switching sessions and reloads (per browser), uploaded images survive
// switching sessions for the life of the page.

const KEY = 'gc.draft:'

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(KEY + sessionId) ?? ''
  } catch {
    return ''
  }
}

export function saveDraft(sessionId: string, text: string): void {
  try {
    if (text) localStorage.setItem(KEY + sessionId, text)
    else localStorage.removeItem(KEY + sessionId)
  } catch {
    // Storage may be blocked; the draft then lives only on screen.
  }
}

export function clearDraft(sessionId: string): void {
  saveDraft(sessionId, '')
}

export interface DraftImage {
  id: string
  name: string
}

// Upload is one file on its way to the server; key tells same-named files
// apart. The file stays for a preview and to try again if it fails.
export interface Upload {
  key: string
  name: string
  file?: File
}

export interface UploadError extends Upload {
  message: string
}

interface DraftStore {
  images: Record<string, DraftImage[]>
  uploads: Record<string, Upload[]>
  errors: Record<string, UploadError[]>
  addImage: (session: string, image: DraftImage) => void
  removeImage: (session: string, id: string) => void
  clearImages: (session: string) => void
  startUpload: (session: string, key: string, name: string, file?: File) => void
  finishUpload: (session: string, key: string) => void
  failUpload: (session: string, key: string, message: string) => void
  reject: (session: string, key: string, name: string, message: string, file?: File) => void
  dismissError: (session: string, key: string) => void
  clearErrors: (session: string) => void
}

// put sets one session's list, dropping the entry when it empties.
function put<T>(map: Record<string, T[]>, session: string, list: T[]): Record<string, T[]> {
  const next = { ...map }
  if (list.length) next[session] = list
  else delete next[session]
  return next
}

export const useDrafts = create<DraftStore>((set, get) => ({
  images: {},
  uploads: {},
  errors: {},
  addImage: (session, image) =>
    set({ images: put(get().images, session, [...(get().images[session] ?? []), image]) }),
  removeImage: (session, id) =>
    set({ images: put(get().images, session, (get().images[session] ?? []).filter((i) => i.id !== id)) }),
  clearImages: (session) => set({ images: put(get().images, session, []) }),
  startUpload: (session, key, name, file) =>
    set({ uploads: put(get().uploads, session, [...(get().uploads[session] ?? []), { key, name, file }]) }),
  finishUpload: (session, key) =>
    set({ uploads: put(get().uploads, session, (get().uploads[session] ?? []).filter((u) => u.key !== key)) }),
  failUpload: (session, key, message) => {
    const upload = get().uploads[session]?.find((u) => u.key === key)
    get().finishUpload(session, key)
    if (upload) get().reject(session, key, upload.name, message, upload.file)
  },
  reject: (session, key, name, message, file) =>
    set({ errors: put(get().errors, session, [...(get().errors[session] ?? []), { key, name, message, file }]) }),
  dismissError: (session, key) =>
    set({ errors: put(get().errors, session, (get().errors[session] ?? []).filter((e) => e.key !== key)) }),
  clearErrors: (session) => set({ errors: put(get().errors, session, []) }),
}))

// resetDrafts empties the in-memory drafts; used by tests.
export function resetDrafts(): void {
  useDrafts.setState({ images: {}, uploads: {}, errors: {} })
}
