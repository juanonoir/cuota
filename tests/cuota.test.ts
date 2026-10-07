import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, SessionCompactResult, SessionRateLimit, SessionUsage } from 'claude-code'

const MIN = 60_000
// Miércoles 7 de octubre de 2026, 14:05, hora local de quien corre el test
const NOW = new Date(2026, 9, 7, 14, 5).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

const five = (used: number, leftMin: number): SessionRateLimit => ({
  kind: 'five_hour',
  percentUsed: used,
  resetsAt: iso(NOW + leftMin * MIN),
})
const seven = (used: number): SessionRateLimit => ({
  kind: 'seven_day',
  percentUsed: used,
  resetsAt: iso(new Date(2026, 9, 10, 11, 0).getTime()),
})
const usage = (percent: number, rateLimits: SessionRateLimit[]): SessionUsage => ({
  startedAt: NOW - 72 * MIN,
  context: { tokens: percent * 2000, window: 200_000, percent },
  rateLimits,
  cost: { usd: 4.8 },
})
/** A session on a 1M-context model with `tokens` of context. */
const big = (tokens: number, rateLimits: SessionRateLimit[]): SessionUsage => ({
  startedAt: NOW - 72 * MIN,
  context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
  rateLimits,
  cost: { usd: 12.4 },
})

const SITE = { scroll: { offset: 0, bodyRows: 6 }, view: {} }
const BAND = {
  plugin: 'cuota',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 110, ...SITE },
} as const
const PANE = {
  plugin: 'cuota',
  component: 'Pane',
  requestId: 'cuota',
  props: { title: 'cuota', isFocused: true, bodyColumns: 56, placement: 'dock', ...SITE },
} as const

/** What the stand-in engine saw the mod do. */
type Seen = {
  toasts: string[]
  statuses: (string | undefined)[]
  opened: string[]
  fills: string[]
  compacted: number
  clock: MockClock
}

/**
 * Starts the session the way the engine does, with the figures `$.session.usage()` answers.
 *
 * Nothing answers beneath the plugins in a test, so this stands in for the engine on every call the mod
 * makes, once each (a test registers an event once): a `$` call answers `{ value }`, an event its result.
 */
async function start(
  $: Engine,
  on: On,
  figures: SessionUsage,
  compaction: SessionCompactResult = { skip: 'probado' },
): Promise<Seen> {
  const clock = mock.clock(on, { now: NOW })
  const seen: Seen = { toasts: [], statuses: [], opened: [], fills: [], compacted: 0, clock }
  mock.store(on)
  on('session.usage', () => ({ value: figures }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 23 }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    seen.compacted += 1
    return compaction
  })
  on('prompt.fill', ($, e) => {
    seen.fills.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  return seen
}

describe('banda', () => {
  test('en calma: la línea fija sin botones, en terminal y desktop', async ($, on) => {
    await start($, on, usage(31, [five(42, 134), seven(29)]))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ text: /OPUS/ })).toBeDefined()
      expect(await ui.find({ text: /ctx 31%/ })).toBeDefined()
      expect(await ui.find({ text: /5h 42%/ })).toBeDefined()
      expect(await ui.find({ text: /7d 29%/ })).toBeDefined()
      expect(await ui.find({ type: 'Button' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('contexto al 78 %: ofrece compactar y el botón compacta', async ($, on) => {
    const seen = await start($, on, usage(78, [five(46, 122)]))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ text: /Contexto 78 %/ })).toBeDefined()
    await ui.press({ key: 'compact' })
    expect(seen.compacted).toBe(1)
    await ui.unmount()
  })

  test('Pasar a Sonnet: si el modelo no cambió, deja /model en el prompt', async ($, on) => {
    on('command.run', { command: 'model' }, () => ({}))
    const seen = await start($, on, usage(52, [five(86, 65)]))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'downshift' })
    expect(seen.fills).toEqual(['/model sonnet'])
    await ui.unmount()
  })
})

