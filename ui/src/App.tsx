import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRight, CheckCircle2, ChevronDown, CircleAlert, CloudDownload, File, FileArchive, FileText, Folder,
  FolderOpen, HardDrive, Link2, LoaderCircle, Image, LogOut, Music, Presentation, RefreshCw, RotateCw, Sheet, Square,
  Users, Video, type LucideIcon,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  api, formatBytes, formatDate, kind, onJob, SHARED_DRIVES, SHARED_WITH_ME, timeAgo, type FailedFile, type FileEntry,
  type Folder as DriveFolder, type Job, type Session, type Shared,
} from '@/lib/downd'

const KIND_ICONS: Record<string, LucideIcon> = {
  Document: FileText, Spreadsheet: Sheet, Presentation, PDF: FileText, Image, Video, Audio: Music,
  Archive: FileArchive, File,
}

// Card tints, cycled across folders like the design's blue / purple / green.
const FOLDER_TINTS = [
  { tab: 'bg-sky-100', border: 'border-sky-100', icon: 'text-sky-500' },
  { tab: 'bg-violet-100', border: 'border-violet-100', icon: 'text-violet-500' },
  { tab: 'bg-emerald-100', border: 'border-emerald-100', icon: 'text-emerald-500' },
  { tab: 'bg-amber-100', border: 'border-amber-100', icon: 'text-amber-500' },
]

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [folders, setFolders] = useState<DriveFolder[] | null>(null)
  const [shared, setShared] = useState<Shared | null>(null)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [includeShared, setIncludeShared] = useState(() => {
    try {
      return localStorage.getItem('includeShared') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('includeShared', includeShared ? '1' : '0')
    } catch {
      // Storage unavailable: the choice just isn't remembered.
    }
  }, [includeShared])

  // A session carries the last finished run, so the tiles show its numbers until a new run starts.
  function openSession(s: Session) {
    setSession(s)
    setJob((current) => current ?? s.lastJob ?? null)
  }

  useEffect(() => onJob(setJob), [])
  useEffect(() => {
    api.then((a) => a.init()).then(openSession).catch((e) => {
      setError(errorText(e))
      setSession({ account: null, dest: '' })
    })
  }, [])
  const email = session?.account?.email
  useEffect(() => {
    if (!email) return
    setFolders(null)
    setShared(null)
    api.then((a) => a.folders()).then(setFolders).catch((e) => setError(errorText(e)))
    api.then((a) => a.shared()).then(setShared).catch((e) => setError(errorText(e)))
  }, [email])

  // Files a download would cover, counted on open and whenever "Include shared files" changes.
  const [driveCount, setDriveCount] = useState<number | null>(null)
  useEffect(() => {
    if (!email) return
    let live = true
    setDriveCount(null)
    api.then((a) => a.count(includeShared))
      .then((n) => live && setDriveCount(n))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [email, includeShared])

  // Runs one bridge call, showing `label` while it is in flight and any error after.
  async function call<T>(label: string, fn: (a: Awaited<typeof api>) => Promise<T>) {
    setPending(label)
    setError('')
    try {
      return await fn(await api)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPending('')
    }
  }

  if (!session) {
    return <div className="grid h-screen place-items-center text-muted-foreground">Loading…</div>
  }
  if (!session.account) {
    return (
      <LoginScreen
        waiting={pending === 'login'}
        error={error}
        onLogin={() => call('login', (a) => a.login()).then((s) => s && openSession(s))}
      />
    )
  }

  const account = session.account
  const running = job?.phase === 'scanning' || job?.phase === 'downloading'
  const logout = () => call('logout', (a) => a.logout()).then((s) => {
    if (!s) return
    setSession(s)
    setJob(null)
    setFolders(null)
    setShared(null)
  })
  const openFolder = (...parts: string[]) => call('open', (a) => a.open_folder(parts)).then((opened) => {
    if (opened === false) setError('That folder has not been downloaded yet.')
  })
  const retry = (ids?: string[]) => call('retry', (a) => a.retry(ids))
  const countOf = (...parts: string[]) => job?.folderCounts[parts.join('\\')]
  const sharedNote = includeShared ? '' : ' · not included in downloads'

  return (
    <div className="flex h-screen bg-white">
      <aside className="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto border-r px-6 py-5">
        <Logo />
        <div className="rounded-3xl border p-4">
          <Button
            className="h-11 rounded-xl bg-brand px-5 text-base font-semibold text-primary hover:bg-brand/80"
            onClick={() => openFolder()}
          >
            <FolderOpen className="size-5" /> Open folder
          </Button>
          <div className="my-3 border-t" />
          <div className="grid grid-cols-2 gap-3">
            <StatTile active icon={HardDrive} tint="text-sky-700" label="My Drive" className="col-span-2"
              value={running ? job.files : driveCount} />
            {/* Downloaded is a result: it shows once the run is over, not while it climbs. */}
            <StatTile icon={CheckCircle2} tint="text-emerald-500" label="Downloaded"
              value={running ? null : job?.counts.downloaded ?? 0} />
            <StatTile icon={RefreshCw} tint="text-violet-500" label="Up to date"
              value={job?.counts.skipped ?? 0} />
            <StatTile icon={Link2} tint="text-sky-500" label="Saved as link"
              value={job?.counts.linked ?? 0} />
            <StatTile icon={CircleAlert} tint="text-rose-500" label="Failed"
              value={job?.counts.failed ?? 0} />
          </div>
        </div>
        <StorageCard usage={account.usage} limit={account.limit} />
        <ActivityCard job={job} />
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto px-8 pb-10">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-6 border-b bg-white py-5">
          <div className="flex min-w-0 max-w-xl flex-1 items-center gap-3 rounded-2xl bg-muted/70 py-2 pr-2 pl-4">
            <Folder className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={session.dest}>
              {session.dest}
            </span>
            <Button variant="outline" size="sm" className="rounded-lg bg-white" disabled={running}
              onClick={() => call('folder', (a) => a.choose_folder()).then((dest) => {
                if (dest) setSession({ ...session, dest })
              })}>
              Change
            </Button>
          </div>
          <AccountMenu account={account} onOpen={() => openFolder()} onLogout={logout} />
        </header>

        {error && (
          <div role="alert" className="mt-6 flex items-center gap-2 rounded-2xl bg-rose-50 px-5 py-3 text-sm text-rose-700">
            <CircleAlert className="size-4 shrink-0" /> {error}
          </div>
        )}

        <Hero
          job={job}
          running={running}
          includeShared={includeShared}
          onIncludeShared={setIncludeShared}
          onStart={() => call('start', (a) => a.start(includeShared))}
          onStop={() => call('stop', (a) => a.stop())}
        />

        {job?.failedFiles?.length ? (
          <FailedFiles files={job.failedFiles} running={running} onRetry={retry} />
        ) : null}

        <SectionTitle title="Folders" note={folders ? `${folders.length} in My Drive` : 'Loading…'} />
        {folders && folders.length === 0 && <Empty>No folders in My Drive.</Empty>}
        <CardRow>
          {folders?.map((folder, i) => (
            <FolderCard key={folder.id} name={folder.name} tint={i}
              detail={<>Last edited <span className="text-muted-foreground">{timeAgo(folder.modifiedTime)}</span></>}
              count={countOf(folder.name)} onOpen={() => openFolder(folder.name)} />
          ))}
        </CardRow>

        <SectionTitle title="Shared with me" note={shared
          ? `${shared.folders.length} folders · ${shared.files} files${sharedNote}` : 'Loading…'} />
        {shared && shared.folders.length === 0 && (
          <Empty>
            {shared.files
              ? `No shared folders. The ${shared.files} files shared with you are saved straight into "${SHARED_WITH_ME}".`
              : 'Nothing has been shared with you.'}
          </Empty>
        )}
        <CardRow>
          {shared?.folders.map((folder, i) => (
            <FolderCard key={folder.id} name={folder.name} tint={i + 1} icon={Users}
              detail={folder.sharedBy
                ? <>Shared by <span className="text-muted-foreground">{folder.sharedBy}</span></>
                : <>Last edited <span className="text-muted-foreground">{timeAgo(folder.modifiedTime)}</span></>}
              count={countOf(SHARED_WITH_ME, folder.name)} onOpen={() => openFolder(SHARED_WITH_ME, folder.name)} />
          ))}
        </CardRow>

        <SectionTitle title="Shared drives" note={shared ? `${shared.drives.length} drives${sharedNote}` : 'Loading…'} />
        {shared && shared.drives.length === 0 && <Empty>You are not a member of any shared drive.</Empty>}
        <CardRow>
          {shared?.drives.map((d, i) => (
            <FolderCard key={d.id} name={d.name} tint={i + 2} icon={HardDrive}
              detail={<span className="text-muted-foreground">Shared drive</span>}
              count={countOf(SHARED_DRIVES, d.name)} onOpen={() => openFolder(SHARED_DRIVES, d.name)} />
          ))}
        </CardRow>

        <SectionTitle title="Recent files" note={job ? `${job.index} of ${job.total} checked` : ''} />
        <RecentFiles job={job} />
      </main>
    </div>
  )
}

