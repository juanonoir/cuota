import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULTS,
  bar,
  buildView,
  contextLevel,
  fitPieces,
  fiveSeries,
  formatCountdown,
  formatResetAt,
  formatTokens,
  mergeSample,
  modelFamily,
  packCells,
  pickAlert,
  spark,
  statusText,
  toBase64,
  weekGrid,
  windowView,
} from '../hooks/math'
import type { DayRecord } from '../hooks/math'

const MIN = 60_000
// Miércoles 7 de octubre de 2026, 14:05, hora local de quien corre el test
const NOW = new Date(2026, 9, 7, 14, 5).getTime()
const iso = (ms: number) => new Date(ms).toISOString()
const five = (used: number, leftMin: number) => ({ kind: 'five_hour', percentUsed: used, resetsAt: iso(NOW + leftMin * MIN) })

describe('windowView', () => {
  test('86 % con 65 min al reset: ritmo 1,10× y 100 % en ~38 min', () => {
    const w = windowView(five(86, 65), NOW, DEFAULTS)
    expect(w.pace).toBeGreaterThan(1.09)
    expect(w.pace).toBeLessThan(1.11)
    expect(Math.round((w.etaMs ?? 0) / MIN)).toBe(38)
    expect(w.leftMs).toBe(65 * MIN)
    expect(w.level).toBe('crit')
  })

  test('65 % con 2 h al reset: crítico por ritmo aunque esté bajo el piso', () => {
    const w = windowView(five(65, 120), NOW, DEFAULTS)
    expect(w.level).toBe('crit')
  })

  test('30 % al 25 % de la ventana: por encima del ritmo, ámbar', () => {
    const w = windowView(five(30, 225), NOW, DEFAULTS)
    expect(w.isTrusted).toBe(true)
    expect(w.level).toBe('warn')
  })

  test('42 % con 2h14 al reset: en calma', () => {
    expect(windowView(five(42, 134), NOW, DEFAULTS).level).toBe('ok')
  })

  test('ventana recién abierta: la proyección no es confiable', () => {
    const w = windowView(five(5, 295), NOW, DEFAULTS)
    expect(w.isTrusted).toBe(false)
    expect(w.level).toBe('ok')
  })

  test('7 d al 91 %: crítico por el piso', () => {
    const w = windowView({ kind: 'seven_day', percentUsed: 91, resetsAt: iso(NOW + 100 * 60 * MIN) }, NOW, DEFAULTS)
    expect(w.level).toBe('crit')
  })

  test('una ventana sin largo conocido sólo usa el piso', () => {
    expect(windowView({ kind: 'spend_limit', percentUsed: 85 }, NOW, DEFAULTS).level).toBe('ok')
    expect(windowView({ kind: 'spend_limit', percentUsed: 95 }, NOW, DEFAULTS).level).toBe('crit')
  })

  test('una ventana ya reiniciada queda en calma', () => {
    const w = windowView(five(97, -3), NOW, DEFAULTS)
    expect(w.leftMs).toBe(0)
    expect(w.level).toBe('ok')
  })
})

describe('contextLevel', () => {
  test('70 y 90 son los bordes', () => {
    expect(contextLevel(undefined, DEFAULTS)).toBe('ok')
    expect(contextLevel(69, DEFAULTS)).toBe('ok')
    expect(contextLevel(70, DEFAULTS)).toBe('warn')
    expect(contextLevel(89, DEFAULTS)).toBe('warn')
    expect(contextLevel(90, DEFAULTS)).toBe('crit')
  })
})

describe('formato', () => {
  test('cuenta regresiva', () => {
    expect(formatCountdown(0)).toBe('0 min')
    expect(formatCountdown(38 * MIN)).toBe('38 min')
    expect(formatCountdown(65 * MIN)).toBe('1h05')
    expect(formatCountdown(69 * 60 * MIN)).toBe('2d 21h')
  })

  test('hora del reset: hoy sin día, otro día con el día', () => {
    expect(formatResetAt(new Date(2026, 9, 7, 15, 10).getTime(), NOW)).toBe('15:10')
    expect(formatResetAt(new Date(2026, 9, 10, 11, 0).getTime(), NOW)).toBe('sáb 11:00')
  })

  test('tokens', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(156_400)).toBe('156k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1,3M')
  })

  test('familia del modelo con el semáforo por costo', () => {
    expect(modelFamily('claude-opus-5-5[1m]')).toEqual({ label: 'OPUS', tone: 'error' })
    expect(modelFamily('Sonnet 5.5')).toEqual({ label: 'Sonnet', tone: 'warning' })
    expect(modelFamily('claude-haiku-4-5-20251001')).toEqual({ label: 'Haiku', tone: 'success' })
    expect(modelFamily('claude-fable-5-1')).toEqual({ label: 'fable-5-1', tone: 'text' })
  })
})

