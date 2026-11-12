// Chalk: Hermes teaches on a chalkboard, right in the chat.
// The chalk_teach tool stores a lesson (what to say, what to draw) and its narration; this file
// lays the board out, draws it stroke by stroke in chalk while the narration plays, and can record
// the whole thing to a video.
import { host, TOOL_MEDIA_RENDERER_AREA } from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useRef, useState } from 'react'

// ----------------------------------------------------------------------------- constants
const W = 1920
const H = 1080
const SLATE = { x: 44, y: 44, w: W - 88, h: 908 } // inside the wooden frame
const CONTENT = { x: 120, y: 92, w: W - 240, h: 820 }
const CAPTION_Y = 1000 // caption band below the chalk ledge
const HAND = '"Ink Free", "Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Sans MS", cursive'
const SANS = '"Segoe UI", system-ui, -apple-system, sans-serif'
const CHALK = '#f3f0e6'
const COLORS = { white: CHALK, yellow: '#f6d769', pink: '#f4a6c3', blue: '#a6d4f5', green: '#b8e6a8' }
const PEN_SPEED = 1500 // px/s along lines
const WRITE_SPEED = 640 // px/s of text width
const started = new Map() // lesson id -> when its autoplay began (survives the card remounting)

// ----------------------------------------------------------------------------- small utils
let seed = 1
const rnd = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}
const jit = a => (rnd() - 0.5) * 2 * a
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1])

let measureCtx = null
function measure(text, size, font = HAND) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  measureCtx.font = `${size}px ${font}`
  return measureCtx.measureText(text).width
}
function fitSize(text, size, maxW, min = 22) {
  let s = size
  while (s > min && measure(text, s) > maxW) s -= 2
  return s
}
function wrapLines(text, size, maxW, font) {
  const words = String(text).split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w
    if (measure(t, size, font) > maxW && cur) {
      lines.push(cur)
      cur = w
    } else cur = t
  }
  if (cur) lines.push(cur)
  return lines
}

// ----------------------------------------------------------------------------- safe y=f(x)
// A tiny recursive-descent parser: numbers, x, + - * / ^, parentheses, a few functions.
function compileFn(src) {
  const s = String(src).toLowerCase().replace(/\s+/g, '').replace(/\*\*/g, '^')
  let i = 0
  const peek = () => s[i]
  const eat = c => (s[i] === c ? (i++, true) : false)
  const FN = { sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, sqrt: Math.sqrt, abs: Math.abs }
  function primary() {
    if (eat('(')) {
      const v = expr()
      eat(')')
      return v
    }
    if (eat('-')) {
      const v = unary()
      return x => -v(x)
    }
    let m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i))
    if (m) {
      i += m[0].length
      const n = parseFloat(m[0])
      return () => n
    }
    m = /^(sin|cos|tan|exp|log|sqrt|abs|pi|e|x)/.exec(s.slice(i))
    if (m) {
      i += m[0].length
      if (m[0] === 'x') return x => x
      if (m[0] === 'pi') return () => Math.PI
      if (m[0] === 'e') return () => Math.E
      const f = FN[m[0]]
      const a = primary()
      return x => f(a(x))
    }
    throw new Error('bad expression')
  }
  function unary() {
    return primary()
  }
  function power() {
    const b = implicit()
    if (eat('^')) {
      const e = power()
      return x => Math.pow(b(x), e(x))
    }
    return b
  }
  function implicit() {
    let a = unary()
    while (peek() && /[x(a-z0-9.]/.test(peek()) && !/[+\-*/^)]/.test(peek())) {
      const b = unary()
      const l = a
      a = x => l(x) * b(x)
    }
    return a
  }
  function term() {
    let a = power()
    for (;;) {
      if (eat('*')) {
        const l = a, r = power()
        a = x => l(x) * r(x)
      } else if (eat('/')) {
        const l = a, r = power()
        a = x => l(x) / r(x)
      } else return a
    }
  }
  function expr() {
    let a = term()
    for (;;) {
      if (eat('+')) {
        const l = a, r = term()
        a = x => l(x) + r(x)
      } else if (eat('-')) {
        const l = a, r = term()
        a = x => l(x) - r(x)
      } else return a
    }
  }
  const f = expr()
  if (i < s.length) throw new Error('bad expression')
  return f
}

// ----------------------------------------------------------------------------- hand-drawn geometry
// Every shape becomes a dense polyline with a little human wobble.
function line(a, b, bow = 0.02) {
  const n = Math.max(8, Math.round(dist(a, b) / 10))
  const nx = -(b[1] - a[1]), ny = b[0] - a[0]
  const len = Math.hypot(nx, ny) || 1
  const k = jit(bow) * dist(a, b)
  const pts = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const off = Math.sin(Math.PI * t) * k
    pts.push([a[0] + (b[0] - a[0]) * t + (nx / len) * off + jit(0.6), a[1] + (b[1] - a[1]) * t + (ny / len) * off + jit(0.6)])
  }
  return pts
}
function rectPts(x, y, w, hh) {
  const o = 7 // corners overshoot like a real hand
  const c = [[x + jit(3), y + jit(3)], [x + w + jit(3), y + jit(3)], [x + w + jit(3), y + hh + jit(3)], [x + jit(3), y + hh + jit(3)]]
  const ext = (a, b, e) => {
    const d = dist(a, b) || 1
    return [b[0] + ((b[0] - a[0]) / d) * e, b[1] + ((b[1] - a[1]) / d) * e]
  }
  return [
    ...line(c[0], ext(c[0], c[1], o)),
    ...line(c[1], ext(c[1], c[2], o * 0.5)),
    ...line(c[2], ext(c[2], c[3], o)),
    ...line(c[3], ext(c[3], c[0], o * 0.8))
  ]
}
function ellipsePts(cx, cy, rx, ry, turns = 1.12, tilt = -0.08) {
  const n = 90
  const pts = []
  const a0 = -2.2 + jit(0.3)
  for (let i = 0; i <= n * turns; i++) {
    const a = a0 + (i / n) * Math.PI * 2
    const grow = 1 + (i / n) * 0.06
    const px = Math.cos(a) * rx * grow, py = Math.sin(a) * ry * grow
    pts.push([cx + px * Math.cos(tilt) - py * Math.sin(tilt), cy + px * Math.sin(tilt) + py * Math.cos(tilt)])
  }
  return pts
}
function arrowStrokes(a, b, color = 'white', w = 5) {
  const body = line(a, b, 0.06)
  const e = body[body.length - 1], p = body[body.length - 4] || a
  const ang = Math.atan2(e[1] - p[1], e[0] - p[0])
  const L = 22
  const h1 = [e[0] - L * Math.cos(ang - 0.45), e[1] - L * Math.sin(ang - 0.45)]
  const h2 = [e[0] - L * Math.cos(ang + 0.45), e[1] - L * Math.sin(ang + 0.45)]
  return [path(body, color, w), path([...line(h1, e, 0), ...line(e, h2, 0)], color, w)]
}
function wavyUnderline(x, y, w) {
  const pts = []
  const n = Math.max(10, Math.round(w / 14))
  for (let i = 0; i <= n; i++) pts.push([x + (w * i) / n, y + Math.sin(i * 1.3) * 3 + jit(1)])
  return pts
}

