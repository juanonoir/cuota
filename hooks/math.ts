// Pure arithmetic and formatting for cuota: no `$`, no clock, no store.
// Every figure the band and the pane draw goes through here, so it is tested on its own.

import type { CuotaLimit, CuotaReading } from '../types'

export type Level = 'ok' | 'warn' | 'crit'
export type Tone = 'error' | 'warning' | 'success' | 'text'

export type Thresholds = {
  ctxWarn: number
  ctxCrit: number
  fiveHourFloor: number
  sevenDayFloor: number
}

export const DEFAULTS: Thresholds = { ctxWarn: 70, ctxCrit: 90, fiveHourFloor: 80, sevenDayFloor: 90 }

const MIN = 60_000
const HOUR = 60 * MIN

/** How long each plan window lasts; a kind not listed here has no pace. */
export const WINDOW_MS: Readonly<Record<string, number>> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }

export const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const

// ── Levels ────────────────────────────────────────────────────────────

export function contextLevel(percent: number | undefined, t: Thresholds): Level {
  if (percent === undefined) return 'ok'
  if (percent >= t.ctxCrit) return 'crit'
  if (percent >= t.ctxWarn) return 'warn'
  return 'ok'
}

export type WindowView = {
  kind: string
  label: string
  short: string
  used: number
  resetsAt?: number
  leftMs?: number
  /** Fraction of the window already gone, 0 to 1. */
  elapsed?: number
  /** Used over elapsed: above 1 the window runs out before it resets. */
  pace?: number
  /** Time to 100 % at the window's average rate so far. */
  etaMs?: number
  /** Whether enough of the window has passed for the pace to mean something. */
  isTrusted: boolean
  level: Level
}

export function windowLabel(kind: string): string {
  return kind === 'five_hour' ? '5 h' : kind === 'seven_day' ? '7 d' : kind
}

export function windowShort(kind: string): string {
  return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind
}

function floorOf(kind: string, t: Thresholds): number {
  return kind === 'five_hour' ? t.fiveHourFloor : t.sevenDayFloor
}

export function windowView(limit: CuotaLimit, now: number, t: Thresholds): WindowView {
  const used = limit.percentUsed
  const base = { kind: limit.kind, label: windowLabel(limit.kind), short: windowShort(limit.kind), used }
  const resetsAt = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  const floorLevel: Level = used >= floorOf(limit.kind, t) ? 'crit' : 'ok'

  if (Number.isNaN(resetsAt)) return { ...base, isTrusted: false, level: floorLevel }

  const leftMs = Math.max(0, resetsAt - now)
  if (leftMs === 0) return { ...base, resetsAt, leftMs, isTrusted: false, level: 'ok' }

  const total = WINDOW_MS[limit.kind]
  if (total === undefined) return { ...base, resetsAt, leftMs, isTrusted: false, level: floorLevel }

  const gone = Math.max(0, total - leftMs)
  const elapsed = gone / total
  const isTrusted = elapsed >= 0.2 || used >= 40
  if (gone === 0 || used <= 0) return { ...base, resetsAt, leftMs, elapsed, isTrusted, level: floorLevel }

  const pace = used / 100 / elapsed
  const etaMs = (100 - used) / (used / gone)
  const isAhead = isTrusted && pace > 1
  const level: Level = floorLevel === 'crit' || (isAhead && used >= 50) ? 'crit' : isAhead ? 'warn' : 'ok'

  return { ...base, resetsAt, leftMs, elapsed, pace, etaMs, isTrusted, level }
}

// ── Formatting ────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0')

export function formatCountdown(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MIN))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${pad2(minutes % 60)}`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function formatResetAt(at: number, now: number): string {
  const when = new Date(at)
  const clock = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`
  return dayKey(at) === dayKey(now) ? clock : `${WEEKDAYS[when.getDay()]} ${clock}`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')}M`
}

export function formatPace(pace: number): string {
  return `${pace.toFixed(2).replace('.', ',')}×`
}

export function modelFamily(model: string): { label: string; tone: Tone } {
  if (/opus/i.test(model)) return { label: 'OPUS', tone: 'error' }
  if (/sonnet/i.test(model)) return { label: 'Sonnet', tone: 'warning' }
  if (/haiku/i.test(model)) return { label: 'Haiku', tone: 'success' }
  return { label: model.replace(/^claude-/, '').replace(/\[.*\]$/, ''), tone: 'text' }
}