describe('avisos', () => {
  test('5 h crítica: un solo toast aunque lleguen varias mediciones, y la línea ⚠', async ($, on) => {
    const seen = await start($, on, usage(40, [five(42, 134)]))
    expect(seen.toasts).toHaveLength(0)

    const hot = usage(52, [five(86, 65)])
    await $.session.measure({ context: hot.context, rateLimits: hot.rateLimits, changed: ['rateLimits'] })
    await $.session.measure({ context: hot.context, rateLimits: [five(87, 65)], changed: ['rateLimits'] })

    expect(seen.toasts.filter(text => text.startsWith('5 h'))).toHaveLength(1)
    expect(seen.statuses[seen.statuses.length - 1]).toContain('5 h al 87 %')
  })
})

describe('panel', () => {
  test('/cuota abre el panel con las ventanas, el ritmo y la semana', async ($, on) => {
    const seen = await start($, on, usage(52, [five(86, 65), seven(33)]))
    // As the person typing /cuota at the prompt of a 150-column fullscreen terminal
    await $.command.run({
      command: 'cuota',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 150 },
    })
    expect(seen.opened).toEqual(['cuota'])

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ text: /VENTANAS/ })).toBeDefined()
      expect(await ui.find({ text: /1,10×/ })).toBeDefined()
      expect(await ui.find({ text: /SEMANA/ })).toBeDefined()
      expect(await ui.find({ key: 'close' })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('compactación', () => {
  test('400k de contexto: la banda aconseja compactar y el botón compacta', async ($, on) => {
    const seen = await start($, on, big(400_000, [five(30, 200)]))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ text: /se paga en ~5 requests/ })).toBeDefined()
    await ui.press({ key: 'compact' })
    expect(seen.compacted).toBe(1)
    await ui.unmount()
  })

  test('Opus, 5 h crítica y 400k: compacta y después pasa a Sonnet', async ($, on) => {
    on('command.run', { command: 'model' }, () => ({}))
    const seen = await start($, on, big(400_000, [five(86, 65)]))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ text: /Compactar y pasar a Sonnet/ })).toBeDefined()
    await ui.press({ key: 'downshift' })
    expect(seen.compacted).toBe(1)
    expect(seen.fills).toEqual(['/model sonnet'])
    await ui.unmount()
  })

  test('con 104k el cambio de modelo va directo, sin compactar', async ($, on) => {
    on('command.run', { command: 'model' }, () => ({}))
    const seen = await start($, on, usage(52, [five(86, 65)]))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ text: /^Pasar a Sonnet$/ })).toBeDefined()
    await ui.press({ key: 'downshift' })
    expect(seen.compacted).toBe(0)
    await ui.unmount()
  })

  test('una hora sin respuestas: avisa que el caché está frío', async ($, on) => {
    const seen = await start($, on, big(150_000, [five(30, 200)]))
    const before = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await before.find({ text: /Caché frío/ })).toBeUndefined()
    await before.unmount()

    await seen.clock.advance(61 * MIN)
    const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await after.find({ text: /Caché frío hace 1h01/ })).toBeDefined()
    await after.unmount()
  })

  test('una compactación real calibra el tamaño del resumen', async ($, on) => {
    const summary = [{ role: 'user' as const, text: 'Resumen de la conversación hasta acá.', toolUses: [] }]
    await start($, on, big(400_000, [five(30, 200)]), {
      messages: summary,
      tokensBefore: 400_000,
      tokensAfter: 67_000,
      usage: { input_tokens: 0, output_tokens: 7_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0 },
    })
    await $.session.compact({
      trigger: 'manual',
      messages: [
        { role: 'user', text: 'Ejecutar SCAN de ApiSupport', toolUses: [] },
        { role: 'assistant', text: 'Tabla de SCAN arriba.', toolUses: [] },
      ],
    })
    await $.command.run({ command: 'cuota', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 150 } })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /COMPACTACIÓN/ })).toBeDefined()
    expect(await ui.find({ text: /resumen ~7k \(medido\)/ })).toBeDefined()
    await ui.unmount()
  })
})