// ----------------------------------------------------------------------------- strokes
function path(pts, color = 'white', w = 5) {
  let L = 0
  const cum = [0]
  for (let i = 1; i < pts.length; i++) {
    L += dist(pts[i - 1], pts[i])
    cum.push(L)
  }
  return { kind: 'path', pts, cum, len: L, color: COLORS[color] || color, w, dur: Math.max(0.12, L / PEN_SPEED) }
}
function text(str, x, y, size, color = 'white', align = 'center') {
  const w = measure(str, size)
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x
  return { kind: 'text', str, x: left, y, size, w, color: COLORS[color] || color, dur: Math.max(0.25, w / WRITE_SPEED + str.length * 0.012) }
}
const startOf = s => (s.kind === 'path' ? s.pts[0] : [s.x, s.y - s.size * 0.3])

// ----------------------------------------------------------------------------- layout
// A board is the run of blocks between two 'clear's. Blocks are packed into rows; the whole
// board scales down together if it would not fit.
function natural(b) {
  switch (b.type) {
    case 'title': return { w: Math.min(CONTENT.w, measure(b.text, 78) + 60), h: 120, full: true }
    case 'flow': return { w: Math.min(CONTENT.w, b.items.length * 330), h: 170 + (b.label ? 50 : 0), full: true }
    case 'list': {
      const tw = Math.max(...b.items.map(t => measure(t, 46))) + 90
      return { w: Math.min(CONTENT.w * 0.62, tw), h: b.items.length * 70 + 20 }
    }
    case 'compare': return { w: Math.min(CONTENT.w, 1400), h: 110 + Math.max(b.left.items.length, b.right.items.length, 1) * 64, full: true }
    case 'equation': return { w: Math.min(CONTENT.w, measure(b.text, 84) + 80), h: 140 }
    case 'graph': return { w: 640, h: 400 }
    case 'cycle': return { w: 560, h: 440 }
    case 'tree': return { w: Math.min(CONTENT.w, Math.max(700, b.children.length * 320)), h: 300, full: true }
    case 'note': return { w: Math.min(CONTENT.w, measure(b.text, 42) + 40), h: 74 }
    case 'sketch': return { w: 820, h: 560 + (b.label ? 54 : 0) }
    default: return { w: 0, h: 0 }
  }
}
function layoutBoard(blocks) {
  const items = blocks.filter(b => b.type !== 'mark' && b.type !== 'clear')
  const rows = []
  for (const b of items) {
    const n = natural(b)
    const last = rows[rows.length - 1]
    if (last && !n.full && !last.full && last.w + n.w + 60 <= CONTENT.w) {
      last.blocks.push({ b, n })
      last.w += n.w + 60
      last.h = Math.max(last.h, n.h)
    } else rows.push({ blocks: [{ b, n }], w: n.w, h: n.h, full: !!n.full })
  }
  const gap = 34
  const total = rows.reduce((a, r) => a + r.h, 0) + gap * Math.max(0, rows.length - 1)
  const widest = Math.max(...rows.map(r => r.w), 1)
  const s = clamp(Math.min(CONTENT.h / total, CONTENT.w / widest, 1.3), 0.5, 1.3)
  const place = new Map()
  let y = CONTENT.y
  const used = total * s
  if (used < CONTENT.h && items.length <= 3 && used < CONTENT.h * 0.62) {
    rows.offset = [0, (CONTENT.h - used) / 2] // a sparse board sits in the middle, like a title slide
  } else if (used < CONTENT.h) {
    const head = rows[0] && rows[0].blocks[0].b.type === 'title' ? rows[0].h * s + gap * s : 0
    const spare = CONTENT.h - used
    rows.offset = head ? [head, spare * 0.42] : [0, spare * 0.42]
  }
  rows.forEach((r, ri) => {
    if (rows.offset && ri === (rows.offset[0] ? 1 : 0)) y += rows.offset[1]
    const rh = r.h * s
    const rw = r.w * s
    let x = CONTENT.x + (CONTENT.w - rw) / 2
    for (const { b, n } of r.blocks) {
      place.set(b, { x, y: y + (rh - n.h * s) / 2, w: n.w * s, h: n.h * s, s })
      x += (n.w + 60) * s
    }
    y += rh + gap * s
  })
  place.scale = s
  return place
}

