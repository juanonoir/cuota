// cuota: the model, the context window and the plan's 5-hour and 7-day windows, always above the prompt;
// an alert row with the action at hand when something crosses a threshold, one toast per window across
// terminals, a `⚠ cuota:` status line while something is critical, and a /cuota pane with the detail.
//
// `$` only travels into functions declared at the top of this file: the engine follows it there.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { CuotaHistory, CuotaModel, CuotaReading } from '../types'
import {
  DEFAULT_COLOR,
  DEFAULTS,
  asDay,
  bar,
  buildView,
  dayKey,
  fitPieces,
  fiveSeries,
  formatCountdown,
  formatPace,
  formatResetAt,
  formatTokens,
  glyphOf,
  heatColor,
  mergeSample,
  modelFamily,
  packCells,
  pickAlert,
  slotOf,
  spark,
  sparkChar,
  statusText,
  toneOf,
  weekGrid,
  weekKeys,
} from './math'
import type { Alert, DayRecord, Piece, Thresholds, Tone, View, WindowView } from './math'

type $ = EngineInterface

/** What the manifest's userConfig sets: the thresholds and the model the downshift button picks. */
type Config = { t: Thresholds; target: string; targetLabel: string }

const PANE = 'cuota'
const MIN = 60_000

const READING = atom({ plugin: 'cuota', key: 'reading' } as const, null)
const MODEL = atom({ plugin: 'cuota', key: 'model' } as const, null)
const TICK = atom({ plugin: 'cuota', key: 'tick' } as const, 0)
const DISMISSED = atom({ plugin: 'cuota', key: 'dismissed' } as const, [])
const TOASTED = atom({ plugin: 'cuota', key: 'toasted' } as const, [])
const BREAKDOWN = atom({ plugin: 'cuota', key: 'breakdown' } as const, null)
const HISTORY = atom({ plugin: 'cuota', key: 'history' } as const, null)
const PANE_OPEN = atom({ plugin: 'cuota', key: 'paneOpen' } as const, false)

// The last status text sent, so the clock does not resend the same line every minute
let lastStatus: string | undefined

function numberOption(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : fallback
}

function configOf(options: PluginOptions): Config {
  const target =
    typeof options.downshiftModel === 'string' && options.downshiftModel.trim() !== '' ? options.downshiftModel.trim() : 'sonnet'
  return {
    t: {
      ctxWarn: numberOption(options.ctxWarn, DEFAULTS.ctxWarn),
      ctxCrit: numberOption(options.ctxCrit, DEFAULTS.ctxCrit),
      fiveHourFloor: numberOption(options.fiveHourFloor, DEFAULTS.fiveHourFloor),
      sevenDayFloor: numberOption(options.sevenDayFloor, DEFAULTS.sevenDayFloor),
    },
    target,
    targetLabel: target.charAt(0).toUpperCase() + target.slice(1),
  }
}

/** Text props for a piece, leaving out what it does not set (the surfaces refuse undefined props). */
function textProps(piece: { tone?: Tone; bold?: boolean; dim?: boolean }) {
  return {
    ...(piece.tone !== undefined && piece.tone !== 'text' ? { color: piece.tone } : {}),
    ...(piece.bold === true ? { bold: true } : {}),
    ...(piece.dim === true ? { dimColor: true } : {}),
  }
}

// ── Figures ───────────────────────────────────────────────────────────

function fromUsage(u: SessionUsage | SessionMeasureInput, startedAt: number, now: number): CuotaReading {
  return {
    at: now,
    startedAt,
    window: u.context.window,
    ...(u.context.tokens === undefined ? {} : { tokens: u.context.tokens }),
    ...(u.context.percent === undefined ? {} : { percent: u.context.percent }),
    limits: u.rateLimits.map(l => ({
      kind: l.kind,
      percentUsed: l.percentUsed,
      ...(l.resetsAt === undefined ? {} : { resetsAt: l.resetsAt }),
    })),
    ...(u.cost === undefined ? {} : { costUsd: u.cost.usd }),
  }
}

async function nowOf($: $): Promise<number> {
  return (await read($, TICK)) || (await $.clock.now())
}

async function refreshHistory($: $) {
  const now = await nowOf($)
  const days: Record<string, DayRecord> = {}
  for (const key of weekKeys(now)) days[key] = asDay(await $.store.get(`d:${key}`))
  const { week, weekDays } = weekGrid(days, now)
  const history: CuotaHistory = { fiveSeries: fiveSeries(days, now), week, weekDays }
  await update($, HISTORY, () => history)
}

