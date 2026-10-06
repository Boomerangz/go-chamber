import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { uploadImage } from '../../lib/api'
import { describeError } from '../../stores/notices'
import { useDrafts, type DraftImage, type Upload, type UploadError } from '../../stores/drafts'

const none: never[] = []
let nextKey = 0

// useAttachments uploads images picked, pasted or dropped into the composer;
// the message is sent with their ids. What is attached to each session lives
// in the drafts store, so switching sessions keeps it.
export function useAttachments(sessionId: string | undefined) {
  const items: DraftImage[] = useDrafts((s) => (sessionId && s.images[sessionId]) || none)
  const uploads: Upload[] = useDrafts((s) => (sessionId && s.uploads[sessionId]) || none)
  const errors: UploadError[] = useDrafts((s) => (sessionId && s.errors[sessionId]) || none)
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child crossed; count to know when the
  // pointer really left.
  const depth = useRef(0)

  const add = useCallback(
    async (files: Iterable<File>) => {
      if (!sessionId) return
      const drafts = useDrafts.getState()
      drafts.clearErrors(sessionId)
      const queue: { key: string; file: File }[] = []
      for (const file of files) {
        const key = `u${++nextKey}`
        if (file.type.startsWith('image/')) {
          queue.push({ key, file })
          drafts.startUpload(sessionId, key, file.name)
        } else {
          drafts.reject(sessionId, key, file.name, `only images can be attached: ${file.name}`)
        }
      }
      for (const { key, file } of queue) {
        try {
          const up = await uploadImage(sessionId, file)
          useDrafts.getState().finishUpload(sessionId, key)
          useDrafts.getState().addImage(sessionId, { id: up.id, name: file.name })
        } catch (err) {
          useDrafts.getState().failUpload(sessionId, key, describeError(err))
        }
      }
    },
    [sessionId],
  )

  const dropProps = {
    onPaste: (e: ClipboardEvent) => {
      if (e.clipboardData?.files?.length) void add(e.clipboardData.files)
    },
    onDragEnter: (e: DragEvent) => {
      if (!sessionId || !hasFiles(e)) return
      depth.current++
      setDragging(true)
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    },
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDrop: (e: DragEvent) => {
      depth.current = 0
      setDragging(false)
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      void add(e.dataTransfer.files)
    },
  }

  return {
    sessionId,
    items,
    ids: items.map((a) => a.id),
    uploads,
    errors,
    uploading: uploads.length > 0,
    dragging,
    add,
    remove: (id: string) => sessionId && useDrafts.getState().removeImage(sessionId, id),
    dismiss: (key: string) => sessionId && useDrafts.getState().dismissError(sessionId, key),
    clear: () => {
      if (!sessionId) return
      useDrafts.getState().clearImages(sessionId)
      useDrafts.getState().clearErrors(sessionId)
    },
    dropProps,
  }
}

function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  return !types || Array.from(types).includes('Files')
}
