import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Board, Limit, Sample, Thread, ThreadState } from '../types'

const P = 'mission-control'
const PANE = 'mission-control'
const PANE_TITLE = 'Mission control'

const board = atom({ plugin: 'mission-control', key: 'board' } as const, { threads: [], fetchedAt: 0 } as Board, { shape: 'board-1' })
const limits = atom({ plugin: 'mission-control', key: 'limits' } as const, [] as Limit[], { shape: 'limits-1' })
const samples = atom({ plugin: 'mission-control', key: 'samples' } as const, {} as Record<string, Sample[]>, { shape: 'samples-1' })
const view = atom({ plugin: 'mission-control', key: 'view' } as const, 'tree' as 'tree' | 'map')
const showTips = atom({ plugin: 'mission-control', key: 'showTips' } as const, false)
const nowAtom = atom({ plugin: 'mission-control', key: 'now' } as const, 0)
const contextPct = atom({ plugin: 'mission-control', key: 'contextPct' } as const, 0)

// One colour per state, used everywhere (cards, badges, map, usage bars).
const COLOR: Record<ThreadState, string> = {
  'needs-you': '#f59e0b',
  working: '#22c55e',
  idle: '#9ca3af',
  done: '#3b82f6',
  failed: '#ef4444',
}
const LABEL: Record<ThreadState, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  done: 'Done',
  failed: 'Failed',
}
const ORDER: ThreadState[] = ['needs-you', 'failed', 'working', 'idle', 'done']
const IDLE_AFTER_MS = 20 * 60_000
const MADE_ICON: Record<string, string> = { app: '🧩 app', deck: '📊 deck', doc: '📄 doc', pr: '🔀 pull request' }

// ---------- reading the project's threads ----------