async function recordSample($: $, reading: CuotaReading, now: number) {
  const five = reading.limits.find(l => l.kind === 'five_hour')?.percentUsed ?? null
  const seven = reading.limits.find(l => l.kind === 'seven_day')?.percentUsed ?? null
  if (five === null && seven === null) return
  // Read right before writing: every session on the machine shares this key
  const key = `d:${dayKey(now)}`
  const day = asDay(await $.store.get(key))
  await $.store.set(key, mergeSample(day, slotOf(now), five, seven))
  await refreshHistory($)
}

async function pruneStore($: $, now: number) {
  const cutoff = dayKey(now - 8 * 24 * 60 * MIN)
  for (const key of await $.store.keys()) {
    if (key.startsWith('d:') && key.slice(2) < cutoff) await $.store.delete(key)
    if (key.startsWith('t:') && Number(key.split(':')[2]) * MIN < now) await $.store.delete(key)
  }
}

async function refreshBreakdown($: $) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const categories = (u.context.breakdown?.categories ?? [])
      .filter(c => !c.isDeferred && c.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 6)
      .map(c => ({ name: c.name, tokens: c.tokens }))
    await update($, BREAKDOWN, () => categories)
  } catch {
    await update($, BREAKDOWN, () => null)
  }
}

/** Reads everything again: at the session's start, after a reload, and after /clear, /resume or /branch. */
async function refresh($: $, cfg: Config) {
  const now = await $.clock.now()
  await update($, TICK, () => now)
  try {
    const u = await $.session.usage()
    const reading = fromUsage(u, u.startedAt, now)
    await update($, READING, () => reading)
    await recordSample($, reading, now)
  } catch {
    // No figures yet: the band waits for the first measurement
  }
  try {
    const main = await $.session.model()
    await update($, MODEL, prev => prev ?? { model: main, isFallback: false })
  } catch {
    // The model shows once the first request names it
  }
  await refreshHistory($)
  await evaluate($, cfg)
}

async function onMeasure($: $, cfg: Config, e: SessionMeasureInput) {
  const now = await $.clock.now()
  const prev = await read($, READING)
  const reading = fromUsage(e, prev?.startedAt ?? now, now)
  await update($, TICK, () => now)
  await update($, READING, () => reading)
  await recordSample($, reading, now)
  await evaluate($, cfg)
  if (await read($, PANE_OPEN)) await refreshBreakdown($)
}

async function onTick($: $, cfg: Config) {
  const now = await $.clock.now()
  await update($, TICK, () => now)
  await evaluate($, cfg)
}

async function onStep($: $, model: string, effort: string | number | undefined) {
  try {
    const main = await $.session.model()
    const isFallback = modelFamily(main).label !== modelFamily(model).label
    await update($, MODEL, () => ({ model, isFallback, ...(effort === undefined ? {} : { effort: String(effort) }) }))
  } catch {
    // The band keeps the last model it knew
  }
}

async function registerCommand($: $) {
  try {
    await $.command.register({
      name: 'cuota',
      description: 'Contexto, ventanas de 5 h y 7 d, ritmo y semana en un panel',
      immediate: true,
    })
  } catch {
    // A taken name leaves the band working without the command
  }
}

// ── Alerts: the ⚠ line, the toasts, the dismissals ────────────────────

function toastText(w: WindowView): string {
  const isAhead = w.isTrusted && (w.pace ?? 0) > 1 && w.etaMs !== undefined
  const left = w.leftMs === undefined ? '' : formatCountdown(w.leftMs)
  return isAhead
    ? `${w.label} al ${Math.round(w.used)} %: a este ritmo llega al 100 % en ~${formatCountdown(w.etaMs ?? 0)}, antes del reset (${left}).`
    : `${w.label} al ${Math.round(w.used)} %. El reset es en ${left}.`
}

async function evaluate($: $, cfg: Config) {
  const reading = await read($, READING)
  const view = reading === null ? null : buildView(reading, await nowOf($), cfg.t)
  const text = view === null ? undefined : statusText(view)
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
  }
  if (view === null) return

  // Context: one toast per crossing in this session, armed again once it drops 5 points under the line
  const toasted = await read($, TOASTED)
  const percent = view.context.percent ?? 0
  if (view.context.level === 'crit' && !toasted.includes('ctx')) {
    await update($, TOASTED, list => [...(list ?? []), 'ctx'])
    $.ui.toast(`Contexto al ${Math.round(percent)} %. Conviene compactar antes de que lo haga el motor.`)
  } else if (percent < cfg.t.ctxCrit - 5 && toasted.includes('ctx')) {
    await update($, TOASTED, list => (list ?? []).filter(k => k !== 'ctx'))
  }
  if (view.context.level === 'ok') await update($, DISMISSED, list => (list ?? []).filter(id => !id.startsWith('ctx:')))

  // Plan windows: one toast per window across every terminal, keyed by when it resets
  for (const w of view.windows) {
    if (w.level !== 'crit' || w.resetsAt === undefined) continue
    const key = `t:${w.kind}:${Math.round(w.resetsAt / MIN)}`
    if ((await $.store.get(key)) !== undefined) continue
    await $.store.set(key, w.resetsAt)
    $.ui.toast(toastText(w), { timeoutMs: 8000 })
  }
}