export function toneOf(level: Level): Tone {
  return level === 'crit' ? 'error' : level === 'warn' ? 'warning' : 'text'
}

export function glyphOf(level: Level): string {
  return level === 'crit' ? '■' : level === 'warn' ? '▲' : ''
}

// ── Bars and sparklines ───────────────────────────────────────────────

const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export function bar(fraction: number, width: number): { full: string; empty: string } {
  const cells = Math.max(0, Math.min(1, fraction)) * width
  const whole = Math.floor(cells)
  const eighths = Math.round((cells - whole) * 8)
  let full = '█'.repeat(whole)
  let used = whole
  if (eighths >= 8) {
    full += '█'
    used += 1
  } else if (eighths > 0) {
    full += EIGHTHS[eighths - 1]
    used += 1
  }
  return { full, empty: '░'.repeat(Math.max(0, width - used)) }
}

export function sparkChar(value: number): string {
  return SPARKS[Math.max(0, Math.min(7, Math.floor((value / 100) * 8)))] ?? '█'
}

/** Folds the values into at most `width` cells, each the peak of its group; a gap is a space. */
export function spark(values: readonly (number | null)[], width: number): string {
  const groups = Math.min(width, values.length)
  let out = ''
  for (let i = 0; i < groups; i++) {
    const from = Math.floor((i * values.length) / groups)
    const to = Math.floor(((i + 1) * values.length) / groups)
    const peak = peakOf(values.slice(from, to))
    out += peak === null ? ' ' : sparkChar(peak)
  }
  return out
}

function peakOf(values: readonly (number | null)[]): number | null {
  let peak: number | null = null
  for (const v of values) if (v !== null && (peak === null || v > peak)) peak = v
  return peak
}

/** A run of text the band draws; `drop` above 0 marks it optional, the highest dropped first. */
export type Piece = { text: string; tone?: Tone; bold?: boolean; dim?: boolean; drop?: number }

export function widthOf(pieces: readonly Piece[]): number {
  return pieces.reduce((n, p) => n + [...p.text].length, 0)
}

export function fitPieces(pieces: readonly Piece[], columns: number): Piece[] {
  let kept = [...pieces]
  while (widthOf(kept) > columns) {
    const top = Math.max(0, ...kept.map(p => p.drop ?? 0))
    if (top === 0) break
    kept = kept.filter(p => (p.drop ?? 0) !== top)
  }
  return kept
}

// ── The view the band and the pane draw ───────────────────────────────

export type View = {
  context: { percent?: number; tokens?: number; window: number; level: Level }
  windows: WindowView[]
  worst: Level
}

const RANK: Record<Level, number> = { ok: 0, warn: 1, crit: 2 }

export function buildView(reading: CuotaReading, now: number, t: Thresholds): View {
  const context = { percent: reading.percent, tokens: reading.tokens, window: reading.window, level: contextLevel(reading.percent, t) }
  const windows = reading.limits.map(limit => windowView(limit, now, t))
  const worst = [context.level, ...windows.map(w => w.level)].reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok')
  return { context, windows, worst }
}

export type Alert = { id: string; unit: string; level: Level; text: string }

function windowAlertText(w: WindowView): string {
  const reset = w.leftMs === undefined ? '' : `el reset es en ${formatCountdown(w.leftMs)}`
  const isAhead = w.isTrusted && w.pace !== undefined && w.pace > 1 && w.etaMs !== undefined
  if (w.level === 'warn' && isAhead) {
    return `${w.label} por encima del ritmo parejo (${formatPace(w.pace ?? 0)}) · 100 % en ~${formatCountdown(w.etaMs ?? 0)}; ${reset}`
  }
  if (isAhead) return `${w.label} al ${Math.round(w.used)} % · a este ritmo llega al 100 % en ~${formatCountdown(w.etaMs ?? 0)}; ${reset}`
  return reset ? `${w.label} al ${Math.round(w.used)} % · ${reset}` : `${w.label} al ${Math.round(w.used)} %`
}

function contextAlertText(view: View): string {
  const { percent = 0, tokens, window } = view.context
  const size = tokens === undefined ? '' : ` · ${formatTokens(tokens)} de ${formatTokens(window)}`
  return `Contexto ${Math.round(percent)} %${size} · el motor autocompacta antes del 100 %`
}

