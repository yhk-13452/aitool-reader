import { log } from './log.js'
import { getReading, putReading, listReading } from './db.js'

const TICK_MS = 1000
// iOS 该杀就杀，攒久了这一段时长就没了；30 秒一次写入换掉最多半分钟的误差
const FLUSH_MS = 30_000

const pad = n => String(n).padStart(2, '0')
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

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

// 年视角：12 个月全列出来（没读的月显示 0），每个月再往下摊到具体某本书。
// 整表读出来在内存里聚合：记录条数是「书数 × 读过的天数」，量级很小，不值得为它建索引。
export async function readingYear(year, shelf) {
    const all = await listReading()
    // 书名与书架用同一套显示名（撞名时带文件名后缀），否则统计里的行对不上书架
    const nameOf = new Map(shelf.map(b => [b.id, b.display ?? b.title ?? b.name]))
    const years = new Set([new Date().getFullYear()])
    const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ms: 0, byBook: new Map() }))

    for (const record of all ?? []) {
        const y = Number(String(record.day).slice(0, 4))
        const m = Number(String(record.day).slice(5, 7))
        if (Number.isFinite(y)) years.add(y)
        // 书已经不在书架上（老数据没清干净）就不计入，也别把幽灵书名显示出来
        if (y !== year || m < 1 || m > 12 || !nameOf.has(record.bookId)) continue
        const bucket = months[m - 1]
        bucket.ms += record.ms ?? 0
        bucket.byBook.set(record.bookId, (bucket.byBook.get(record.bookId) ?? 0) + (record.ms ?? 0))
    }

    return {
        year,
        years: [...years].sort((a, b) => b - a),
        total: months.reduce((sum, m) => sum + m.ms, 0),
        months: months.map(m => ({
            month: m.month,
            ms: m.ms,
            books: [...m.byBook]
                .map(([id, ms]) => ({ id, name: nameOf.get(id), ms }))
                .sort((a, b) => b.ms - a.ms),
        })),
    }
}