// ----------------------------------------------------------------------------- block -> strokes
function compileBlock(b, r, texts) {
  const s = r.s
  const out = []
  const T = (str, x, y, size, color, align) => {
    const t = text(str, x, y, size, color, align)
    texts.push({ str, x: t.x, y: y - size * 0.78, w: t.w, h: size * 1.05, size })
    out.push(t)
    return t
  }
  const cx = r.x + r.w / 2
  switch (b.type) {
    case 'title': {
      const size = fitSize(b.text, 78 * s, Math.max(r.w - 8, CONTENT.w * 0.4))
      const t = T(b.text, cx, r.y + 78 * s, size, 'white')
      out.push(path(wavyUnderline(t.x - 10, r.y + 100 * s, t.w + 20), 'yellow', 5 * s))
      break
    }
    case 'flow': {
      const n = b.items.length
      const gapA = 86 * s
      const bw = Math.min(290 * s, (r.w - gapA * (n - 1)) / n)
      const bh = 116 * s
      const x0 = cx - (bw * n + gapA * (n - 1)) / 2
      const y0 = r.y + 10 * s
      b.items.forEach((it, i) => {
        const bx = x0 + i * (bw + gapA)
        out.push(path(rectPts(bx, y0, bw, bh), 'white', 5 * s))
        const lines = wrapLines(it, 40 * s, bw - 24 * s)
        const size = lines.length > 2 ? fitSize(it, 40 * s, (bw - 24 * s) * 2) * 0.9 : 40 * s
        const ls = lines.length > 2 ? wrapLines(it, size, bw - 20 * s).slice(0, 3) : lines
        ls.forEach((l, k) => T(l, bx + bw / 2, y0 + bh / 2 + (k - (ls.length - 1) / 2) * size * 1.05 + size * 0.32, size, 'white'))
        if (i < n - 1) out.push(...arrowStrokes([bx + bw + 12 * s, y0 + bh / 2], [bx + bw + gapA - 12 * s, y0 + bh / 2], 'white', 5 * s))
      })
      if (b.label) T(b.label, cx, y0 + bh + 62 * s, 36 * s, 'blue')
      break
    }
    case 'list': {
      b.items.forEach((it, i) => {
        const y = r.y + 50 * s + i * 70 * s
        out.push(path(ellipsePts(r.x + 22 * s, y - 14 * s, 6 * s, 6 * s, 1.3, 0), 'yellow', 6 * s))
        T(it, r.x + 52 * s, y, fitSize(it, 46 * s, r.w - 60 * s), 'white', 'left')
      })
      break
    }
    case 'compare': {
      const mid = cx
      out.push(path(line([mid, r.y], [mid, r.y + r.h], 0.01), 'white', 4 * s))
      const sides = [[b.left, r.x + r.w * 0.25, 'pink'], [b.right, r.x + r.w * 0.75, 'blue']]
      for (const [side, x, col] of sides) {
        const t = T(side.title, x, r.y + 56 * s, 54 * s, col)
        out.push(path(line([t.x - 6, r.y + 74 * s], [t.x + t.w + 6, r.y + 74 * s], 0.02), col, 4 * s))
        side.items.forEach((it, i) => T(it, x, r.y + (140 + i * 64) * s, fitSize(it, 40 * s, r.w * 0.44), 'white'))
      }
      break
    }
    case 'equation': {
      const size = fitSize(b.text, 84 * s, r.w - 40)
      T(b.text, cx, r.y + r.h / 2 + size * 0.32, size, 'white')
      break
    }
    case 'graph': {
      const ox = r.x + 50 * s, oy = r.y + r.h - 50 * s, gw = r.w - 90 * s, gh = r.h - 100 * s
      let f
      try {
        f = compileFn(b.fn)
      } catch {
        f = x => x
      }
      const xs = []
      for (let i = 0; i <= 140; i++) xs.push(b.from + ((b.to - b.from) * i) / 140)
      const ys = xs.map(x => f(x)).map(v => (Number.isFinite(v) ? v : NaN))
      const good = ys.filter(Number.isFinite).sort((a, c) => a - c)
      let lo = good[Math.floor(good.length * 0.02)] ?? -1, hi = good[Math.ceil(good.length * 0.98) - 1] ?? 1
      if (hi - lo < 1e-6) { lo -= 1; hi += 1 }
      lo = Math.min(lo, 0); hi = Math.max(hi, 0)
      const X = x => ox + ((x - b.from) / (b.to - b.from)) * gw
      const Y = y => oy - ((y - lo) / (hi - lo)) * gh
      const ax = clamp(X(0), ox, ox + gw), ay = clamp(Y(0), oy - gh, oy)
      out.push(...arrowStrokes([ox - 10 * s, ay], [ox + gw + 24 * s, ay], 'white', 4 * s))
      out.push(...arrowStrokes([ax, oy + 10 * s], [ax, oy - gh - 24 * s], 'white', 4 * s))
      const pts = []
      xs.forEach((x, i) => {
        if (Number.isFinite(ys[i])) pts.push([X(x), clamp(Y(ys[i]), oy - gh - 10, oy + 10)])
      })
      if (pts.length > 2) out.push(path(pts, 'yellow', 6 * s))
      T(b.label, ox + gw - 10 * s, oy - gh + 10 * s, 38 * s, 'yellow', 'right')
      break
    }
    case 'cycle': {
      const n = b.items.length
      const rr = Math.min(r.w, r.h) * 0.36
      const cy = r.y + r.h / 2
      const ang = i => -Math.PI / 2 + (i * 2 * Math.PI) / n
      b.items.forEach((it, i) => {
        const a = ang(i)
        const size = fitSize(it, 40 * s, 230 * s)
        T(it, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr + size * 0.32, size, 'white')
        const a1 = a + 0.42, a2 = ang(i + 1) - 0.42
        const arc = []
        for (let k = 0; k <= 24; k++) {
          const t = a1 + ((a2 - a1) * k) / 24
          arc.push([cx + Math.cos(t) * rr * 1.0, cy + Math.sin(t) * rr * 1.0])
        }
        out.push(path(arc, 'white', 5 * s))
        const e = arc[arc.length - 1], p = arc[arc.length - 3]
        const an = Math.atan2(e[1] - p[1], e[0] - p[0])
        out.push(path([[e[0] - 20 * Math.cos(an - 0.5), e[1] - 20 * Math.sin(an - 0.5)], e, [e[0] - 20 * Math.cos(an + 0.5), e[1] - 20 * Math.sin(an + 0.5)]], 'white', 5 * s))
      })
      break
    }
    case 'tree': {
      const rw = Math.min(360 * s, measure(b.root, 46 * s) + 60 * s)
      const rh = 96 * s
      out.push(path(rectPts(cx - rw / 2, r.y, rw, rh), 'yellow', 5 * s))
      T(b.root, cx, r.y + rh / 2 + 15 * s, fitSize(b.root, 46 * s, rw - 30 * s), 'white')
      const n = b.children.length
      const cw = Math.min(280 * s, (r.w - 40 * s * (n - 1)) / n)
      const cyy = r.y + r.h - 96 * s
      b.children.forEach((c, i) => {
        const x = cx - ((n - 1) / 2 - i) * (cw + 40 * s)
        out.push(path(line([cx, r.y + rh + 6 * s], [x, cyy - 8 * s], 0.03), 'white', 4 * s))
        out.push(path(rectPts(x - cw / 2, cyy, cw, 90 * s), 'white', 5 * s))
        T(c, x, cyy + 58 * s, fitSize(c, 38 * s, cw - 24 * s), 'white')
      })
      break
    }
    case 'sketch': {
      // Shapes live on a 0-100 grid (x right, y down), mapped onto a square in the middle of the block.
      const labelH = b.label ? 54 * s : 0
      const G = Math.min(r.w * 0.66, r.h - labelH - 10 * s)
      const ox = cx - G / 2, oy = r.y + 4 * s
      const P = p => [ox + (p[0] * G) / 100, oy + (p[1] * G) / 100]
      const u = v => (v * G) / 100
      for (const sh of b.shapes) {
        const col = sh.color || 'white'
        if (sh.shape === 'rect') {
          const [x, y] = P([sh.x, sh.y])
          out.push(path(rectPts(x, y, u(sh.w), u(sh.h)), col, 5 * s))
        } else if (sh.shape === 'circle') {
          const [x, y] = P([sh.x, sh.y])
          out.push(path(ellipsePts(x, y, u(sh.r), u(sh.r), 1.04, 0), col, 5 * s))
        } else if (sh.shape === 'line') {
          out.push(path(line(P(sh.from), P(sh.to), 0.015), col, 5 * s))
        } else if (sh.shape === 'arrow') {
          out.push(...arrowStrokes(P(sh.from), P(sh.to), col, 5 * s))
        } else if (sh.shape === 'path') {
          const ps = sh.points.map(P)
          if (sh.closed) ps.push(ps[0])
          const pts = []
          for (let i = 1; i < ps.length; i++) pts.push(...line(ps[i - 1], ps[i], 0.01))
          out.push(path(pts, col, 5 * s))
        } else if (sh.shape === 'label') {
          const at = P(sh.at)
          const size = 34 * s
          const to = sh.to ? P(sh.to) : null
          const align = to ? (to[0] >= at[0] ? 'right' : 'left') : 'center'
          const t = T(sh.text, at[0], at[1] + size * 0.32, size, sh.color && sh.color !== 'white' ? col : 'blue', align)
          if (to) {
            const sx = align === 'right' ? t.x + t.w + 10 * s : t.x - 10 * s
            out.push(path(line([sx, at[1]], to, 0.02), 'blue', 3 * s))
            out.push(path(ellipsePts(to[0], to[1], 4 * s, 4 * s, 1.2, 0), 'blue', 5 * s))
          }
        }
      }
      if (b.label) T(b.label, cx, r.y + r.h - 14 * s, 38 * s, 'yellow')
      break
    }
    case 'note': {
      T(b.text, cx, r.y + 50 * s, fitSize(b.text, 42 * s, r.w), 'green')
      break
    }
  }
  return out
}
function compileMark(b, texts) {
  const want = b.target.toLowerCase()
  let best = null, bestScore = 0
  for (const t of texts) {
    const have = t.str.toLowerCase()
    let score = have === want ? 3 : have.includes(want) || want.includes(have) ? 2 : 0
    if (!score) {
      const ws = want.split(/\W+/).filter(w => w.length > 2)
      score = ws.filter(w => have.includes(w)).length / Math.max(1, ws.length)
    }
    if (score > bestScore) { bestScore = score; best = t }
  }
  if (!best || bestScore < 0.5) return []
  const at = best.str.toLowerCase().indexOf(want)
  if (at >= 0 && want.length < best.str.length && best.size) {
    const off = measure(best.str.slice(0, at), best.size)
    best = { ...best, x: best.x + off, w: measure(best.str.slice(at, at + want.length), best.size) }
  }
  if (b.style === 'underline') return [path(wavyUnderline(best.x - 8, best.y + best.h + 6, best.w + 16), 'yellow', 6)]
  return [path(ellipsePts(best.x + best.w / 2, best.y + best.h / 2, best.w / 2 + 24, best.h / 2 + 20), 'yellow', 6)]
}