const UNIT_ORDER = ['five_hour', 'ctx', 'compact', 'seven_day']

/**
 * The one alert the band shows: the worst level first, then 5 h, context, compaction, 7 d; dismissed ids skipped.
 * `extras` are alerts worked out outside the view (the compaction advice).
 */
export function pickAlert(view: View, dismissed: readonly string[], extras: readonly Alert[] = []): Alert | null {
  const candidates: Alert[] = [...extras]
  if (view.context.level !== 'ok') {
    candidates.push({ id: `ctx:${view.context.level}`, unit: 'ctx', level: view.context.level, text: contextAlertText(view) })
  }
  for (const w of view.windows) {
    if (w.level === 'ok') continue
    candidates.push({ id: `${w.kind}:${w.level}:${w.resetsAt ?? ''}`, unit: w.kind, level: w.level, text: windowAlertText(w) })
  }
  const order = (unit: string) => (UNIT_ORDER.indexOf(unit) + UNIT_ORDER.length + 1) % (UNIT_ORDER.length + 1)
  const open = candidates
    .filter(a => !dismissed.includes(a.id))
    .sort((a, b) => RANK[b.level] - RANK[a.level] || order(a.unit) - order(b.unit))
  return open[0] ?? null
}

/** The `$.ui.status` text while something is critical; the engine draws it after `⚠ cuota:`. */
export function statusText(view: View): string | undefined {
  const parts: string[] = []
  if (view.context.level === 'crit') parts.push(`contexto ${Math.round(view.context.percent ?? 0)} %`)
  for (const w of view.windows) {
    if (w.level !== 'crit') continue
    const isAhead = w.isTrusted && w.pace !== undefined && w.pace > 1 && w.etaMs !== undefined
    const tail = w.leftMs === undefined
      ? ''
      : isAhead
        ? ` · 100 % en ~${formatCountdown(w.etaMs ?? 0)}, reset en ${formatCountdown(w.leftMs)}`
        : ` · reset en ${formatCountdown(w.leftMs)}`
    parts.push(`${w.label} al ${Math.round(w.used)} %${tail}`)
  }
  return parts.length === 0 ? undefined : parts.join('  ·  ')
}

// ── Compaction: when it pays for itself ───────────────────────────────

/** US$ per million tokens: base input and cache read. Output costs 5× input and a cache write 1.25× (5 min) or 2× (1 h). */
export type Pricing = { input: number; read: number }

export const OUTPUT_RATIO = 5
/** Below this much context left over after compacting, the advice stays quiet. */
export const MIN_SAVING_TOKENS = 30_000
/** The fixed part of the context (system prompt, tools, MCP, memory) never counts above this. */
export const BASE_CAP = 60_000
export const DEFAULT_SUMMARY_TOKENS = 10_000
export const DEFAULT_STEPS_PER_TURN = 3

const HOUR_MS = 60 * MIN

/** Anthropic's list prices (claude-api reference, 2026-09-25) by model family; unknown models price as Opus 5. */
export function pricingOf(model: string): Pricing {
  if (/(fable|mythos)[^0-9]*5[-.]1/i.test(model)) return { input: 10, read: 0.25 }
  if (/fable|mythos/i.test(model)) return { input: 10, read: 1 }
  if (/opus[^0-9]*5[-.]5/i.test(model)) return { input: 4, read: 0.2 }
  if (/opus/i.test(model)) return { input: 5, read: 0.5 }
  if (/sonnet[^0-9]*4[-.]6/i.test(model)) return { input: 3, read: 0.3 }
  if (/sonnet/i.test(model)) return { input: 2, read: 0.2 }
  if (/haiku/i.test(model)) return { input: 1, read: 0.1 }
  return { input: 5, read: 0.5 }
}

export type Payback = { costUsd: number; savingUsd: number; requests: number }

/**
 * Compacting reads the context once from the cache, writes a summary as output and caches it;
 * afterwards every request re-sends the summary instead of the messages it replaced.
 */
