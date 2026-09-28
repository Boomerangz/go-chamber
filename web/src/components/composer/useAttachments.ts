import { useCallback, useState, type ClipboardEvent, type DragEvent } from 'react'
import { uploadImage } from '../../lib/api'

interface Attachment {
  id: string
  name: string
  // session the image was uploaded to; another session shows none of it.
  session: string
}

// useAttachments uploads images picked, pasted or dropped into the composer;
// the message is sent with their ids.
export function useAttachments(sessionId: string | undefined) {
  const [all, setAll] = useState<Attachment[]>([])
  const [failure, setFailure] = useState<{ session: string; message: string } | null>(null)
  const [uploading, setUploading] = useState(0)
  const items = all.filter((a) => a.session === sessionId)

  const add = useCallback(
    async (files: Iterable<File>) => {
      if (!sessionId) return
      const images = [...files].filter((f) => f.type.startsWith('image/'))
      setFailure(null)
      setUploading((n) => n + images.length)
      for (const file of images) {
        try {
          const up = await uploadImage(sessionId, file)
          setAll((prev) => [...prev, { id: up.id, name: file.name, session: sessionId }])
        } catch (err) {
          setFailure({ session: sessionId, message: err instanceof Error ? err.message : String(err) })
        } finally {
          setUploading((n) => n - 1)
        }
      }
    },
    [sessionId],
  )

  const dropProps = {
    onPaste: (e: ClipboardEvent) => {
      if (e.clipboardData?.files?.length) void add(e.clipboardData.files)
    },
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      void add(e.dataTransfer.files)
    },
  }

  return {
    sessionId,
    items,
    ids: items.map((a) => a.id),
    error: failure && failure.session === sessionId ? failure.message : null,
    uploading: uploading > 0,
    add,
    remove: (id: string) => setAll((prev) => prev.filter((a) => a.id !== id)),
    clear: () => {
      setAll((prev) => prev.filter((a) => a.session !== sessionId))
      setFailure(null)
    },
    dropProps,
  }
}
