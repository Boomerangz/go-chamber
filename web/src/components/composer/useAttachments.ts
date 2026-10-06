import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { uploadImage } from '../../lib/api'
import { describeError } from '../../stores/notices'
import { useDrafts, type DraftImage, type Upload, type UploadError } from '../../stores/drafts'

const none: never[] = []
let nextKey = 0

const lockedMessage = 'images go with the next message'

// useAttachments uploads images picked, pasted or dropped into the composer;
// the message is sent with their ids. What is attached to each session lives
// in the drafts store, so switching sessions keeps it. locked (a running turn
// only takes text) refuses pasted and dropped images as the Attach button does.
export function useAttachments(sessionId: string | undefined, locked = false) {
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
          drafts.startUpload(sessionId, key, file.name, file)
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

  // refuse says why pasted or dropped images were not taken.
  const refuse = () => {
    if (!sessionId) return
    useDrafts.getState().clearErrors(sessionId)
    useDrafts.getState().reject(sessionId, `u${++nextKey}`, 'images', lockedMessage)
  }

  const dropProps = {
    onPaste: (e: ClipboardEvent) => {
      if (!e.clipboardData?.files?.length) return
      // Text pasted alongside still goes into the box.
      if (locked) refuse()
      else void add(e.clipboardData.files)
    },
    onDragEnter: (e: DragEvent) => {
      if (!sessionId || locked || !hasFiles(e)) return
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
      // Taken or not, a dropped file must not open in place of the app.
      e.preventDefault()
      if (locked) refuse()
      else void add(e.dataTransfer.files)
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
    // retry uploads a failed file again.
    retry: (key: string) => {
      const failed = errors.find((e) => e.key === key)
      if (!sessionId || !failed?.file) return
      useDrafts.getState().dismissError(sessionId, key)
      void add([failed.file])
    },
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