function Logo() {
  return (
    <div className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
      <span className="grid size-9 place-items-center rounded-xl bg-primary text-brand">
        <CloudDownload className="size-5" strokeWidth={2.5} />
      </span>
      downD
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  )
}

function LoginScreen({ waiting, error, onLogin }: { waiting: boolean; error: string; onLogin: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-muted/60 p-6">
      <div className="relative w-full max-w-lg overflow-hidden rounded-[2rem] border bg-white p-10 shadow-xl shadow-primary/5">
        <CloudGlow className="-top-24 -right-24 size-80" />
        <div className="relative">
          <Logo />
          <h1 className="mt-10 text-4xl font-bold tracking-tight">Your whole Google Drive, on your PC.</h1>
          <p className="mt-4 text-muted-foreground">
            Log in, pick a folder, and download every file and folder in one click. downD only reads your
            Drive; it never changes or deletes anything.
          </p>
          <Button className="mt-8 h-12 w-full rounded-xl text-base font-semibold" disabled={waiting} onClick={onLogin}>
            <span className="grid size-7 place-items-center rounded-full bg-white"><GoogleIcon /></span>
            {waiting ? 'Waiting for Google in your browser…' : 'Login with Google'}
          </Button>
          {error && <p role="alert" className="mt-4 text-sm text-rose-600">{error}</p>}
          <p className="mt-6 text-xs text-muted-foreground">
            If Google says the app is not verified, choose Advanced, then Go to downD.
          </p>
        </div>
      </div>
    </div>
  )
}

