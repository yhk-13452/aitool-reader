import { log } from './log.js'
import { getReading, putReading, listReading } from './db.js'

const TICK_MS = 1000
// iOS 该杀就杀，攒久了这一段时长就没了；30 秒一次写入换掉最多半分钟的误差
const FLUSH_MS = 30_000

const pad = n => String(n).padStart(2, '0')
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// 记录里的 day 是 'YYYY-MM-DD'。必须按「年月日三段」构造日期：
// 交给 Date 解析整串走的是 UTC，在东八区会整体偏后一天，周就归错组（实测过这类偏移）。
const dayParts = key => String(key).split('-').map(Number)
// 一周从周一算起（`(getDay()+6)%7`：周日 0 → 6，周一 1 → 0）
const mondayOf = key => { const [y, m, d] = dayParts(key); const date = new Date(y, m - 1, d); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return date }
const mondayKey = key => dayKey(mondayOf(key))
const md = key => { const p = dayParts(key); return `${pad(p[1])}-${pad(p[2])}` }

// 阅读计时只在「书打开着 + 这一页在前台可见」时累计。
// 自检浮层盖住阅读区、回书架、切到别的 App 都不算在读 —— 统计要是不挑场景，数字就没意义。
export function createReadingTracker(bookId) {
    let pending = 0
    let tick = 0
    let flush = 0
    let last = Date.now()

    async function save() {
        if (pending <= 0) return
        const add = pending
        pending = 0
        const day = dayKey(new Date())
        const id = `${bookId}|${day}`
        try {
            const existing = await getReading(id)
            await putReading({ id, bookId, day, ms: (existing?.ms ?? 0) + add, updated: Date.now() })
        } catch (e) {
            pending += add
            log.warn('阅读时长写入失败', e)
        }
    }

    const onHide = () => { save() }

    return {
        start() {
            if (tick) return
            last = Date.now()
            tick = setInterval(() => {
                const now = Date.now()
                if (document.visibilityState === 'visible') pending += now - last
                // 隐藏期间的间隔直接丢掉，下次可见重新起算
                last = now
            }, TICK_MS)
            flush = setInterval(save, FLUSH_MS)
            addEventListener('pagehide', onHide)
        },
        async stop() {
            clearInterval(tick)
            clearInterval(flush)
            tick = flush = 0
            removeEventListener('pagehide', onHide)
            await save()
        },
    }
}

export function fmtDuration(ms) {
    const sec = Math.max(0, Math.round((ms ?? 0) / 1000))
    if (sec < 60) return `${sec} 秒`
    const h = Math.floor(sec / 3600)
    const m = Math.floor(sec % 3600 / 60)
    return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`
}

// 书名与书架用同一套显示名（撞名时带文件名后缀），否则统计里的行对不上书架。
// 这一条是唯一的取名处：App 的「按书合计」也走它，不自己再拼一遍。
export const bookDisplayName = b => b.display ?? b.title ?? b.name

// 年视角：12 个月全列出来（没读的月显示 0），每个月往下摊到「自然周」与具体某本书。
// 整表读出来在内存里聚合：记录条数是「书数 × 读过的天数」，量级很小，不值得为它建索引。
export async function readingYear(year, shelf) {
    const all = await listReading()
    const nameOf = new Map(shelf.map(b => [b.id, bookDisplayName(b)]))
    const years = new Set([new Date().getFullYear()])
    const months = Array.from({ length: 12 }, (_, i) => ({
        month: i + 1, ms: 0, byBook: new Map(), byWeek: new Map(),
    }))

    for (const record of all ?? []) {
        const y = Number(String(record.day).slice(0, 4))
        const m = Number(String(record.day).slice(5, 7))
        if (Number.isFinite(y)) years.add(y)
        // 书已经不在书架上（老数据没清干净）就不计入，也别把幽灵书名显示出来
        if (y !== year || m < 1 || m > 12 || !nameOf.has(record.bookId)) continue
        const bucket = months[m - 1]
        const ms = record.ms ?? 0
        bucket.ms += ms
        bucket.byBook.set(record.bookId, (bucket.byBook.get(record.bookId) ?? 0) + ms)
        // 周按周一起算，跨月那一周在本月只计本月的那几天（月内的区间标签会跟着截断）
        const wk = mondayKey(record.day)
        const week = bucket.byWeek.get(wk) ?? { start: wk, from: record.day, to: record.day, ms: 0, byBook: new Map() }
        if (record.day < week.from) week.from = record.day
        if (record.day > week.to) week.to = record.day
        week.ms += ms
        week.byBook.set(record.bookId, (week.byBook.get(record.bookId) ?? 0) + ms)
        bucket.byWeek.set(wk, week)
    }

    const toBooks = map => [...map]
        .map(([id, ms]) => ({ id, name: nameOf.get(id), ms }))
        .sort((a, b) => b.ms - a.ms)

    // 本年按书合计：面板要单独列一节，组件里再拿 12 个月去累加就会有两套口径
    const yearBooks = new Map()
    for (const m of months) {
        for (const [id, ms] of m.byBook) yearBooks.set(id, (yearBooks.get(id) ?? 0) + ms)
    }

    return {
        year,
        years: [...years].sort((a, b) => b - a),
        total: months.reduce((sum, m) => sum + m.ms, 0),
        books: toBooks(yearBooks),
        months: months.map(m => ({
            month: m.month,
            ms: m.ms,
            books: toBooks(m.byBook),
            weeks: [...m.byWeek.values()]
                .sort((a, b) => a.start < b.start ? -1 : 1)
                .map(w => ({
                    start: w.start,
                    // 只显示两位日，年份在同一张面板里是定的；跨月的周在这里就看得出被截断
                    label: w.from === w.to ? md(w.from) : `${md(w.from)}–${md(w.to)}`,
                    ms: w.ms,
                    books: toBooks(w.byBook),
                })),
        })),
    }
}

// 每本书在**当前书架上**的累计阅读时长（不限年份）。书架卡片要的就是这一件事：
// 这本书我一共读了多久。与 readingYear 同一份数据源，但别混着用 —— 一个是年内、一个是全架。
export async function readingTotalsByBook() {
    const all = await listReading()
    const totals = new Map()
    for (const record of all ?? []) {
        totals.set(record.bookId, (totals.get(record.bookId) ?? 0) + (record.ms ?? 0))
    }
    return totals
}