export function compactPayback(contextTokens: number, messagesTokens: number, summaryTokens: number, pricing: Pricing, writeRatio: number): Payback {
  const perToken = pricing.input / 1e6
  const readPerToken = pricing.read / 1e6
  const costUsd = readPerToken * contextTokens + (OUTPUT_RATIO + writeRatio) * perToken * summaryTokens
  const savingUsd = readPerToken * Math.max(0, messagesTokens - summaryTokens)
  return { costUsd, savingUsd, requests: savingUsd > 0 ? costUsd / savingUsd : Number.POSITIVE_INFINITY }
}

export type CompactAdvice = {
  /** `payback`: it pays back within a few turns; `cold`: the cache expired, so the next request re-caches everything anyway. */
  reason: 'payback' | 'cold'
  requests: number
  savingUsd: number
  rewriteUsd: number
  contextTokens: number
  idleMs: number
}

export type CompactAdviceInput = {
  contextTokens?: number
  baseTokens?: number
  summaryTokens: number
  stepsPerTurn: number
  model: string
  idleMs: number
  ttlMs: number
  paybackTurns: number
}

export function compactAdvice(input: CompactAdviceInput): CompactAdvice | null {
  const context = input.contextTokens
  if (context === undefined) return null
  const base = Math.min(input.baseTokens ?? BASE_CAP, BASE_CAP)
  const messages = Math.max(0, context - base)
  if (messages - input.summaryTokens < MIN_SAVING_TOKENS) return null

  const pricing = pricingOf(input.model)
  const writeRatio = input.ttlMs >= HOUR_MS ? 2 : 1.25
  const payback = compactPayback(context, messages, input.summaryTokens, pricing, writeRatio)
  const advice = {
    requests: payback.requests,
    savingUsd: payback.savingUsd,
    rewriteUsd: (writeRatio * pricing.input * context) / 1e6,
    contextTokens: context,
    idleMs: input.idleMs,
  }
  if (input.idleMs > input.ttlMs) return { reason: 'cold', ...advice }
  if (payback.requests <= input.paybackTurns * Math.max(1, input.stepsPerTurn)) return { reason: 'payback', ...advice }
  return null
}

export function compactAlertText(advice: CompactAdvice): string {
  if (advice.reason === 'cold') {
    return `Caché frío hace ${formatCountdown(advice.idleMs)} · seguir reescribe ${formatTokens(advice.contextTokens)} (~${formatUsd(advice.rewriteUsd)}); compactar antes ahorra ~${formatUsd(advice.savingUsd)} por request`
  }
  return `Compactar se paga en ~${Math.round(advice.requests)} requests · ahorra ~${formatUsd(advice.savingUsd)} por request con ${formatTokens(advice.contextTokens)} de contexto`
}

/** The band's alert for the advice; its id changes with each idle stretch or each 50k of context, so a dismissal lasts until then. */
export function compactAlert(advice: CompactAdvice, lastResponseAt: number): Alert {
  const key = advice.reason === 'cold' ? String(lastResponseAt) : String(Math.floor(advice.contextTokens / 50_000))
  return { id: `compact:${advice.reason}:${key}`, unit: 'compact', level: 'warn', text: compactAlertText(advice) }
}

/**
 * Switching model forfeits the prompt cache (it is per model), so the new model re-caches the whole context.
 * Compacting first means it re-caches only the base and the summary.
 */
export function downshiftPlan(
  contextTokens: number,
  baseTokens: number,
  summaryTokens: number,
  from: Pricing,
  to: Pricing,
  writeRatio: number,
): { directUsd: number; compactFirstUsd: number; isCompactFirst: boolean } {
  const directUsd = (writeRatio * to.input * contextTokens) / 1e6
  const compactFirstUsd =
    (from.read * contextTokens + OUTPUT_RATIO * from.input * summaryTokens + writeRatio * to.input * (baseTokens + summaryTokens)) / 1e6
  return { directUsd, compactFirstUsd, isCompactFirst: compactFirstUsd < directUsd }
}

/** Requests per turn as a running average, the latest turn weighing 30 %. */
export function nextStepsPerTurn(previous: number, steps: number): number {
  return previous <= 0 ? steps : 0.7 * previous + 0.3 * steps
}

/** A summary size learned from real compactions, the latest weighing 40 %. */
export function nextSummaryTokens(previous: number, sample: number, isCalibrated: boolean): number {
  return isCalibrated ? 0.6 * previous + 0.4 * sample : sample
}