describe('barras', () => {
  test('bar llena, vacía y por la mitad', () => {
    expect(bar(0, 4)).toEqual({ full: '', empty: '░░░░' })
    expect(bar(1, 4)).toEqual({ full: '████', empty: '' })
    expect(bar(0.5, 10)).toEqual({ full: '█████', empty: '░░░░░' })
    expect(bar(0.55, 10)).toEqual({ full: '█████▌', empty: '░░░░' })
  })

  test('spark con huecos', () => {
    expect(spark([0, 50, 100, null], 4)).toBe('▁▅█ ')
    expect(spark([10, 90, 20, 30], 2)).toBe('█▃')
  })

  test('fitPieces descarta primero lo de mayor drop', () => {
    const pieces = [{ text: 'OPUS' }, { text: ' xhigh', drop: 2 }, { text: ' ctx 31%' }, { text: ' ▰▰▰', drop: 3 }]
    expect(fitPieces(pieces, 40).map(p => p.text)).toEqual(['OPUS', ' xhigh', ' ctx 31%', ' ▰▰▰'])
    expect(fitPieces(pieces, 15).map(p => p.text)).toEqual(['OPUS', ' ctx 31%'])
  })
})

describe('historial', () => {
  test('mergeSample guarda el máximo del slot', () => {
    let day: DayRecord = {}
    day = mergeSample(day, 84, 40, 20)
    day = mergeSample(day, 84, 35, null)
    expect(day['84']).toEqual([40, 20])
    day = mergeSample(day, 84, 50, 22)
    expect(day['84']).toEqual([50, 22])
  })

  test('fiveSeries mira las últimas 5 h y cruza la medianoche', () => {
    const lateNight = new Date(2026, 9, 8, 0, 15).getTime()
    const series = fiveSeries({ '2026-10-07': { '143': [70, 30] }, '2026-10-08': { '1': [72, 30] } }, lateNight)
    expect(series).toHaveLength(30)
    expect(series[27]).toBe(70)
    expect(series[29]).toBe(72)
    expect(series[0]).toBeNull()
  })

  test('weekGrid: 7 días por 24 horas con el pico de cada hora', () => {
    const grid = weekGrid({ '2026-10-07': { '84': [60, 30], '85': [75, 31] } }, NOW)
    expect(grid.week).toHaveLength(7)
    expect(grid.week[6]).toHaveLength(24)
    expect(grid.week[6]?.[14]).toBe(75)
    expect(grid.week[6]?.[13]).toBeNull()
    expect(grid.weekDays[6]).toBe('mié')
    expect(grid.weekDays[0]).toBe('jue')
  })
})

describe('raster', () => {
  test('toBase64 con los vectores clásicos', () => {
    expect(toBase64(new Uint8Array([77, 97, 110]))).toBe('TWFu')
    expect(toBase64(new Uint8Array([77, 97]))).toBe('TWE=')
    expect(toBase64(new Uint8Array([77]))).toBe('TQ==')
  })

  test('packCells empaqueta tres uint32 por celda', () => {
    const packed = packCells([[0x2588, 0xff0000, 0x01000000]])
    const bytes = new Uint8Array(new Uint32Array([0x2588, 0xff0000, 0x01000000]).buffer)
    expect(packed).toBe(toBase64(bytes))
  })
})

describe('vista y alertas', () => {
  const reading = (percent: number, limits: { kind: string; percentUsed: number; resetsAt?: string }[]) => ({
    at: NOW, startedAt: NOW - 72 * MIN, tokens: percent * 2000, window: 200_000, percent, limits,
  })

  test('5 h al límite: la alerta trae la proyección y se puede ocultar', () => {
    const view = buildView(reading(52, [five(86, 65)]), NOW, DEFAULTS)
    const alert = pickAlert(view, [])
    expect(alert?.unit).toBe('five_hour')
    expect(alert?.level).toBe('crit')
    expect(alert?.text).toContain('~38 min')
    expect(alert?.text).toContain('1h05')
    expect(pickAlert(view, [alert?.id ?? ''])).toBeNull()
    expect(statusText(view)).toBe('5 h al 86 % · 100 % en ~38 min, reset en 1h05')
  })

  test('contexto alto: alerta ámbar sin línea ⚠', () => {
    const view = buildView(reading(78, [five(46, 122)]), NOW, DEFAULTS)
    const alert = pickAlert(view, [])
    expect(alert?.id).toBe('ctx:warn')
    expect(alert?.text).toContain('156k de 200k')
    expect(statusText(view)).toBeUndefined()
  })

  test('en calma no hay alerta', () => {
    const view = buildView(reading(31, [five(42, 134)]), NOW, DEFAULTS)
    expect(pickAlert(view, [])).toBeNull()
    expect(view.worst).toBe('ok')
  })
})
