// The fixed line: which segments, in which order, drawn in which style. Pure, like math.ts:
// the PromptHint hook and the pane's Design tab both draw from lineRows, so the preview is the real line.

import type { CuotaHistory, CuotaModel } from '../types'
import {
  bar,
  fitPieces,
  formatCountdown,
  formatPace,
  formatResetAt,
  formatTokens,
  formatUsd,
  glyphOf,
  modelFamily,
  pricingOf,
  spark,
  toneOf,
} from './math'
import type { Level, Piece, View, WindowView } from './math'

export const SEGMENTS = ['model', 'ctx', 'five', 'seven', 'cache', 'cost'] as const
export type SegmentId = (typeof SEGMENTS)[number]

export const SEGMENT_NAMES: Record<SegmentId, string> = {
  model: 'Modelo y effort',
  ctx: 'Contexto',
  five: 'Ventana de 5 h',
  seven: 'Ventana de 7 d',
  cache: 'Caché',
  cost: 'Costo de la sesión',
}

export const STYLES = ['compacta', 'pildoras', 'minima', 'dos-renglones'] as const
export type LineStyle = (typeof STYLES)[number]

export const STYLE_NAMES: Record<LineStyle, string> = {
  compacta: 'compacta',
  pildoras: 'píldoras',
  minima: 'mínima',
  'dos-renglones': 'dos renglones',
}

/** What the Design tab saves: the order, what is hidden, the style, and the /config style last seen. */
export type Layout = { order: SegmentId[]; hidden: SegmentId[]; style: LineStyle; configStyle?: LineStyle }

export const DEFAULT_LAYOUT: Layout = { order: [...SEGMENTS], hidden: ['cost'], style: 'compacta' }

const isSegment = (value: unknown): value is SegmentId => typeof value === 'string' && (SEGMENTS as readonly string[]).includes(value)

export function styleOf(value: unknown): LineStyle | undefined {
  return typeof value === 'string' && (STYLES as readonly string[]).includes(value) ? (value as LineStyle) : undefined
}

/** Reads a stored layout back: unknown segments dropped, missing ones appended in the default order. */
export function asLayout(value: unknown): Layout {
  if (value === null || typeof value !== 'object') return { ...DEFAULT_LAYOUT, order: [...DEFAULT_LAYOUT.order], hidden: [...DEFAULT_LAYOUT.hidden] }
  const stored = value as Record<string, unknown>
  const order: SegmentId[] = []
  for (const id of Array.isArray(stored.order) ? stored.order : []) if (isSegment(id) && !order.includes(id)) order.push(id)
  for (const id of SEGMENTS) if (!order.includes(id)) order.push(id)
  const hidden = Array.isArray(stored.hidden) ? stored.hidden.filter(isSegment) : [...DEFAULT_LAYOUT.hidden]
  const configStyle = styleOf(stored.configStyle)
  return { order, hidden, style: styleOf(stored.style) ?? DEFAULT_LAYOUT.style, ...(configStyle === undefined ? {} : { configStyle }) }
}

/** The /config style wins only when it changed since it was last seen, so the panel and /config do not fight. */
export function withConfigStyle(layout: Layout, configured: unknown): Layout {
  const style = styleOf(configured)
  if (style === undefined || style === layout.configStyle) return layout
  return { ...layout, style, configStyle: style }
}

export function toggleSegment(layout: Layout, id: SegmentId): Layout {
  return { ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter(h => h !== id) : [...layout.hidden, id] }
}

export function moveSegment(layout: Layout, id: SegmentId, delta: -1 | 1): Layout {
  const from = layout.order.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= layout.order.length) return layout
  const order = [...layout.order]
  order.splice(from, 1)
  order.splice(to, 0, id)
  return { ...layout, order }
}

export function shiftStyle(layout: Layout, delta: -1 | 1): Layout {
  const index = STYLES.indexOf(layout.style)
  return { ...layout, style: STYLES[(index + delta + STYLES.length) % STYLES.length] ?? 'compacta' }
}

// ── Drawing the line ──────────────────────────────────────────────────