function jsonIn(text: string): any {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

async function callHearth($: any, tool: string, args: Record<string, unknown>): Promise<any> {
  const r = await $.mcp.call('hearthbot', tool, args)
  const text = (r.content ?? []).map((b: any) => b.text ?? '').join('\n')
  if (r.isError) throw new Error(text.slice(0, 200) || 'error')
  return jsonIn(text)
}

function stateOf(raw: string, lastActivity: number, now: number): ThreadState {
  if (raw === 'blocked' || raw === 'review_ready') return 'needs-you'
  if (raw === 'failed') return 'failed'
  if (raw === 'done') return 'done'
  if (raw === 'stopped') return 'idle'
  if (raw === 'working' && now - lastActivity > IDLE_AFTER_MS) return 'idle'
  return raw === 'working' ? 'working' : 'idle'
}

type Detail = { at: number; step?: string; stepsDone?: number; stepsTotal?: number; made: string[] }
const details = new Map<string, Detail>()

function readDetail(messages: any[]): Detail {
  const d: Detail = { at: 0, made: [] }
  const made = new Set<string>()
  for (const m of messages) {
    const body = typeof m.body === 'string' ? m.body : ''
    if (d.stepsTotal === undefined && m.author === 'agent' && body.startsWith('{')) {
      const j = jsonIn(body)
      if (j?.kind === 'status' && typeof j.text === 'string') {
        const lines = j.text.split('\n').map((l: string) => l.trim())
        const steps = lines.filter((l: string) => /^[✓✱○]/.test(l))
        if (steps.length) {
          d.stepsTotal = steps.length
          d.stepsDone = steps.filter((l: string) => l.startsWith('✓')).length
          const current = steps.find((l: string) => l.startsWith('✱')) ?? steps.find((l: string) => l.startsWith('○'))
          d.step = (current ?? steps[steps.length - 1]).slice(1).trim()
        }
      }
    }
    const all = JSON.stringify(m)
    if (/github\.com\/[^\s"]+\/pull\/\d+/.test(all)) made.add('pr')
    if (/\.pptx|\bdeck\b|slides/i.test(all) && m.author === 'agent' && /attached|artifact|\/mnt\/project-files/.test(all)) made.add('deck')
    if (/\.(md|docx|pdf)\b|Claude Doc/i.test(all) && /attached_outputs|\/mnt\/project-files|\/artifact\//.test(all)) made.add('doc')
    if (/claude\.ai\/(code\/)?artifact\//.test(all) || /"kind":"frame"/.test(all)) made.add('app')
  }
  d.made = [...made]
  return d
}

async function refreshThreads($: any): Promise<void> {
  const now = await $.clock.now()
  try {
    const list = await callHearth($, 'list_threads', { limit: 50 })
    const rows: any[] = list?.sessions ?? list?.threads ?? []
    const threads: Thread[] = []
    for (const row of rows) {
      const id = String(row.thread_id ?? row.id ?? '')
      if (!id) continue
      const lastActivity = Date.parse(row.last_activity_at ?? row.created_at ?? '') || now
      let d = details.get(id)
      if (!d || d.at !== lastActivity) {
        try {
          const t = await callHearth($, 'read_thread', { thread_id: id, limit: 25, order: 'newest_first' })
          d = { ...readDetail(t?.messages ?? []), at: lastActivity }
          details.set(id, d)
        } catch {
          d = d ?? { at: 0, made: [] }
        }
      }
      const raw = String(row.state ?? row.status_bucket ?? 'working')
      threads.push({
        id,
        title: String(row.title ?? 'Untitled thread'),
        rawState: raw,
        state: stateOf(raw, lastActivity, now),
        lastActivity,
        step: d.step,
        stepsDone: d.stepsDone,
        stepsTotal: d.stepsTotal,
        made: d.made,
      })
    }
    await update($, board, () => ({ threads, fetchedAt: now }))
  } catch (err: any) {
    await update($, board, b => ({ ...b, fetchedAt: now, error: String(err?.message ?? err).slice(0, 160) }))
  }
}

// ---------- usage ----------

async function takeLimits($: any, rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) {
  if (!rateLimits?.length) return
  const now = await $.clock.now()
  const next: Limit[] = rateLimits.map(r => ({
    kind: r.kind,
    pct: r.percentUsed,
    resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : undefined,
  }))
  await update($, limits, () => next)
  await update($, samples, all => {
    const out: Record<string, Sample[]> = { ...all }
    for (const l of next) {
      let list = (out[l.kind] ?? []).filter(s => now - s.t < 6 * 3600_000)
      // A drop means the window reset: start the history again.
      const prev = list[list.length - 1]
      if (prev && l.pct < prev.pct - 1) list = []
      list = [...list, { t: now, pct: l.pct }].slice(-300)
      out[l.kind] = list
    }
    return out
  })
}

// Forecast: the pace over the last hour (at least 5 minutes of history).
function forecast(l: Limit, hist: Sample[], now: number): { text: string; isBad: boolean } | undefined {
  const recent = hist.filter(s => now - s.t <= 3600_000)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || recent.length < 2) return undefined
  const span = last.t - first.t
  if (span < 5 * 60_000) return undefined
  const rate = (last.pct - first.pct) / span
  if (rate <= 0) return { text: 'Usage is flat right now, no limit in sight', isBad: false }
  const hitAt = now + (100 - l.pct) / rate
  if (l.resetsAt && hitAt >= l.resetsAt) return { text: 'At this pace you stay under the limit until it resets', isBad: false }
  return { text: `At this pace you'll hit the limit in about ${span2(hitAt - now)}`, isBad: true }
}

// Times are shown as 'in 2h 10m' rather than a clock time: the mod runs on a
// computer in the cloud and can't tell what time zone you are in.
function span2(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

function clockTime(t: number, now: number): string {
  const d = new Date(t)
  let h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'pm' : 'am'
  h = h % 12 || 12
  const time = `${h}:${String(m).padStart(2, '0')}${ampm}`
  const days = Math.floor((t - now) / 86400_000)
  if (days >= 1) return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${time}`
  return time
}

function countdown(ms: number): string {
  if (ms <= 0) return 'resetting now'
  const mins = Math.round(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d) return `resets in ${d}d ${h}h`
  if (h) return `resets in ${h}h ${m}m`
  return `resets in ${m}m`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const usageColor = (pct: number) => (pct >= 75 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#22c55e')
const kindName = (k: string) => (k === 'five_hour' ? '5-hour window' : k === 'seven_day' ? 'This week' : k === 'spend_limit' ? 'Spend limit' : k)

// ---------- little drawings ----------

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function barSvg(pct: number, color: string, w = 160, h = 8): string {
  const fill = Math.max(0, Math.min(100, pct)) / 100 * w
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="${h / 2}" fill="#9ca3af" fill-opacity="0.25"/><rect width="${fill}" height="${h}" rx="${h / 2}" fill="${color}"/></svg>`
}

function dotSvg(color: string, isPulsing: boolean): string {
  const pulse = isPulsing
    ? `<circle cx="8" cy="8" r="4" fill="${color}" fill-opacity="0.5"><animate attributeName="r" values="4;8;4" dur="1.4s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values="0.6;0;0.6" dur="1.4s" repeatCount="indefinite"/></circle>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${pulse}<circle cx="8" cy="8" r="4" fill="${color}"/></svg>`
}

function mapSvg(threads: Thread[]): { svg: string; height: number } {
  const W = 300
  const perRow = 3
  const rows = Math.max(1, Math.ceil(threads.length / perRow))
  const H = 70 + rows * 78
  const rootX = W / 2
  const rootY = 26
  let parts = `<rect x="${rootX - 70}" y="${rootY - 16}" width="140" height="32" rx="16" fill="#6366f1"/><text x="${rootX}" y="${rootY + 5}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="#ffffff">Project chat</text>`
  threads.forEach((t, i) => {
    const row = Math.floor(i / perRow)
    const inRow = Math.min(perRow, threads.length - row * perRow)
    const col = i % perRow
    const x = (W / (inRow + 1)) * (col + 1)
    const y = 92 + row * 78
    const c = COLOR[t.state]
    const name = t.title.length > 16 ? t.title.slice(0, 15) + '…' : t.title
    parts =
      `<path d="M${rootX} ${rootY + 16} C ${rootX} ${y - 30}, ${x} ${rootY + 40}, ${x} ${y - 14}" stroke="${c}" stroke-opacity="0.6" stroke-width="2" fill="none"/>` +
      parts +
      (t.state === 'needs-you'
        ? `<circle cx="${x}" cy="${y}" r="14" fill="${c}" fill-opacity="0.4"><animate attributeName="r" values="14;22;14" dur="1.4s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values="0.5;0;0.5" dur="1.4s" repeatCount="indefinite"/></circle>`
        : '') +
      `<circle cx="${x}" cy="${y}" r="14" fill="${c}"><title>${esc(t.title)} · ${LABEL[t.state]}</title></circle>` +
      `<text x="${x}" y="${y + 30}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#8b8b95">${esc(name)}</text>`
  })
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts}</svg>`, height: H }
}

const sorted = (threads: Thread[]) =>
  [...threads].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.lastActivity - a.lastActivity)

// ---------- the mod ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mission-control', description: 'Open the Mission control threads panel' })
    void $.ui.open({ id: PANE, title: PANE_TITLE })
    await update($, nowAtom, () => Date.now())
    void refreshThreads($)
    $.clock.every(45_000, () => refreshThreads($))
    $.clock.every(30_000, async () => update($, nowAtom, () => Date.now()))
    try {
      const u = await $.session.usage()
      await takeLimits($, u.rateLimits)
      if (u.context?.percent !== undefined) await update($, contextPct, () => u.context.percent ?? 0)
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'mission-control' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE })
    void refreshThreads($)
    return { text: 'Mission control is open.' }
  })

  on('session.measure', async ($, e, next) => {
    await takeLimits($, e.rateLimits)
    if (e.context?.percent !== undefined) await update($, contextPct, () => e.context.percent ?? 0)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refreshThreads($)
    return next(e)
  })

  // ----- the threads panel -----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as any
    const b = await read($, board)
    const mode = await read($, view)
    const now = Math.max(await read($, nowAtom), b.fetchedAt)
    const threads = sorted(b.threads)
    const open = threads.filter(t => t.state !== 'done' && t.state !== 'failed').length
    const waiting = threads.filter(t => t.state === 'needs-you')

    const header = (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="heading" weight="bold">
            {open} open {open === 1 ? 'thread' : 'threads'}
          </Text>
          <Box flexDirection="row" gap="xs">
            <Button key="view-tree" label={mode === 'tree' ? '● List' : 'List'} onPress={() => update($, view, () => 'tree')} />
            <Button key="view-map" label={mode === 'map' ? '● Map' : 'Map'} onPress={() => update($, view, () => 'map')} />
          </Box>
        </Box>
        {waiting.length > 0 ? (
          <Box flexDirection="row" alignItems="center" gap="xs" paddingX="sm" paddingY="xs" backgroundColor="#f59e0b33" borderStyle="round" borderColor="#f59e0b">
            <Svg source={dotSvg(COLOR['needs-you'], true)} alt="pulsing amber dot" width={16} height={16} />
            <Text weight="bold" color="#b45309">
              {waiting.length} {waiting.length === 1 ? 'thread needs' : 'threads need'} your answer
            </Text>
          </Box>
        ) : (
          <Text color="#16a34a">Nothing is waiting on you right now</Text>
        )}
      </Box>
    )

    const card = (t: Thread) => {
      const c = COLOR[t.state]
      const pct = t.stepsTotal ? Math.round(((t.stepsDone ?? 0) / t.stepsTotal) * 100) : undefined
      return (
        <Box key={`card-${t.id}`} flexDirection="column" gap="xs" padding="sm" borderStyle="round" borderColor={c} backgroundColor={t.state === 'needs-you' ? '#f59e0b1f' : undefined}>
          <Box flexDirection="row" alignItems="center" gap="xs">
            <Svg source={dotSvg(c, t.state === 'needs-you')} alt={LABEL[t.state]} width={16} height={16} />
            <Text weight="semibold" wrap="truncate-end">{t.title}</Text>
          </Box>
          <Box flexDirection="row" gap="sm">
            <Text color={c} weight="bold" size="footnote">{LABEL[t.state].toUpperCase()}</Text>
            <Text dimColor size="footnote">{ago(now - t.lastActivity)}</Text>
          </Box>
          {t.step && (
            <Box flexDirection="column" gap="xs">
              <Text size="footnote" wrap="truncate-end">
                Step {Math.min((t.stepsDone ?? 0) + (t.state === 'done' ? 0 : 1), t.stepsTotal ?? 1)} of {t.stepsTotal}: {t.step}
              </Text>
              <Svg source={barSvg(pct ?? 0, c, 200, 6)} alt={`${pct}% of steps done`} width={200} height={6} />
            </Box>
          )}
          {t.made.length > 0 && (
            <Text dimColor size="caption">Made: {t.made.map(m => MADE_ICON[m] ?? m).join('  ')}</Text>
          )}
        </Box>
      )
    }

    let body
    if (b.threads.length === 0) {
      body = (
        <Text dimColor>
          {!b.fetchedAt
            ? 'Loading your threads…'
            : b.error
              ? /not (found|connected)|unknown server|no such server|hearthbot/i.test(b.error)
                ? 'Thread tracking works when you open this inside a Claude project thread. The usage strip above the chat box still works here.'
                : `Couldn't read your threads just now. I'll try again in a moment. (${b.error})`
              : 'No threads in this project yet.'}
        </Text>
      )
    } else if (mode === 'map') {
      const { svg, height } = mapSvg(threads.filter(t => t.state !== 'done').slice(0, 15))
      body = (
        <Box flexDirection="column" gap="sm">
          <Svg source={svg} alt="Map of threads hanging off the project chat" width={300} height={height} isInteractive />
          <Text dimColor size="caption">Every thread is started from the project chat, so they all hang off it. Finished threads are hidden here.</Text>
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column" gap="sm">
          <Text dimColor size="footnote">📁 Project chat</Text>
          <Box flexDirection="column" gap="sm" paddingLeft="md" borderStyle="single" borderColor="#9ca3af66">
            {threads.map(card)}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="md" padding="sm">
        {header}
        {body}
        <Text dimColor size="caption">
          Checks for changes every 45 seconds{b.fetchedAt ? `, last checked ${ago(now - b.fetchedAt)}` : ''}.
        </Text>
      </Box>
    )
  })

  // ----- the usage band above the chat box -----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e as any).props?.hasSurvey) return next(e)
    const { Box, Text, Button, Svg } = $.ui.resolve(e) as any
    const ls = await read($, limits)
    const hist = await read($, samples)
    const now = Math.max(await read($, nowAtom), Date.now())
    const tips = await read($, showTips)
    const b = await read($, board)
    const ctx = await read($, contextPct)
    const waiting = b.threads.filter(t => t.state === 'needs-you').length
    const high = ls.some(l => l.pct >= 60)

    const rows = ls
      .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day' || l.kind === 'spend_limit')
      .map(l => {
        const c = usageColor(l.pct)
        const f = forecast(l, hist[l.kind] ?? [], now)
        return (
          <Box key={`use-${l.kind}`} flexDirection="row" alignItems="center" gap="sm" flexWrap="wrap">
            <Text weight="semibold" size="footnote">{kindName(l.kind)}</Text>
            <Svg source={barSvg(l.pct, c, 140, 8)} alt={`${l.pct}% used`} width={140} height={8} />
            <Text color={c} weight="bold" tabular size="footnote">{Math.round(l.pct)}%</Text>
            {l.resetsAt && <Text dimColor size="footnote">{countdown(l.resetsAt - now)}</Text>}
            {f && (
              <Text size="footnote" color={f.isBad ? '#ef4444' : undefined} dimColor={!f.isBad}>
                · {f.text} (estimate)
              </Text>
            )}
          </Box>
        )
      })

    const idle = b.threads.filter(t => t.state === 'idle').map(t => t.title)
    const done = b.threads.filter(t => t.state === 'done' || t.state === 'needs-you' && t.rawState === 'review_ready').length

    return (
      <Box flexDirection="column" gap="xs" paddingX="sm" paddingY="xs" borderStyle="round" borderColor={ls.some(l => l.pct >= 75) ? '#ef4444' : '#9ca3af55'}>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap="sm">
          <Box flexDirection="column" gap="xs">
            {rows.length ? rows : <Text dimColor size="footnote">Your usage figures appear here after Claude's next reply.</Text>}
          </Box>
          <Box flexDirection="row" gap="xs">
            {(high || tips) && (
              <Button key="save-usage" label={tips ? 'Hide tips' : '💡 Help me save usage'} onPress={() => update($, showTips, v => !v)} />
            )}
            <Button key="open-pane" label={waiting ? `🟠 Threads (${waiting} need you)` : 'Threads'} onPress={() => $.ui.open({ id: PANE, title: PANE_TITLE })} />
          </Box>
        </Box>
        {tips && (
          <Box flexDirection="column" gap="xs" paddingTop="xs">
            <Text weight="semibold" size="footnote">Ways to make your usage last longer:</Text>
            <Text size="footnote">• Lower the effort level for simple jobs like small text changes or quick questions.</Text>
            <Text size="footnote">• Switch to a smaller, cheaper model (Sonnet or Haiku) for routine tasks; keep Opus for hard problems.</Text>
            {idle.length > 0 && <Text size="footnote">• Leave idle threads alone or finish them off: {idle.slice(0, 3).join(', ')}{idle.length > 3 ? '…' : ''}.</Text>}
            {done > 0 && <Text size="footnote">• Wrap up the {done} {done === 1 ? 'thread' : 'threads'} ready for review so they stop being picked back up.</Text>}
            {ctx >= 50 && <Text size="footnote">• This chat is {ctx}% full. Long chats cost more per reply; starting a fresh thread for the next task is cheaper.</Text>}
            <Text size="footnote">• Ask for one bigger change at a time instead of many small back-and-forths.</Text>
          </Box>
        )}
      </Box>
    )
  })
}