function CloudGlow({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn(
      'pointer-events-none absolute rounded-full bg-[radial-gradient(circle,var(--color-sky-300)_0%,var(--color-cyan-200)_40%,transparent_70%)] opacity-70 blur-2xl',
      className,
    )} />
  )
}

function StatTile({ icon: Icon, label, value, tint, active, className }: {
  icon: LucideIcon; label: string; value: number | null; tint: string; active?: boolean; className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-2xl border p-3', active && 'border-sky-200 bg-sky-200/70', className)}>
      <div className="flex items-center gap-2">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-full', active ? 'bg-white/70' : 'bg-muted')}>
          <Icon className={cn('size-3.5', tint)} />
        </span>
        {value === null ? (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Working…" />
        ) : (
          <span className="truncate font-semibold tabular-nums">{value.toLocaleString()}</span>
        )}
      </div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function StorageCard({ usage, limit }: { usage: number; limit: number | null }) {
  return (
    <div className="rounded-2xl bg-muted/70 p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold"><HardDrive className="size-5" /> Storage</span>
        <span className="text-xs text-muted-foreground">
          {formatBytes(usage)}{limit ? ` of ${formatBytes(limit)}` : ' used'}
        </span>
      </div>
      {limit && (
        <Progress value={(usage / limit) * 100} className="mt-4 h-1.5 bg-white"
          aria-label="Google Drive storage used" />
      )}
    </div>
  )
}

function ActivityCard({ job }: { job: Job | null }) {
  const files = [...(job?.current ? [job.current] : []), ...(job?.recent ?? [])].slice(0, 3)
  const percent = job?.total ? Math.floor((job.index / job.total) * 100) : 0
  const title = !job ? 'Activity'
    : job.phase === 'scanning' ? 'Scanning Drive'
    : job.phase === 'downloading' ? 'Downloading'
    : job.phase === 'error' ? 'Stopped by an error'
    : 'Last download'
  const detail = !job ? 'Nothing downloaded yet'
    : job.phase === 'scanning' ? `${job.found.toLocaleString()} items found`
    : `${job.index.toLocaleString()} of ${job.total.toLocaleString()} items`
  return (
    <div className="rounded-2xl border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{title}</span>
        {job?.phase === 'downloading' && <span className="text-sm font-semibold tabular-nums">{percent}%</span>}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{detail}</div>
      {job && job.phase !== 'scanning' && (
        <Progress value={percent} className="mt-3 h-1.5" aria-label="Overall progress" />
      )}
      {files.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2.5 border-t pt-3">
          {files.map((file, i) => {
            const Icon = KIND_ICONS[kind(file.mimeType)]
            const current = i === 0 && job?.current === file
            return (
              <li key={file.path + i} className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                  <Icon className="size-4 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium" title={file.path}>{file.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {file.error ?? (file.size ? formatBytes(file.size) : kind(file.mimeType))}
                  </div>
                </div>
                {current ? (
                  <span className="text-xs text-muted-foreground tabular-nums">{Math.round((file.progress ?? 0) * 100)}%</span>
                ) : file.result === 'failed' ? (
                  <CircleAlert className="size-4 shrink-0 text-rose-500" aria-label="Failed" />
                ) : file.result === 'linked' ? (
                  <Link2 className="size-4 shrink-0 text-sky-500" aria-label="Saved as link" />
                ) : (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-label="Downloaded" />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function AccountMenu({ account, onOpen, onLogout }: {
  account: NonNullable<Session['account']>; onOpen: () => void; onLogout: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-12 gap-3 rounded-2xl px-2">
          <Avatar className="size-10">
            {account.photo && <AvatarImage src={account.photo} alt="" />}
            <AvatarFallback>{account.name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="text-lg font-semibold">{account.name}</span>
          <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal text-muted-foreground">{account.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpen}><FolderOpen /> Open download folder</DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogout}><LogOut /> Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Hero({ job, running, includeShared, onIncludeShared, onStart, onStop }: {
  job: Job | null; running: boolean; includeShared: boolean; onIncludeShared: (on: boolean) => void
  onStart: () => void; onStop: () => void
}) {
  const percent = job && job.total ? (job.index / job.total) * 100 : 0
  return (
    <section className="relative mt-6 overflow-hidden rounded-3xl border p-8">
      <CloudGlow className="top-1/2 right-0 h-96 w-[34rem] -translate-y-1/2 translate-x-1/4" />
      <div className="absolute top-1/2 right-16 hidden -translate-y-1/2 lg:block" aria-hidden="true">
        <div className="grid size-36 rotate-6 place-items-center rounded-[2rem] bg-white shadow-2xl shadow-sky-500/30">
          <CloudDownload className="size-20 text-primary" strokeWidth={1.5} />
        </div>
        <div className="absolute -bottom-4 -left-10 grid size-14 -rotate-12 place-items-center rounded-2xl bg-brand shadow-lg">
          <FileText className="size-7 text-primary" />
        </div>
        <div className="absolute -top-5 -left-6 grid size-11 rotate-12 place-items-center rounded-xl bg-amber-300 shadow-lg">
          <Image className="size-5 text-primary" />
        </div>
      </div>
      <div className="relative max-w-lg">
        <h1 className="text-3xl font-bold tracking-tight">Back up your whole Drive</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Every folder and file in My Drive, saved to this PC. Google Docs, Sheets and Slides are saved as Word,
          Excel and PowerPoint files. Run it again any time: only new and changed files are downloaded.
        </p>
        <div className="mt-6 flex items-center gap-4">
          {running ? (
            <Button variant="outline" className="h-12 rounded-xl bg-white px-6 text-base font-semibold" onClick={onStop}>
              <Square className="fill-current" /> Stop
            </Button>
          ) : (
            <Button className="h-12 rounded-xl px-6 text-base font-semibold" onClick={onStart}>
              <CloudDownload className="size-5" /> Download all
            </Button>
          )}
          {job && <span className="text-sm text-muted-foreground" role="status">{job.message}</span>}
        </div>
        <label className="mt-5 flex w-fit cursor-pointer items-center gap-3 text-sm has-disabled:cursor-default has-disabled:opacity-60">
          <Switch checked={includeShared} onCheckedChange={onIncludeShared} disabled={running} />
          <span>
            <span className="font-medium">Include shared files</span>
            <span className="block text-xs text-muted-foreground">
              "Shared with me" and Shared drives, saved in their own folders
            </span>
          </span>
        </label>
        {job?.phase === 'downloading' && (
          <div className="mt-5">
            <Progress value={percent} className="h-2" aria-label="Overall progress" />
            <div className="mt-2 text-xs text-muted-foreground tabular-nums">
              {job.index.toLocaleString()} of {job.total.toLocaleString()} items · {Math.floor(percent)}%
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function SectionTitle({ title, note, children }: { title: string; note: string; children?: ReactNode }) {
  return (
    <div className="mt-10 mb-5 flex items-center justify-between gap-4">
      <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">{note}</span>
        {children}
      </div>
    </div>
  )
}

function CardRow({ children }: { children: ReactNode }) {
  return <div className="grid auto-cols-[300px] grid-flow-col gap-5 overflow-x-auto pb-2">{children}</div>
}

function FailedFiles({ files, running, onRetry }: {
  files: FailedFile[]; running: boolean; onRetry: (ids?: string[]) => void
}) {
  return (
    <section aria-labelledby="failed-title">
      <SectionTitle title="Failed files" note={`${files.length} could not be downloaded`}>
        <Button className="rounded-xl" disabled={running} onClick={() => onRetry()}>
          <RotateCw /> Retry all
        </Button>
      </SectionTitle>
      <div className="flex flex-col gap-3">
        {files.map((file) => {
          const Icon = KIND_ICONS[kind(file.mimeType)]
          return (
            <div key={file.item.id} className="flex items-center gap-5 rounded-2xl border border-rose-100 bg-rose-50/40 px-5 py-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-rose-100 text-rose-600">
                <Icon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold" title={file.path}>{file.name}</div>
                <div className="truncate text-xs text-rose-700" title={file.error}>{file.error}</div>
              </div>
              <div className="hidden min-w-0 max-w-64 truncate text-sm text-muted-foreground lg:block" title={file.path}>
                {file.path}
              </div>
              <Button variant="outline" className="shrink-0 rounded-xl bg-white" disabled={running}
                onClick={() => onRetry([file.item.id])} aria-label={`Retry ${file.name}`}>
                <RotateCw /> Retry
              </Button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>
}

function FolderCard({ name, detail, tint: index, icon: Icon = Folder, count, onOpen }: {
  name: string; detail: ReactNode; tint: number; icon?: LucideIcon; count?: number; onOpen: () => void
}) {
  const tint = FOLDER_TINTS[index % FOLDER_TINTS.length]
  return (
    <div className={cn('flex flex-col rounded-3xl border-2 bg-white', tint.border)}>
      <div className="flex items-start justify-between">
        <div className={cn('flex min-w-0 items-center gap-2 rounded-tl-[1.3rem] rounded-br-2xl px-4 py-3 font-semibold', tint.tab)}>
          <Icon className="size-5 shrink-0" />
          <span className="truncate" title={name}>{name}</span>
        </div>
        <span className="shrink-0 px-4 py-3.5 text-xs text-muted-foreground">
          {count === undefined ? '' : `${count.toLocaleString()} files`}
        </span>
      </div>
      <span className={cn('mt-2 mr-5 grid size-16 rotate-6 place-items-center self-end rounded-2xl shadow-sm', tint.tab)}>
        <FolderOpen className={cn('size-8', tint.icon)} aria-hidden="true" />
      </span>
      <div className="flex flex-1 items-end justify-between gap-3 px-4 pt-3 pb-4">
        <div className="min-w-0 truncate text-xs">{detail}</div>
        <Button variant="outline" size="icon" className="shrink-0 rounded-full" onClick={onOpen}
          aria-label={`Open ${name} in Explorer`}>
          <ArrowRight />
        </Button>
      </div>
    </div>
  )
}

function RecentFiles({ job }: { job: Job | null }) {
  const rows: FileEntry[] = [...(job?.current ? [job.current] : []), ...(job?.recent ?? [])]
  if (rows.length === 0) return <Empty>Files you download show up here.</Empty>
  return (
    <div className="flex flex-col gap-3">
      {rows.map((file, i) => {
        const active = i === 0 && job?.current === file
        const Icon = KIND_ICONS[kind(file.mimeType)]
        return (
          <div key={file.path + i} className={cn(
            'flex items-center gap-5 rounded-2xl border px-5 py-4',
            active && 'border-primary bg-primary text-primary-foreground',
          )}>
            <span className={cn('grid size-11 shrink-0 place-items-center rounded-full',
              active ? 'bg-white/10' : 'bg-violet-100 text-violet-600')}>
              <Icon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold" title={file.path}>{file.name}</div>
              <div className={cn('truncate text-xs', active ? 'text-white/60' : 'text-muted-foreground')}>
                {file.error ?? kind(file.mimeType)}
              </div>
            </div>
            <div className="w-24 shrink-0 text-sm tabular-nums">{file.size ? formatBytes(file.size) : '—'}</div>
            <div className="hidden w-44 shrink-0 text-sm xl:block">{formatDate(file.modifiedTime)}</div>
            <div className="w-28 shrink-0 text-right">
              {active ? (
                <span className="text-sm tabular-nums">{Math.round((file.progress ?? 0) * 100)}%</span>
              ) : file.result === 'failed' ? (
                <Badge variant="destructive">Failed</Badge>
              ) : file.result === 'linked' ? (
                <Badge variant="secondary" className="bg-sky-50 text-sky-700"
                  title="Google could not convert this file, so a shortcut that opens it in the browser was saved">
                  Saved as link
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-emerald-50 text-emerald-700">Downloaded</Badge>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