/** Whether the prompt cache is still warm, and how long it has left or has been cold. */
export type CacheState = { isWarm: boolean; leftMs: number; idleMs: number }

export type LineInput = {
  view: View | null
  model: CuotaModel | null
  history: CuotaHistory | null
  cache: CacheState | null
  costUsd?: number
  now: number
}

/** How readily a whole segment gives way in a narrow terminal (0: never). */
const SEGMENT_DROP: Record<SegmentId, number> = { model: 0, ctx: 0, five: 0, seven: 0, cache: 7, cost: 8 }

const SEPARATORS: Record<LineStyle, string> = { compacta: '  ·  ', pildoras: ' ', minima: '   ', 'dos-renglones': '    ' }

const labelOf = (level: Level, text: string) => (glyphOf(level) === '' ? text : `${glyphOf(level)} ${text}`)
const barTone = (level: Level) => (level === 'ok' ? 'success' : toneOf(level))

function windowOf(view: View, kind: string): WindowView | undefined {
  return view.windows.find(w => w.kind === kind)
}

/** One segment's pieces in a style, or null when there is nothing to show for it yet. */
function segmentPieces(id: SegmentId, input: LineInput, style: LineStyle): Piece[] | null {
  const { view, model, cache } = input
  const isMinimal = style === 'minima'
  const isWide = style === 'dos-renglones'
  switch (id) {
    case 'model': {
      if (model === null) return null
      const family = modelFamily(model.model)
      const pieces: Piece[] = [{ text: family.label, tone: family.tone, bold: true }]
      if (!isMinimal && model.effort !== undefined) pieces.push({ text: ` ${model.effort}`, dim: true, drop: 4 })
      if (model.isFallback) pieces.push({ text: ' fallback', tone: 'warning', drop: 1 })
      return pieces
    }
    case 'ctx': {
      if (view === null) return null
      const { percent, level } = view.context
      if (percent === undefined) return [{ text: 'ctx —', dim: true }]
      const value = `${Math.round(percent)}%`
      if (isMinimal) return [{ text: level === 'ok' ? value : labelOf(level, `ctx ${value}`), tone: toneOf(level) }]
      const b = bar(percent / 100, isWide ? 16 : 10)
      return [
        { text: labelOf(level, `ctx ${value}`), tone: toneOf(level) },
        { text: ` ${b.full}`, tone: barTone(level), drop: isWide ? 0 : 5 },
        { text: b.empty, dim: true, drop: isWide ? 0 : 5 },
      ]
    }
    case 'five':
    case 'seven': {
      if (view === null) return null
      const w = windowOf(view, id === 'five' ? 'five_hour' : 'seven_day')
      if (w === undefined) return null
      const value = `${Math.round(w.used)}%`
      const reset =
        id === 'five'
          ? w.leftMs === undefined
            ? ''
            : formatCountdown(w.leftMs)
          : w.resetsAt === undefined
            ? ''
            : formatResetAt(w.resetsAt, input.now)
      const resetDrop = id === 'five' ? 2 : 3
      if (isMinimal) {
        const pieces: Piece[] = [{ text: w.level === 'ok' ? value : labelOf(w.level, `${w.short} ${value}`), tone: toneOf(w.level) }]
        if (id === 'five' && reset !== '') pieces.push({ text: `  ↻ ${reset}`, dim: true, drop: resetDrop })
        return pieces
      }
      if (isWide) {
        const b = bar(w.used / 100, 16)
        const pace = id === 'five' && w.pace !== undefined ? ` · ritmo ${formatPace(w.pace)}` : ''
        return [
          { text: labelOf(w.level, w.short), tone: toneOf(w.level) },
          { text: `  ${b.full}`, tone: barTone(w.level) },
          { text: b.empty, dim: true },
          { text: `  ${value}`, tone: toneOf(w.level) },
          { text: reset === '' ? pace : `  ↻ ${reset}${pace}`, dim: true, drop: resetDrop },
        ]
      }
      const pieces: Piece[] = [{ text: labelOf(w.level, `${w.short} ${value}`), tone: toneOf(w.level) }]
      if (reset !== '') pieces.push({ text: `  ↻ ${reset}`, dim: true, drop: resetDrop })
      const series = input.history?.fiveSeries ?? []
      if (id === 'five' && series.filter(v => v !== null).length >= 2) pieces.push({ text: ` ${spark(series, 10)}`, dim: true, drop: 6 })
      return pieces
    }
    case 'cache': {
      if (cache === null) return null
      if (isMinimal) return [{ text: cache.isWarm ? '●' : '○', tone: cache.isWarm ? 'suggestion' : 'warning' }]
      if (cache.isWarm) return [{ text: isWide ? `caché ● vence en ${formatCountdown(cache.leftMs)}` : `caché ● ${formatCountdown(cache.leftMs)}`, tone: 'suggestion' }]
      return [{ text: isWide ? `caché ○ frío hace ${formatCountdown(cache.idleMs)}` : 'caché ○ frío', tone: 'warning' }]
    }
    case 'cost': {
      if (input.costUsd === undefined) return null
      if (isMinimal) return [{ text: `$${Math.round(input.costUsd)}`, dim: true }]
      return [{ text: isWide ? `sesión ${formatUsd(input.costUsd)}` : formatUsd(input.costUsd), dim: true }]
    }
  }
}