// ── Actions ───────────────────────────────────────────────────────────

async function openPane($: $) {
  await update($, PANE_OPEN, () => true)
  await refreshBreakdown($)
  await refreshHistory($)
  await $.ui.open({ id: PANE, title: 'cuota', focus: true, closeOnEscape: true })
}

async function closePane($: $) {
  await $.ui.close({ id: PANE })
}

async function compactNow($: $) {
  $.ui.toast('Compactando la conversación…')
  try {
    const result = await $.session.compact()
    if ('skip' in result && typeof result.skip === 'string') $.ui.toast(`No se compactó: ${result.skip}`)
  } catch (error) {
    $.ui.toast(`No se pudo compactar: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Switches the main model; when the engine did not take /model from a plugin, leaves it in the prompt. */
async function downshift($: $, cfg: Config) {
  try {
    await $.command.run({ command: 'model', args: cfg.target })
  } catch {
    // Checked below either way
  }
  let after = ''
  try {
    after = await $.session.model()
  } catch {
    // Treated as not switched
  }
  if (after.toLowerCase().includes(cfg.target.toLowerCase())) {
    await update($, MODEL, () => ({ model: after, isFallback: false }))
    $.ui.toast(`Modelo: ${after}`)
    return
  }
  const filled = await $.prompt.fill({ text: `/model ${cfg.target}`, mode: 'replace' })
  $.ui.toast(
    filled.isFilled ? `Dejé /model ${cfg.target} en el prompt: Enter para cambiar.` : `Escribí /model ${cfg.target} para cambiar.`,
  )
}

async function hide($: $, alert: Alert) {
  await update($, DISMISSED, list => [...(list ?? []), alert.id])
}

// ── The fixed line ────────────────────────────────────────────────────

/** The fixed line as pieces, the optional ones marked so a narrow band drops them first. */
function linePieces(view: View | null, model: CuotaModel | null, history: CuotaHistory | null, now: number): Piece[] {
  const pieces: Piece[] = []
  const sep: Piece = { text: '  ·  ', dim: true }
  if (model !== null) {
    const family = modelFamily(model.model)
    pieces.push({ text: family.label, tone: family.tone, bold: true })
    if (model.effort !== undefined) pieces.push({ text: ` ${model.effort}`, dim: true, drop: 4 })
    if (model.isFallback) pieces.push({ text: ' fallback', tone: 'warning', drop: 1 })
  }
  if (view === null) {
    if (pieces.length > 0) pieces.push(sep)
    pieces.push({ text: 'cuota · esperando la primera respuesta', dim: true })
    return pieces
  }

  if (pieces.length > 0) pieces.push(sep)
  const ctx = view.context
  if (ctx.percent === undefined) {
    pieces.push({ text: 'ctx —', dim: true })
  } else {
    const glyph = glyphOf(ctx.level)
    pieces.push({ text: `${glyph === '' ? '' : `${glyph} `}ctx ${Math.round(ctx.percent)}%`, tone: toneOf(ctx.level) })
    const b = bar(ctx.percent / 100, 10)
    pieces.push({ text: ` ${b.full}`, tone: ctx.level === 'ok' ? 'success' : toneOf(ctx.level), drop: 5 })
    pieces.push({ text: b.empty, dim: true, drop: 5 })
  }

  for (const w of view.windows) {
    pieces.push(sep)
    const glyph = glyphOf(w.level)
    pieces.push({ text: `${glyph === '' ? '' : `${glyph} `}${w.short} ${Math.round(w.used)}%`, tone: toneOf(w.level) })
    if (w.kind === 'five_hour') {
      if (w.leftMs !== undefined) pieces.push({ text: ` ↻${formatCountdown(w.leftMs)}`, dim: true, drop: 2 })
      const series = history?.fiveSeries ?? []
      if (series.filter(v => v !== null).length >= 2) pieces.push({ text: ` ${spark(series, 10)}`, dim: true, drop: 6 })
    } else if (w.resetsAt !== undefined) {
      pieces.push({ text: ` ↻${formatResetAt(w.resetsAt, now)}`, dim: true, drop: 3 })
    }
  }
  return pieces
}

// ── Hooks ─────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const cfg = configOf(options)

  on('session.start', async ($, e, next) => {
    await pruneStore($, await $.clock.now())
    await refresh($, cfg)
    $.clock.every(MIN, () => {
      void onTick($, cfg)
    })
    await registerCommand($)
    return next(e)
  })

  // /clear, /resume and /branch empty $.state and do not fire session.start again
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await refresh($, cfg)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await onMeasure($, cfg, e)
    return next(e)
  })

  // The model and effort each main-thread request really went out with, a fallback included
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await onStep($, e.model, e.effort)
    return yield* next(e)
  })

  on('command.run', { command: 'cuota' }, async $ => {
    await openPane($)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, PANE_OPEN, () => false)
    return next(e)
  })

  // The band: whatever other mods draw, the alert row when there is one, and the fixed line nearest the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const reading = await read($, READING)
    const model = await read($, MODEL)
    const history = await read($, HISTORY)
    const dismissed = await read($, DISMISSED)
    const now = await nowOf($)
    const columns = Math.max(20, e.props.bodyColumns)

    const view = reading === null ? null : buildView(reading, now, cfg.t)
    const pieces = fitPieces(linePieces(view, model, history, now), columns)
    const alert = view === null ? null : pickAlert(view, dismissed)
    const isOpus = model !== null && modelFamily(model.model).label === 'OPUS'

    let theirs = null
    try {
      theirs = await next(e)
    } catch {
      // Nothing else draws in the band
    }

    return (
      <Box flexDirection="column">
        {theirs}
        {alert !== null && (
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Text {...textProps({ tone: toneOf(alert.level) })}>
              {glyphOf(alert.level)} {alert.text}
            </Text>
            {alert.unit === 'ctx' && <Button key="compact" label="Compactar" hotkey="1" plain onPress={() => compactNow($)} />}
            {alert.unit === 'five_hour' && isOpus && (
              <Button key="downshift" label={`Pasar a ${cfg.targetLabel}`} hotkey="1" plain onPress={() => downshift($, cfg)} />
            )}
            <Button key="open" label={alert.unit === 'ctx' ? 'Desglose' : 'Ver /cuota'} hotkey="2" plain onPress={() => openPane($)} />
            <Button key="hide" label="Ocultar" hotkey="3" plain onPress={() => hide($, alert)} />
          </Box>
        )}
        <Box flexDirection="row">
          {pieces.map(piece => (
            <Text {...textProps(piece)}>{piece.text}</Text>
          ))}
        </Box>
      </Box>
    )
  })

  // The pane /cuota opens
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const reading = await read($, READING)
    const model = await read($, MODEL)
    const history = await read($, HISTORY)
    const categories = await read($, BREAKDOWN)
    const now = await nowOf($)
    const columns = Math.max(30, e.props.bodyColumns)
    const barWidth = Math.max(8, Math.min(24, columns - 26))

    if (reading === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Todavía no hay cifras: llegan con la primera respuesta del modelo.</Text>
          <Button key="close" label="Cerrar" hotkey="3" plain onPress={() => closePane($)} />
        </Box>
      )
    }

    const view = buildView(reading, now, cfg.t)
    const ctx = view.context
    const head = (title: string, right = '') => (
      <Text dimColor bold>
        {right === '' ? title : `${title.padEnd(Math.max(title.length + 1, columns - right.length))}${right}`}
      </Text>
    )

    // Context and its breakdown
    const ctxRight =
      ctx.percent === undefined
        ? 'sin lectura'
        : `${ctx.tokens === undefined ? '' : `${formatTokens(ctx.tokens)} / `}${formatTokens(ctx.window)}  ${Math.round(ctx.percent)} %`
    const ctxBar = bar((ctx.percent ?? 0) / 100, barWidth)
    const biggest = Math.max(1, ...(categories ?? []).map(c => c.tokens))

    // Pace sparkline and week heat map: Raster on the terminal, text elsewhere
    const series = history?.fiveSeries ?? []
    const week = history?.week ?? []
    const weekDays = history?.weekDays ?? []
    let paceRow = <Text dimColor>{series.some(v => v !== null) ? spark(series, 30) : 'Sin muestras todavía.'}</Text>
    let weekRows = (
      <Box flexDirection="column">
        {week.map((hours, i) => (
          <Text dimColor>{`${(weekDays[i] ?? '').padEnd(4)}${hours.map(v => (v === null ? '·' : sparkChar(v))).join('')}`}</Text>
        ))}
      </Box>
    )
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const cell = (v: number | null, char: string) => [char.codePointAt(0) ?? 0x2588, heatColor(v), DEFAULT_COLOR] as const
      if (series.some(v => v !== null)) {
        paceRow = (
          <Raster key="pace" columns={series.length} rows={1} cells={packCells(series.map(v => cell(v, v === null ? '·' : sparkChar(v))))} />
        )
      }
      if (week.length > 0) {
        weekRows = (
          <Box flexDirection="row" columnGap={1}>
            <Box flexDirection="column">
              {weekDays.map(day => (
                <Text dimColor>{day}</Text>
              ))}
            </Box>
            <Raster key="week" columns={24} rows={week.length} cells={packCells(week.flat().map(v => cell(v, v === null ? '·' : '█')))} />
          </Box>
        )
      }
    }

    const elapsed = Math.max(0, now - reading.startedAt)
    let turns = 0
    try {
      turns = await $.session.turns()
    } catch {
      // Left at zero
    }
    const isOpus = model !== null && modelFamily(model.model).label === 'OPUS'

    return (
      <Box flexDirection="column">
        {head('CONTEXTO', ctxRight)}
        <Box flexDirection="row">
          <Text {...textProps({ tone: ctx.level === 'ok' ? 'success' : toneOf(ctx.level) })}>{ctxBar.full}</Text>
          <Text dimColor>{ctxBar.empty}</Text>
        </Box>
        {(categories ?? []).map(c => (
          <Text>{`  ${c.name.slice(0, 16).padEnd(16)} ${formatTokens(c.tokens).padStart(5)}  ${bar(c.tokens / biggest, 8).full}`}</Text>
        ))}
        {categories === null && <Text dimColor> Sin desglose: lo da /context.</Text>}
        <Text> </Text>

        {head('VENTANAS DEL PLAN')}
        {view.windows.length === 0 && <Text dimColor> Sin ventanas: llegan sólo con suscripción, después de la primera respuesta.</Text>}
        {view.windows.map(w => {
          const b = bar(w.used / 100, barWidth)
          const reset =
            w.resetsAt === undefined
              ? ''
              : `↻ ${formatResetAt(w.resetsAt, now)}${w.leftMs === undefined ? '' : ` · en ${formatCountdown(w.leftMs)}`}`
          const isAhead = w.isTrusted && w.pace !== undefined && w.pace > 1 && w.etaMs !== undefined
          const pace =
            w.pace === undefined
              ? 'ritmo sin dato todavía'
              : `ritmo ${formatPace(w.pace)} · ${isAhead ? `100 % en ~${formatCountdown(w.etaMs ?? 0)}` : w.isTrusted ? 'llega al reset' : 'poca ventana para proyectar'}`
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text>{w.short.padEnd(5)}</Text>
                <Text {...textProps({ tone: w.level === 'ok' ? 'success' : toneOf(w.level) })}>{b.full}</Text>
                <Text dimColor>{b.empty}</Text>
                <Text {...textProps({ tone: toneOf(w.level) })}>{`  ${Math.round(w.used)} % ${glyphOf(w.level)}`}</Text>
              </Box>
              {reset !== '' && <Text dimColor>{`     ${reset}`}</Text>}
              <Text {...textProps({ tone: toneOf(w.level) })}>{`     ${pace}`}</Text>
            </Box>
          )
        })}
        <Text> </Text>

        {head('RITMO DE 5 H', 'hace 5 h → ahora')}
        {paceRow}
        <Text> </Text>

        {head('SEMANA', 'pico de 5 h por hora')}
        {weekRows}
        <Text dimColor>{'    0     6     12    18    23'}</Text>
        <Text> </Text>

        {head('SESIÓN')}
        <Text>{[model?.model ?? 'modelo sin dato', model?.effort, formatCountdown(elapsed), `${turns} turnos`].filter(Boolean).join(' · ')}</Text>
        {reading.costUsd !== undefined && (
          <Text dimColor>
            {`USD ${reading.costUsd.toFixed(2).replace('.', ',')} equivalente API${reading.limits.length > 0 ? ' (con suscripción no se cobra aparte)' : ''}`}
          </Text>
        )}
        <Text> </Text>
        <Box flexDirection="row" columnGap={3} flexWrap="wrap">
          <Button key="compact" label="Compactar ahora" hotkey="1" plain onPress={() => compactNow($)} />
          {isOpus && <Button key="downshift" label={`Pasar a ${cfg.targetLabel}`} hotkey="2" plain onPress={() => downshift($, cfg)} />}
          <Button key="close" label="Cerrar" hotkey="3" plain onPress={() => closePane($)} />
        </Box>
      </Box>
    )
  })
}
