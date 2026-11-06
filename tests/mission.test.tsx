import { expect, test } from 'claude-code/testing'

const wrap = (o: unknown) => ({ value: { content: [{ type: 'text', text: 'Untrusted\n<x>\n' + JSON.stringify(o) + '\n</x>' }], isError: false } })
const now = Date.now()
const threads = {
  sessions: [
    { thread_id: 't1', title: 'Fix Safari export', state: 'blocked', last_activity_at: new Date(now - 120000).toISOString() },
    { thread_id: 't2', title: 'Build sidebar', state: 'working', last_activity_at: new Date(now - 30000).toISOString() },
    { thread_id: 't3', title: 'Old deck', state: 'done', last_activity_at: new Date(now - 86400000).toISOString() },
  ],
}
const thread = {
  messages: [
    { author: 'agent', body: JSON.stringify({ kind: 'status', text: 'Plan\n\n✓ One\n✱ Two things\n○ Three' }) },
    { author: 'agent', body: 'PR is up: https://github.com/a/b/pull/12' },
  ],
}

const PANE = { plugin: 'mission-control', component: 'Pane', requestId: 'mission-control', props: { title: 'Mission control', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const

function engine(on: any) {
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.now() }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1, percent: 62 }, rateLimits: [{ kind: 'five_hour', percentUsed: 81, resetsAt: new Date(now + 3600000).toISOString() }, { kind: 'seven_day', percentUsed: 30 }] } }))
  on('mcp.call', (_: any, e: any) => (e.tool === 'list_threads' ? wrap(threads) : wrap(thread)))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
}

test('pane shows the waiting thread, steps and a pull request', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 100))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /need.* your answer/ }))?.text).toBe('1 thread needs your answer')
  expect((await ui.find({ type: 'Text', text: /open thread/ }))?.text).toBe('2 open threads')
  expect((await ui.find({ type: 'Text', text: /^Step/ }))?.text).toBe('Step 2 of 3: Two things')
  expect((await ui.find({ type: 'Text', text: /pull request/ }))?.text).toContain('🔀')
  await ui.unmount()
})

test('usage band shows percent, countdown and the save button', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 100))
  const ui = await $.ui.mount({ plugin: 'mission-control', component: 'AbovePrompt', props: {}, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /^81%$/ }))?.text).toBe('81%')
  expect((await ui.find({ type: 'Text', text: /resets in/ }))?.text).toMatch(/resets in (59m|1h 0m)/)
  expect(await ui.find({ type: 'Button', key: 'save-usage' })).toBeTruthy()
  await ui.unmount()
})