/** The level a segment shows, which sets a pill's background. */
function segmentLevel(id: SegmentId, view: View | null): Level {
  if (view === null) return 'ok'
  if (id === 'ctx') return view.context.level
  if (id === 'five' || id === 'seven') return windowOf(view, id === 'five' ? 'five_hour' : 'seven_day')?.level ?? 'ok'
  return 'ok'
}

/** Wraps a segment in a pill: a background for every piece, a space of padding at each end that goes with it. */
function pill(pieces: Piece[], level: Level, id: SegmentId, drop: number): Piece[] {
  const bg = level === 'crit' ? 'diffRemovedDimmed' : 'subtle'
  const pad: Piece = { text: ' ', bg, seg: id, drop }
  return [pad, ...pieces.map(piece => ({ ...piece, bg })), pad]
}

/** The rows the line draws: one, or two in the two-row style (the session above, the plan below). */
export function lineRows(input: LineInput, layout: Layout, columns: number): Piece[][] {
  const style = layout.style
  const shown = layout.order.filter(id => !layout.hidden.includes(id))

  if (input.view === null) {
    const model = shown.includes('model') ? (segmentPieces('model', input, style) ?? []) : []
    const waiting: Piece = { text: 'cuota · esperando la primera respuesta', dim: true }
    return [model.length > 0 ? [...model, { text: '  ·  ', dim: true }, waiting] : [waiting]]
  }

  const groups =
    style === 'dos-renglones'
      ? [shown.filter(id => id === 'model' || id === 'ctx' || id === 'cache' || id === 'cost'), shown.filter(id => id === 'five' || id === 'seven')]
      : [shown]

  const rows: Piece[][] = []
  for (const ids of groups) {
    const row: Piece[] = []
    for (const id of ids) {
      const pieces = segmentPieces(id, input, style)
      if (pieces === null) continue
      const whole = SEGMENT_DROP[id]
      const tagged = pieces.map(piece => ({ ...piece, seg: id, drop: Math.max(piece.drop ?? 0, whole) }))
      // The separator goes with the segment after it, so dropping a segment never leaves a stray one
      if (row.length > 0) row.push({ text: SEPARATORS[style], dim: style === 'compacta', seg: id, drop: whole, isSeparator: true })
      row.push(...(style === 'pildoras' ? pill(tagged, segmentLevel(id, input.view), id, whole) : tagged))
    }
    if (row.length > 0) rows.push(fitPieces(row, columns))
  }
  return rows
}

// ── Hover cards ───────────────────────────────────────────────────────

const CONTEXT_ADVICE: Record<Level, string> = {
  ok: 'en calma',
  warn: 'conviene compactar pronto',
  crit: 'compactá antes de que lo haga el motor',
}