// Lesson -> timeline of steps, each with its strokes. Built once; replays reuse it.
function buildTimeline(lesson) {
  seed = 7
  const steps = lesson.steps.map(st => ({ ...st, strokes: [], clear: false }))
  let i = 0
  while (i < steps.length) {
    let j = i
    const board = []
    while (j < steps.length) {
      const d = steps[j].draw
      if (d && d.type === 'clear' && j > i) break
      if (d && d.type !== 'clear') {
        // a full board turns the page by itself: wipe and carry on on a clean one
        const content = board.filter(b => b.type !== 'title' && b.type !== 'mark').length
        if (d.type !== 'mark' && j > i && content >= 2 && layoutBoard([...board, d]).scale < 0.88) {
          steps[j].autoClear = true
          break
        }
        board.push(d)
      }
      j++
    }
    const place = layoutBoard(board)
    const texts = []
    for (let k = i; k < j; k++) {
      const d = steps[k].draw
      if (k === i && steps[k].autoClear) steps[k].clear = true
      if (!d) continue
      if (d.type === 'clear') steps[k].clear = true
      else if (d.type === 'mark') steps[k].strokes = compileMark(d, texts)
      else if (place.has(d)) steps[k].strokes = compileBlock(d, place.get(d), texts)
    }
    i = j
  }
  // timing: drawing paced to the narration (never faster than the hand, never far behind the voice)
  let t = 0.6
  let pen = [W / 2, H * 0.6]
  for (const st of steps) {
    st.t0 = t
    let draw = st.clear ? 1.5 : 0
    for (const s of st.strokes) {
      draw += clamp(dist(pen, startOf(s)) / 2600, 0.06, 0.4) + s.dur
      pen = s.kind === 'path' ? s.pts[s.pts.length - 1] : [s.x + s.w, s.y]
    }
    const voice = st.audio ? st.seconds : 0
    st.slow = voice > draw && draw > 0 ? clamp((voice * 0.9) / draw, 1, 1.6) : 1
    st.drawEnd = draw * st.slow
    const read = st.say && !st.audio ? st.say.length / 16 : 0
    st.t1 = t + Math.max(st.drawEnd + 0.25, voice + 0.45, read)
    t = st.t1
  }
  return { steps, total: t + 1.2 }
}

