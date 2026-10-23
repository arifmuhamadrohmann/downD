// Bridge to the Python side (app.py). pywebview injects window.pywebview.api.

export type Account = { name: string; email: string; photo: string | null; usage: number; limit: number | null }
export type Session = { account: Account | null; dest: string; lastJob?: Job | null }
export type Folder = { id: string; name: string; modifiedTime: string; sharedBy?: string | null }
export type Shared = { folders: Folder[]; files: number; drives: { id: string; name: string }[] }
export type FailedFile = FileEntry & { error: string; item: { id: string } }

// Local folder names downD uses for shared items (app.py / drive.py).
export const SHARED_WITH_ME = 'Shared with me'
export const SHARED_DRIVES = 'Shared drives'
export type FileEntry = {
  name: string
  path: string
  mimeType: string
  size: number
  modifiedTime: string
  progress?: number
  result?: 'downloaded' | 'linked' | 'failed'
  error?: string
}
export type Job = {
  phase: 'scanning' | 'downloading' | 'done' | 'stopped' | 'error'
  message: string
  found: number // files and folders
  files: number // files only, comparable with counts
  total: number
  index: number
  counts: { downloaded: number; skipped: number; linked?: number; failed: number }
  current: FileEntry | null
  recent: FileEntry[]
  failedFiles?: FailedFile[]
  folderCounts: Record<string, number> // keyed by local path, e.g. "Work" or "Shared with me\Team"
}

type Api = {
  init(): Promise<Session>
  login(): Promise<Session>
  logout(): Promise<Session>
  choose_folder(): Promise<string>
  open_folder(parts?: string[]): Promise<boolean>
  folders(): Promise<Folder[]>
  shared(): Promise<Shared>
  start(includeShared: boolean): Promise<void>
  retry(ids?: string[]): Promise<void>
  stop(): Promise<void>
  count(includeShared: boolean): Promise<number | null>
}

declare global {
  interface Window {
    pywebview?: { api: Api }
  }
}

export const api: Promise<Api> = new Promise((resolve) => {
  if (window.pywebview?.api) resolve(window.pywebview.api)
  else window.addEventListener('pywebviewready', () => resolve(window.pywebview!.api), { once: true })
})

export function onJob(listener: (job: Job) => void) {
  const handler = (e: Event) => listener((e as CustomEvent<Job>).detail)
  window.addEventListener('downd', handler)
  return () => window.removeEventListener('downd', handler)
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })

export function timeAgo(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60],
  ]
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

// Friendly label for a Drive MIME type.
export function kind(mime: string) {
  if (mime.includes('google-apps.document') || mime.includes('wordprocessing')) return 'Document'
  if (mime.includes('google-apps.spreadsheet') || mime.includes('spreadsheet')) return 'Spreadsheet'
  if (mime.includes('google-apps.presentation') || mime.includes('presentation')) return 'Presentation'
  if (mime === 'application/pdf') return 'PDF'
  const [type] = mime.split('/')
  if (type === 'image') return 'Image'
  if (type === 'video') return 'Video'
  if (type === 'audio') return 'Audio'
  if (mime.includes('zip') || mime.includes('compressed')) return 'Archive'
  return 'File'
}