/** The card a segment shows while the pointer is over it, one piece per line, the title first. */
export function cardLines(id: SegmentId, input: LineInput): Piece[] {
  const { view, model, cache } = input
  const title = (text: string): Piece => ({ text, bold: true })
  switch (id) {
    case 'model': {
      if (model === null) return [title('Modelo'), { text: 'sin dato todavía', dim: true }]
      const price = pricingOf(model.model)
      return [
        title('Modelo'),
        { text: `${model.model} · effort ${model.effort ?? '—'}` },
        { text: `input US$${String(price.input).replace('.', ',')} · lectura de caché ${formatUsd(price.read)} por MTok`, dim: true },
        model.isFallback ? { text: 'el último request salió por un modelo de fallback', tone: 'warning' } : { text: 'sin fallback', dim: true },
      ]
    }
    case 'ctx': {
      const context = view?.context
      if (context?.percent === undefined) return [title('Contexto'), { text: 'sin lectura todavía', dim: true }]
      return [
        title('Contexto'),
        { text: `${context.tokens === undefined ? '' : `${formatTokens(context.tokens)} de `}${formatTokens(context.window)} · ${Math.round(context.percent)} %` },
        { text: CONTEXT_ADVICE[context.level], tone: toneOf(context.level) },
        { text: 'detalle en /cuota → Contexto', dim: true },
      ]
    }
    case 'five':
    case 'seven': {
      const w = view === null ? undefined : windowOf(view, id === 'five' ? 'five_hour' : 'seven_day')
      const name = id === 'five' ? 'Ventana de 5 h' : 'Ventana de 7 d'
      if (w === undefined) return [title(name), { text: 'sin lectura todavía', dim: true }]
      const isAhead = w.isTrusted && w.pace !== undefined && w.pace > 1 && w.etaMs !== undefined
      const lines: Piece[] = [
        title(name),
        { text: `${Math.round(w.used)} % usado${w.elapsed === undefined ? '' : ` · ${Math.round(w.elapsed * 100)} % de la ${id === 'five' ? 'ventana' : 'semana'}`}` },
        w.pace === undefined
          ? { text: 'ritmo sin dato todavía', dim: true }
          : {
              text: `ritmo ${formatPace(w.pace)} · ${isAhead ? `100 % en ~${formatCountdown(w.etaMs ?? 0)}` : w.isTrusted ? 'llega al reset' : 'poca ventana para proyectar'}`,
              tone: toneOf(w.level),
            },
      ]
      if (w.resetsAt !== undefined) {
        lines.push({ text: `reset ${formatResetAt(w.resetsAt, input.now)}${w.leftMs === undefined ? '' : ` · en ${formatCountdown(w.leftMs)}`}`, dim: true })
      }
      const series = input.history?.fiveSeries ?? []
      if (id === 'five' && series.filter(v => v !== null).length >= 2) lines.push({ text: `${spark(series, 20)}  últimas 5 h`, dim: true })
      return lines
    }
    case 'cache': {
      if (cache === null) return [title('Caché del prompt'), { text: 'todavía no hay nada cacheado', dim: true }]
      return cache.isWarm
        ? [
            title('Caché del prompt'),
            { text: `caliente · vence en ${formatCountdown(cache.leftMs)}`, tone: 'suggestion' },
            { text: 'el próximo request lee el contexto del caché', dim: true },
          ]
        : [
            title('Caché del prompt'),
            { text: `frío hace ${formatCountdown(cache.idleMs)}`, tone: 'warning' },
            { text: 'el próximo request vuelve a escribir todo el contexto', dim: true },
          ]
    }
    case 'cost': {
      if (input.costUsd === undefined) return [title('Costo de la sesión'), { text: 'sin dato todavía', dim: true }]
      const lines: Piece[] = [title('Costo de la sesión'), { text: `${formatUsd(input.costUsd)} equivalente API` }]
      if ((view?.windows.length ?? 0) > 0) lines.push({ text: 'con suscripción no se cobra aparte', dim: true })
      return lines
    }
  }
}