// The caption shows one sentence at a time, timed by how much of the step has been spoken.
function captionAt(st, lt) {
  if (!st.say) return ''
  if (!st.sentences) {
    st.sentences = st.say.match(/[^.!?]+[.!?]+["'”’)\]]*|[^.!?]+$/g)?.map(x => x.trim()).filter(Boolean) || [st.say]
    const merged = []
    for (const x of st.sentences) {
      if (merged.length && (merged[merged.length - 1] + ' ' + x).length < 90) merged[merged.length - 1] += ' ' + x
      else merged.push(x)
    }
    st.sentences = merged
  }
  const span = st.audio ? st.seconds : Math.max(1, st.say.length / 16)
  const total = st.sentences.reduce((a, x) => a + x.length, 0)
  let acc = 0
  const at = clamp(lt / span, 0, 1) * total
  for (const x of st.sentences) {
    acc += x.length
    if (at <= acc) return x
  }
  return st.sentences[st.sentences.length - 1]
}

// ----------------------------------------------------------------------------- textures
function makeGrain() {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const img = g.createImageData(W, H)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = Math.random()
    d[i] = d[i + 1] = d[i + 2] = 255
    d[i + 3] = n < 0.22 ? 30 + n * 260 : 190 + n * 65 // speckled gaps, like chalk on slate
  }
  g.putImageData(img, 0, 0)
  // faint diagonal drag lines
  g.globalCompositeOperation = 'destination-out'
  g.strokeStyle = 'rgba(0,0,0,0.25)'
  for (let k = 0; k < 900; k++) {
    const x = Math.random() * W, y = Math.random() * H
    g.lineWidth = Math.random() * 1.2
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + 6 + Math.random() * 10, y + 2 + Math.random() * 3)
    g.stroke()
  }
  return c
}
function makeSlate() {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  // wooden frame
  const wood = g.createLinearGradient(0, 0, 0, H)
  wood.addColorStop(0, '#6b4528'); wood.addColorStop(0.5, '#7a5131'); wood.addColorStop(1, '#5a3a22')
  g.fillStyle = wood
  g.fillRect(0, 0, W, H)
  for (let k = 0; k < 220; k++) {
    g.strokeStyle = `rgba(40,22,10,${0.05 + Math.random() * 0.08})`
    g.lineWidth = 1 + Math.random() * 2
    const y = Math.random() * H
    g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(W * 0.3, y + jit(8), W * 0.7, y + jit(8), W, y + jit(6)); g.stroke()
  }
  // slate
  const sl = g.createRadialGradient(W * 0.45, H * 0.4, 100, W / 2, H / 2, W * 0.75)
  sl.addColorStop(0, '#2f4a3d'); sl.addColorStop(1, '#1d3028')
  g.fillStyle = sl
  g.fillRect(SLATE.x, SLATE.y, SLATE.w, SLATE.h)
  // old eraser ghosts
  g.save()
  g.filter = 'blur(28px)'
  for (let k = 0; k < 14; k++) {
    const x = SLATE.x + Math.random() * SLATE.w, y = SLATE.y + Math.random() * SLATE.h
    g.fillStyle = `rgba(215,228,218,${0.018 + Math.random() * 0.02})`
    g.beginPath()
    g.ellipse(x, y, 160 + Math.random() * 320, 40 + Math.random() * 60, jit(0.25), 0, Math.PI * 2)
    g.fill()
  }
  g.restore()
  const img = g.getImageData(SLATE.x, SLATE.y, SLATE.w, SLATE.h)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 9
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n
  }
  g.putImageData(img, SLATE.x, SLATE.y)
  // inner shadow
  g.strokeStyle = 'rgba(0,0,0,0.45)'
  g.lineWidth = 6
  g.strokeRect(SLATE.x + 3, SLATE.y + 3, SLATE.w - 6, SLATE.h - 6)
  // chalk ledge with a few sticks and a felt eraser
  g.fillStyle = '#4a2f1b'
  g.fillRect(SLATE.x - 10, SLATE.y + SLATE.h, SLATE.w + 20, 26)
  g.fillStyle = 'rgba(255,255,255,0.06)'
  g.fillRect(SLATE.x - 10, SLATE.y + SLATE.h, SLATE.w + 20, 4)
  const sticks = [[1300, '#f3f0e6'], [1360, '#f6d769'], [1395, '#f4a6c3']]
  for (const [x, col] of sticks) {
    g.fillStyle = col
    g.fillRect(x, SLATE.y + SLATE.h - 11, 46, 12)
  }
  g.fillStyle = '#2a2a33'; g.fillRect(1480, SLATE.y + SLATE.h - 26, 130, 26)
  g.fillStyle = '#b9a98c'; g.fillRect(1480, SLATE.y + SLATE.h - 8, 130, 8)
  // caption band
  g.fillStyle = '#0e0f10'
  g.fillRect(0, CAPTION_Y - 22, W, H - CAPTION_Y + 22)
  return c
}

// ----------------------------------------------------------------------------- sound
function makeAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext
  const ac = new Ctx()
  const out = ac.createGain()
  out.gain.value = 1
  out.connect(ac.destination)
  const rec = ac.createMediaStreamDestination()
  out.connect(rec)
  // chalk scratch: looping noise through a band-pass, volume follows the pen
  const len = ac.sampleRate * 2
  const buf = ac.createBuffer(1, len, ac.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1
    last = last * 0.6 + white * 0.4
    d[i] = (Math.random() < 0.004 ? (Math.random() * 2 - 1) * 3 : 0) + last // crackle
  }
  const src = ac.createBufferSource()
  src.buffer = buf
  src.loop = true
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 3200
  bp.Q.value = 0.8
  const scratch = ac.createGain()
  scratch.gain.value = 0
  src.connect(bp).connect(scratch).connect(out)
  src.start()
  const voice = ac.createGain()
  voice.gain.value = 1
  voice.connect(out)
  return { ac, out, rec, scratch, bp, voice }
}
function tap(A, loud = 0.22) {
  const ac = A.ac
  const n = Math.floor(ac.sampleRate * 0.03)
  const b = ac.createBuffer(1, n, ac.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n * 0.15))
  const s = ac.createBufferSource()
  s.buffer = b
  const g = ac.createGain()
  g.gain.value = loud
  const f = ac.createBiquadFilter()
  f.type = 'highpass'
  f.frequency.value = 1400
  s.connect(f).connect(g).connect(A.out)
  s.start()
}