export function formatUsd(usd: number): string {
  return usd < 0.005 ? '<US$0,01' : `US$${usd.toFixed(2).replace('.', ',')}`
}

// ── History kept in $.store ───────────────────────────────────────────

/** One local day: slot (10-minute index, 0 to 143) to the peak [five_hour, seven_day] seen in it. */
export type DayRecord = Record<string, [number | null, number | null]>

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function slotOf(ms: number): number {
  const d = new Date(ms)
  return Math.floor((d.getHours() * 60 + d.getMinutes()) / 10)
}

const maxOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))

export function mergeSample(day: DayRecord, slot: number, five: number | null, seven: number | null): DayRecord {
  const [oldFive = null, oldSeven = null] = day[String(slot)] ?? []
  return { ...day, [String(slot)]: [maxOf(oldFive, five), maxOf(oldSeven, seven)] }
}

/** Reads a stored day back, dropping anything that is not a [number | null, number | null] pair. */
export function asDay(value: unknown): DayRecord {
  if (value === null || typeof value !== 'object') return {}
  const day: DayRecord = {}
  for (const [slot, pair] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [a, b] = pair as unknown[]
    const ok = (v: unknown) => v === null || typeof v === 'number'
    if (ok(a) && ok(b)) day[slot] = [a as number | null, b as number | null]
  }
  return day
}

const SLOT = 10 * MIN

/** The five-hour window's peak per slot over the last `count` slots, oldest first. */
export function fiveSeries(days: Readonly<Record<string, DayRecord>>, now: number, count = 30): (number | null)[] {
  const out: (number | null)[] = []
  for (let i = count - 1; i >= 0; i--) {
    const at = now - i * SLOT
    out.push(days[dayKey(at)]?.[String(slotOf(at))]?.[0] ?? null)
  }
  return out
}

/** Seven rows (six days ago first, today last) of 24 hourly peaks of the five-hour window. */
export function weekGrid(days: Readonly<Record<string, DayRecord>>, now: number): { week: (number | null)[][]; weekDays: string[] } {
  const week: (number | null)[][] = []
  const weekDays: string[] = []
  const noon = new Date(now)
  noon.setHours(12, 0, 0, 0)
  for (let back = 6; back >= 0; back--) {
    const day = new Date(noon.getTime())
    day.setDate(noon.getDate() - back)
    const record = days[dayKey(day.getTime())] ?? {}
    const hours: (number | null)[] = []
    for (let h = 0; h < 24; h++) {
      let peak: number | null = null
      for (let s = h * 6; s < h * 6 + 6; s++) peak = maxOf(peak, record[String(s)]?.[0] ?? null)
      hours.push(peak)
    }
    week.push(hours)
    weekDays.push(WEEKDAYS[day.getDay()] ?? '')
  }
  return { week, weekDays }
}

/** The day keys a week grid reads, today last. */
export function weekKeys(now: number): string[] {
  const noon = new Date(now)
  noon.setHours(12, 0, 0, 0)
  const keys: string[] = []
  for (let back = 6; back >= 0; back--) {
    const day = new Date(noon.getTime())
    day.setDate(noon.getDate() - back)
    keys.push(dayKey(day.getTime()))
  }
  return keys
}

// ── Raster cells ──────────────────────────────────────────────────────

/** The value a Raster reads as "the terminal's default color". */
export const DEFAULT_COLOR = 0x01000000

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += b === undefined ? '=' : B64[(n >> 6) & 63]
    out += c === undefined ? '=' : B64[n & 63]
  }
  return out
}

/** Packs cells of [code point, color, background] into the string a Raster takes. */
export function packCells(cells: readonly (readonly [number, number, number])[]): string {
  const numbers = new Uint32Array(cells.length * 3)
  cells.forEach(([char, color, background], i) => {
    numbers[i * 3] = char
    numbers[i * 3 + 1] = color
    numbers[i * 3 + 2] = background
  })
  return toBase64(new Uint8Array(numbers.buffer))
}

/** The color of one percent cell in the week heat map and the pace sparkline. */
export function heatColor(value: number | null): number {
  if (value === null) return 0x4b515c
  if (value >= 80) return 0xe5534b
  if (value >= 50) return 0xe0a03a
  if (value >= 25) return 0x57ab5a
  return 0x346d45
}
