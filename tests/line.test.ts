import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_LAYOUT,
  asLayout,
  lineRows,
  moveSegment,
  shiftStyle,
  toggleSegment,
  withConfigStyle,
} from '../hooks/line'
import type { Layout, LineInput } from '../hooks/line'
import { DEFAULTS, buildView } from '../hooks/math'

const MIN = 60_000
// Miércoles 7 de octubre de 2026, 14:05, hora local de quien corre el test
const NOW = new Date(2026, 9, 7, 14, 5).getTime()
const iso = (ms: number) => new Date(ms).toISOString()

const input = (percent = 31): LineInput => ({
  view: buildView(
    {
      at: NOW,
      startedAt: NOW - 72 * MIN,
      tokens: percent * 2000,
      window: 200_000,
      percent,
      limits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: iso(NOW + 134 * MIN) },
        { kind: 'seven_day', percentUsed: 29, resetsAt: iso(new Date(2026, 9, 10, 11, 0).getTime()) },
      ],
    },
    NOW,
    DEFAULTS,
  ),
  model: { model: 'claude-opus-5-5', effort: 'xhigh', isFallback: false },
  history: null,
  cache: { isWarm: true, leftMs: 41 * MIN, idleMs: 19 * MIN },
  costUsd: 12.4,
  now: NOW,
})

const text = (rows: { text: string }[][]) => rows.map(row => row.map(piece => piece.text).join(''))
const layout = (change: Partial<Layout>): Layout => ({ ...DEFAULT_LAYOUT, ...change })

describe('diseño guardado', () => {
  test('un diseño roto vuelve al de siempre; uno parcial se completa', () => {
    expect(asLayout(null)).toEqual(DEFAULT_LAYOUT)
    expect(asLayout({ order: ['ctx', 'model', 'ctx', 'nada'], hidden: ['ctx', 'nada'], style: 'pildoras' })).toEqual({
      order: ['ctx', 'model', 'five', 'seven', 'cache', 'cost'],
      hidden: ['ctx'],
      style: 'pildoras',
    })
  })

  test('el estilo de /config gana sólo si cambió desde la última vez', () => {
    const fromPanel = layout({ style: 'pildoras', configStyle: 'compacta' })
    expect(withConfigStyle(fromPanel, 'compacta').style).toBe('pildoras')
    expect(withConfigStyle(fromPanel, 'minima')).toEqual({ ...fromPanel, style: 'minima', configStyle: 'minima' })
    expect(withConfigStyle(fromPanel, 'cualquiera')).toEqual(fromPanel)
  })

  test('tildar, mover y cambiar de estilo', () => {
    expect(toggleSegment(DEFAULT_LAYOUT, 'cost').hidden).toEqual([])
    expect(toggleSegment(DEFAULT_LAYOUT, 'seven').hidden).toEqual(['cost', 'seven'])
    expect(moveSegment(DEFAULT_LAYOUT, 'five', -1).order.slice(0, 3)).toEqual(['model', 'five', 'ctx'])
    expect(moveSegment(DEFAULT_LAYOUT, 'model', -1).order[0]).toBe('model')
    expect(shiftStyle(DEFAULT_LAYOUT, 1).style).toBe('pildoras')
    expect(shiftStyle(DEFAULT_LAYOUT, -1).style).toBe('dos-renglones')
  })
})

describe('la línea', () => {
  test('compacta: los segmentos en orden, el ↻ separado y el costo oculto', () => {
    const [row] = text(lineRows(input(), DEFAULT_LAYOUT, 160))
    expect(row).toBe('OPUS xhigh  ·  ctx 31% ███▏░░░░░░  ·  5h 42%  ↻ 2h14  ·  7d 29%  ↻ sáb 11:00  ·  caché ● 41 min')
  })

  test('respeta el orden y lo oculto', () => {
    const [row] = text(lineRows(input(), layout({ order: ['five', 'model', 'ctx', 'seven', 'cache', 'cost'], hidden: ['seven', 'cache'] }), 160))
    expect(row?.startsWith('5h 42%')).toBe(true)
    expect(row).not.toContain('7d')
    expect(row).toContain('US$12,40')
  })

  test('píldoras: cada segmento con fondo, y el crítico en rojo', () => {
    const rows = lineRows(input(92), layout({ style: 'pildoras' }), 160)
    const pieces = rows[0] ?? []
    expect(pieces.find(p => p.text.includes('ctx 92%'))?.bg).toBe('diffRemovedDimmed')
    expect(pieces.find(p => p.text.includes('5h 42%'))?.bg).toBe('subtle')
    expect(pieces.filter(p => p.bg === undefined).every(p => p.text === ' ')).toBe(true)
  })

  test('mínima: sólo números mientras todo está en calma', () => {
    expect(text(lineRows(input(), layout({ style: 'minima' }), 160))).toEqual(['OPUS   31%   42%  ↻ 2h14   29%   ●'])
    expect(text(lineRows(input(78), layout({ style: 'minima' }), 160))[0]).toContain('▲ ctx 78%')
  })

  test('dos renglones: la sesión arriba y el plan abajo, con el ritmo', () => {
    const rows = text(lineRows(input(), layout({ style: 'dos-renglones' }), 160))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('caché ● vence en 41 min')
    expect(rows[1]).toContain('ritmo 0,76×')
    expect(rows[1]).toContain('7d')
  })

  test('píldoras angostas: al irse un segmento no queda su fondo suelto', () => {
    const [row] = text(lineRows(input(), layout({ style: 'pildoras', hidden: [] }), 60))
    expect(row).not.toContain('caché')
    expect(row?.endsWith('  ')).toBe(false)
  })

  test('angosta: se van primero el costo, el caché y los adornos; el modelo queda', () => {
    const [row] = text(lineRows(input(), layout({ hidden: [] }), 44))
    expect(row).toContain('OPUS')
    expect(row).toContain('5h 42%')
    expect(row).not.toContain('US$')
    expect(row).not.toContain('caché')
    expect(row?.endsWith('·  ')).toBe(false)
  })
})