// ----------------------------------------------------------------------------- the board engine
function createBoard(canvas, lesson, audioUrls) {
  const ctx = canvas.getContext('2d')
  const chalk = document.createElement('canvas')
  chalk.width = W; chalk.height = H
  const cg = chalk.getContext('2d')
  const tmp = document.createElement('canvas')
  tmp.width = W; tmp.height = H
  const tg = tmp.getContext('2d')
  // tmp holds chalk-through-grain; only the parts that changed are re-grained each frame
  let dirty = null
  const mark = (x0, y0, x1, y1) => {
    if (!dirty) dirty = [x0, y0, x1, y1]
    else dirty = [Math.min(dirty[0], x0), Math.min(dirty[1], y0), Math.max(dirty[2], x1), Math.max(dirty[3], y1)]
  }
  const markAll = () => { dirty = [0, 0, W, H] }
  function flushGrain() {
    if (!dirty) return
    const x = Math.max(0, Math.floor(dirty[0])), y = Math.max(0, Math.floor(dirty[1]))
    const w = Math.min(W, Math.ceil(dirty[2])) - x, hh = Math.min(H, Math.ceil(dirty[3])) - y
    dirty = null
    if (w <= 0 || hh <= 0) return
    tg.save()
    tg.beginPath()
    tg.rect(x, y, w, hh)
    tg.clip()
    tg.globalCompositeOperation = 'source-over'
    tg.clearRect(x, y, w, hh)
    tg.drawImage(chalk, x, y, w, hh, x, y, w, hh)
    tg.globalCompositeOperation = 'destination-in'
    tg.drawImage(grain, x, y, w, hh, x, y, w, hh)
    tg.restore()
  }
  const slate = makeSlate()
  const sg = slate.getContext('2d')
  const slateClean = document.createElement('canvas')
  slateClean.width = W; slateClean.height = H
  slateClean.getContext('2d').drawImage(slate, 0, 0)
  const grain = makeGrain()
  const tl = buildTimeline(lesson)
  let A = null
  const buffers = {}
  let raf = 0
  let state = { playing: false, t: 0, startAt: 0, step: -1, voiceSrc: null, onEnd: null, pen: null, lastPen: null }

  const resetInk = () => {
    cg.clearRect(0, 0, W, H)
    markAll()
    sg.clearRect(0, 0, W, H)
    sg.drawImage(slateClean, 0, 0)
    for (const st of tl.steps) for (const s of st.strokes) s.done = 0
  }

  function inkPath(s, p) {
    const target = s.len * p
    let from = s.done * s.len
    if (target <= from) return
    cg.strokeStyle = s.color
    cg.lineCap = 'round'
    cg.lineJoin = 'round'
    let i = 1
    while (i < s.cum.length && s.cum[i] < from) i++
    let prev = interp(s, from)
    let bx0 = prev[0], by0 = prev[1], bx1 = prev[0], by1 = prev[1]
    cg.beginPath()
    cg.moveTo(prev[0], prev[1])
    for (; i < s.cum.length && s.cum[i] <= target; i++) {
      cg.lineWidth = s.w * (0.85 + rnd() * 0.3)
      cg.lineTo(s.pts[i][0], s.pts[i][1])
      bx0 = Math.min(bx0, s.pts[i][0]); bx1 = Math.max(bx1, s.pts[i][0])
      by0 = Math.min(by0, s.pts[i][1]); by1 = Math.max(by1, s.pts[i][1])
    }
    const end = interp(s, target)
    bx0 = Math.min(bx0, end[0]); bx1 = Math.max(bx1, end[0]); by0 = Math.min(by0, end[1]); by1 = Math.max(by1, end[1])
    const pad = s.w * 3 + 4
    mark(bx0 - pad, by0 - pad, bx1 + pad, by1 + pad)
    cg.lineTo(end[0], end[1])
    cg.stroke()
    // chalk dust
    cg.fillStyle = s.color
    for (let k = 0; k < 3; k++) {
      if (rnd() < 0.5) {
        cg.globalAlpha = 0.35
        cg.fillRect(end[0] + jit(s.w * 1.6), end[1] + jit(s.w * 1.6), 1.6, 1.6)
      }
    }
    cg.globalAlpha = 1
    s.done = p
    return end
  }
  function interp(s, at) {
    let i = 1
    while (i < s.cum.length - 1 && s.cum[i] < at) i++
    const a = s.pts[i - 1], b = s.pts[i]
    const seg = s.cum[i] - s.cum[i - 1] || 1
    const t = clamp((at - s.cum[i - 1]) / seg, 0, 1)
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
  function inkText(s, p) {
    if (p <= s.done) return
    const x0 = s.x + s.w * s.done - 2, x1 = s.x + s.w * p + 1
    cg.save()
    cg.beginPath()
    cg.rect(x0, s.y - s.size * 1.2, x1 - x0, s.size * 1.7)
    cg.clip()
    mark(x0 - 2, s.y - s.size * 1.2, x1 + 2, s.y + s.size * 0.5)
    cg.font = `${s.size}px ${HAND}`
    cg.fillStyle = s.color
    cg.textBaseline = 'alphabetic'
    cg.fillText(s.str, s.x, s.y)
    cg.restore()
    s.done = p
    return [s.x + s.w * p, s.y - s.size * 0.35 + Math.sin(p * s.w * 0.09) * s.size * 0.22]
  }

  // Draw one step's strokes up to local time lt; returns the pen position (or null when idle).
  function inkStep(st, lt) {
    let t = 0
    let pen = null
    let prevEnd = state.lastPen || [W / 2, H * 0.6]
    for (const s of st.strokes) {
      const travel = clamp(dist(prevEnd, startOf(s)) / 2600, 0.06, 0.4) * st.slow
      const t0 = t + travel, t1 = t0 + s.dur * st.slow
      if (lt < t0) {
        if (s.done === 0 && lt > t) {
          const k = (lt - t) / travel
          const a = startOf(s)
          pen = [prevEnd[0] + (a[0] - prevEnd[0]) * k, prevEnd[1] + (a[1] - prevEnd[1]) * k]
          pen.up = true
        }
        break
      }
      const p = clamp((lt - t0) / (t1 - t0), 0, 1)
      if (s.done < 1) {
        if (s.done === 0 && A) tap(A, 0.16)
        const e = s.kind === 'path' ? inkPath(s, p) : inkText(s, p)
        if (e) pen = e
      }
      prevEnd = s.kind === 'path' ? s.pts[s.pts.length - 1] : [s.x + s.w, s.y - s.size * 0.3]
      t = t1
    }
    return pen
  }
  function finishStep(st) {
    // A dropped frame (background tab, slow machine) can jump past a whole eraser step; still wipe.
    if (st.clear && !st.wiped) {
      cg.clearRect(0, 0, W, H)
      markAll()
      st.wiped = true
    }
    for (const s of st.strokes) {
      if (s.done < 1) (s.kind === 'path' ? inkPath : inkText)(s, 1)
    }
    if (st.strokes.length) {
      const s = st.strokes[st.strokes.length - 1]
      state.lastPen = s.kind === 'path' ? s.pts[s.pts.length - 1] : [s.x + s.w, s.y - s.size * 0.3]
    }
  }
  function eraseAt(k) {
    // a felt eraser sweeping in a zigzag; leaves a faint smear on the slate
    const rows = 5
    const seg = Math.min(rows - 1e-6, k * rows)
    const row = Math.floor(seg), f = seg - row
    const y = SLATE.y + 90 + row * ((SLATE.h - 180) / (rows - 1))
    const x = row % 2 ? SLATE.x + SLATE.w - 120 - f * (SLATE.w - 240) : SLATE.x + 120 + f * (SLATE.w - 240)
    cg.save()
    cg.globalCompositeOperation = 'destination-out'
    cg.fillStyle = 'rgba(0,0,0,0.9)'
    cg.beginPath()
    cg.ellipse(x, y, 210, 150, 0, 0, Math.PI * 2)
    cg.fill()
    cg.restore()
    mark(x - 215, y - 155, x + 215, y + 155)
    return { x, y }
  }

  const capCache = new Map()
  function compose(pen, eraser, caption) {
    ctx.drawImage(slate, 0, 0)
    flushGrain()
    ctx.save()
    ctx.beginPath()
    ctx.rect(SLATE.x, SLATE.y, SLATE.w, SLATE.h)
    ctx.clip()
    ctx.drawImage(tmp, 0, 0)
    ctx.restore()
    if (eraser) {
      ctx.save()
      ctx.translate(eraser.x, eraser.y)
      ctx.rotate(-0.12)
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8
      ctx.fillStyle = '#2a2a33'; ctx.fillRect(-120, -40, 240, 56)
      ctx.shadowColor = 'transparent'
      ctx.fillStyle = '#b9a98c'; ctx.fillRect(-120, 16, 240, 22)
      ctx.restore()
    }
    if (pen) {
      // the chalk stick, held at an angle; lifted (smaller shadow offset) when travelling
      ctx.save()
      ctx.translate(pen[0], pen[1])
      ctx.rotate(-0.75)
      ctx.shadowColor = 'rgba(0,0,0,0.45)'
      ctx.shadowBlur = pen.up ? 22 : 10
      ctx.shadowOffsetX = pen.up ? 14 : 6
      ctx.shadowOffsetY = pen.up ? 16 : 7
      const grad = ctx.createLinearGradient(0, -9, 0, 9)
      grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#d9d4c6')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.roundRect ? ctx.roundRect(0, -9, 92, 18, 4) : ctx.rect(0, -9, 92, 18)
      ctx.fill()
      ctx.restore()
    }
    if (caption) {
      if (!capCache.has(caption)) {
        let sz = 38
        let ls = wrapLines(caption, sz, W - 240, SANS)
        if (ls.length > 1) {
          sz = 32
          ls = wrapLines(caption, sz, W - 240, SANS).slice(0, 2)
        }
        capCache.set(caption, [sz, ls])
      }
      const [size, lines] = capCache.get(caption)
      ctx.font = `500 ${size}px ${SANS}`
      ctx.fillStyle = '#ece8df'
      ctx.textAlign = 'center'
      lines.forEach((l, i) => ctx.fillText(l, W / 2, (lines.length > 1 ? 1025 : 1044) + i * 38))
      ctx.textAlign = 'left'
    }
  }

  async function loadVoices() {
    if (!A) return
    for (const [k, url] of Object.entries(audioUrls || {})) {
      if (buffers[k]) continue
      try {
        const ab = await (await fetch(url)).arrayBuffer()
        buffers[k] = await A.ac.decodeAudioData(ab)
      } catch {
        // no voice for this step: the captions carry it
      }
    }
  }

  function frame() {
    const now = performance.now() / 1000
    const t = now - state.startAt
    let i = tl.steps.findIndex(st => t < st.t1)
    if (i < 0) i = tl.steps.length
    while (state.step < i) {
      if (state.step >= 0) finishStep(tl.steps[state.step])
      state.step++
      const st = tl.steps[state.step]
      if (st && A && buffers[String(state.step)] && state.step === i) {
        const src = A.ac.createBufferSource()
        src.buffer = buffers[String(state.step)]
        src.connect(A.voice)
        if (t > st.t0) src.start(A.ac.currentTime, Math.min(src.buffer.duration, t - st.t0))
        else src.start(A.ac.currentTime + (st.t0 - t))
        state.voiceSrc = src
      }
      if (st && st.clear) {
        sg.globalAlpha = 0.07
        sg.filter = 'blur(6px)'
        sg.drawImage(chalk, 0, 0)
        sg.filter = 'none'
        sg.globalAlpha = 1
      }
    }
    const st = tl.steps[i]
    let pen = null, eraser = null
    if (st) {
      const lt = t - st.t0
      if (st.clear && lt < 1.5) {
        eraser = eraseAt(lt / 1.5)
        if (A) A.scratch.gain.setTargetAtTime(0.05, A.ac.currentTime, 0.03)
      } else if (st.clear && !st.wiped) {
        cg.clearRect(0, 0, W, H)
        markAll()
        st.wiped = true
      }
      if (!eraser) pen = inkStep(st, st.clear ? lt - 1.5 : lt)
    }
    if (A && !eraser) {
      const moving = pen && !pen.up && state.pen ? dist(pen, state.pen) : 0
      A.scratch.gain.setTargetAtTime(clamp(moving / 30, 0, 1) * 0.11, A.ac.currentTime, 0.02)
      A.bp.frequency.setTargetAtTime(2600 + clamp(moving * 40, 0, 1800), A.ac.currentTime, 0.05)
    }
    state.pen = pen
    compose(pen, eraser, st ? captionAt(st, t - st.t0) : '')
    if (t < tl.total) raf = requestAnimationFrame(frame)
    else {
      state.playing = false
      if (A) A.scratch.gain.setTargetAtTime(0, A.ac.currentTime, 0.02)
      compose(null, null, '')
      if (state.onEnd) state.onEnd()
    }
  }

  return {
    total: tl.total,
    async play(onEnd, offset = 0) {
      cancelAnimationFrame(raf)
      if (state.voiceSrc) try { state.voiceSrc.stop() } catch {}
      if (!A) A = makeAudio()
      if (A.ac.state === 'suspended') await A.ac.resume()
      await loadVoices()
      resetInk()
      seed = 11
      for (const st of tl.steps) st.wiped = false
      state = { ...state, playing: true, step: -1, startAt: performance.now() / 1000 - offset, onEnd, pen: null, lastPen: null }
      raf = requestAnimationFrame(frame)
      return A.ac.state
    },
    // the finished board, without animation (history view and poster)
    still() {
      resetInk()
      let lastBoard = 0
      tl.steps.forEach((st, k) => { if (st.clear) lastBoard = k })
      for (let k = lastBoard; k < tl.steps.length; k++) finishStep(tl.steps[k])
      compose(null, null, '')
    },
    stream() {
      const vs = canvas.captureStream(30)
      if (A) for (const tr of A.rec.stream.getAudioTracks()) vs.addTrack(tr)
      return vs
    },
    ensureAudio() {
      if (!A) A = makeAudio()
      return A
    },
    stop() {
      cancelAnimationFrame(raf)
      if (state.voiceSrc) try { state.voiceSrc.stop() } catch {}
      if (A) A.scratch.gain.value = 0
    },
    destroy() {
      this.stop()
      if (A) A.ac.close()
    }
  }
}

// ----------------------------------------------------------------------------- React card
const call = async (method, params = {}, timeout = 60000) => {
  const res = await host.request(`plugin.chalk.${method}`, params, timeout)
  if (!res || res.ok === false) throw new Error((res && res.error) || 'Chalk request failed')
  return res
}
function lessonIdOf(result) {
  try {
    const r = typeof result === 'string' ? JSON.parse(result) : result
    return r && r.lesson_id
  } catch {
    const m = /"lesson_id"\s*:\s*"([a-z0-9-]+)"/.exec(String(result || ''))
    return m && m[1]
  }
}
async function blobToChunks(blob, id) {
  const CH = 1_500_000
  const buf = new Uint8Array(await blob.arrayBuffer())
  let b64 = ''
  for (let i = 0; i < buf.length; i += 0x8000) b64 += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
  b64 = btoa(b64)
  const parts = Math.ceil(b64.length / CH)
  for (let k = 0; k < parts; k++) await call('save_chunk', { id, part: k, parts, data: b64.slice(k * CH, (k + 1) * CH) }, 120000)
  return call('save_video', { id, parts }, 600000)
}

function ChalkBoard({ id, fallback }) {
  const ref = useRef(null)
  const board = useRef(null)
  const [phase, setPhase] = useState('loading') // loading | ready | playing | done | recording | error
  const [msg, setMsg] = useState('')
  const [title, setTitle] = useState('')

  useEffect(() => {
    let dead = false
    call('lesson', { id })
      .then(res => {
        if (dead || !ref.current) return
        setTitle(res.lesson.title)
        const run = () => {
          board.current = createBoard(ref.current, res.lesson, res.audio)
          const b = board.current
          const fresh = !started.has(id) && Date.now() - Date.parse(res.lesson.created || 0) < 5 * 60_000
          if (fresh) started.set(id, performance.now() / 1000)
          const since = started.has(id) ? performance.now() / 1000 - started.get(id) : Infinity
          if (since < b.total) {
            // first showing, or the card remounted mid-lesson: carry on from where it is
            setPhase('playing')
            b.play(() => setPhase('done'), since).then(st => {
              if (st === 'suspended') setPhase('ready')
            })
          } else {
            board.current.still()
            setPhase('done')
          }
        }
        if (document.fonts && document.fonts.load) document.fonts.load(`40px "Ink Free"`).finally(run)
        else run()
      })
      .catch(e => {
        if (!dead) {
          setPhase('error')
          setMsg(String((e && e.message) || e))
        }
      })
    return () => {
      dead = true
      if (board.current) board.current.destroy()
    }
  }, [id])

  const play = () => {
    if (!board.current) return
    setPhase('playing')
    board.current.play(() => setPhase('done'))
  }
  const record = async () => {
    const b = board.current
    if (!b || typeof MediaRecorder === 'undefined') return
    b.ensureAudio()
    setPhase('recording')
    setMsg('Recording the lesson…')
    const types = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || ''
    const rec = new MediaRecorder(b.stream(), { mimeType: mime, videoBitsPerSecond: 9_000_000 })
    const chunks = []
    rec.ondataavailable = e => e.data && e.data.size && chunks.push(e.data)
    rec.onstop = async () => {
      setMsg('Saving video…')
      try {
        const res = await blobToChunks(new Blob(chunks, { type: 'video/webm' }), id)
        setMsg('Saved: ' + res.path)
        host.notify({ kind: 'success', message: 'Chalk video saved to ' + res.path })
      } catch (e) {
        setMsg('Could not save: ' + ((e && e.message) || e))
      }
      setPhase('done')
    }
    rec.start(1000)
    await b.play(() => setTimeout(() => rec.stop(), 400))
  }

  if (phase === 'error') return h('div', { className: 'flex flex-col gap-1' }, fallback, h('p', { className: 'text-xs text-(--ui-text-quaternary)' }, 'Chalk: ' + msg))

  const btn = (label, onClick, disabled) =>
    h('button', {
      onClick, disabled,
      className: 'rounded-md border border-(--ui-stroke-tertiary) px-2.5 py-1 text-xs text-(--ui-text-secondary) hover:bg-(--ui-fill-tertiary) disabled:opacity-40'
    }, label)

  return h('div', { className: 'my-2 flex flex-col gap-2', style: { width: '100%', maxWidth: 'min(820px, calc((100vh - 240px) * 1.7))' } },
    h('div', { className: 'relative overflow-hidden rounded-xl shadow-lg', style: { aspectRatio: '16 / 9', background: '#1d3028' } },
      h('canvas', { ref, width: W, height: H, style: { width: '100%', height: '100%', display: 'block' } }),
      phase === 'ready'
        ? h('button', {
            onClick: play,
            className: 'absolute inset-0 flex items-center justify-center bg-black/30 text-lg font-medium text-white'
          }, '▶  Play lesson')
        : null),
    h('div', { className: 'flex items-center gap-2' },
      h('span', { className: 'mr-auto truncate text-xs text-(--ui-text-tertiary)' }, title ? 'Chalk · ' + title : 'Chalk'),
      msg ? h('span', { className: 'truncate text-xs text-(--ui-text-quaternary)' }, msg) : null,
      btn(phase === 'playing' ? 'Playing…' : '↺ Replay', play, phase === 'playing' || phase === 'recording' || phase === 'loading'),
      btn('Save video', record, phase === 'playing' || phase === 'recording' || phase === 'loading')))
}

function ChalkMedia(props) {
  const id = lessonIdOf(props.result)
  if (!id) return props.fallback
  return h(ChalkBoard, { id, fallback: props.fallback })
}

export { createBoard, buildTimeline, compileFn }

export default {
  id: 'chalk',
  name: 'Chalk',
  register(ctx) {
    ctx.registerMany([
      { id: 'board', area: TOOL_MEDIA_RENDERER_AREA, data: { tools: ['chalk_teach'], render: props => h(ChalkMedia, props) } }
    ])
  }
}
