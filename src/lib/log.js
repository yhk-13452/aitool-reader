// 应用内 debug 日志环。日常流程是本机写码 → GitHub Pages → 手机直测，
// 手机不连 Mac 就没有 Safari Web Inspector，所以日志环是把 iOS 现场带回来的主手段。
const MAX = 500

// ResizeObserver 的「loop completed with undelivered notifications」是浏览器实现层面的
// 良性告警（paginator 靠 RO 分页，每次重排都可能刷一条），foliate 会把它打到 console.error。
// 留着它会在一两页内把日志环刷满，真机上把真正的证据挤掉，所以直接不收。
const IGNORE = [/ResizeObserver loop/]

function ignored(text) {
    return IGNORE.some(re => re.test(text))
}

const entries = []
let seq = 0
const listeners = new Set()

function push(level, args) {
    const text = args.map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' ')
    if (ignored(text)) return null
    const last = entries[entries.length - 1]
    if (last && last.level === level && last.text === text) {
        last.count++
        listeners.forEach(fn => fn())
        return last
    }
    const entry = { id: ++seq, level, text, at: new Date().toISOString(), count: 1 }
    entries.push(entry)
    if (entries.length > MAX) entries.shift()
    listeners.forEach(fn => fn())
    return entry
}

export const log = {
    info: (...a) => push('info', a),
    warn: (...a) => push('warn', a),
    error: (...a) => push('error', a),
    all: () => entries.slice(),
    clear: () => { entries.length = 0; listeners.forEach(fn => fn()) },
    subscribe(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
    },
}

let installed = false
export function installConsoleCapture() {
    if (installed) return
    installed = true
    for (const level of ['info', 'warn', 'error']) {
        const original = console[level].bind(console)
        console[level] = (...args) => { push(level, args); original(...args) }
    }
    window.addEventListener('error', e => push('error', [e.message, e.error]))
    window.addEventListener('unhandledrejection', e => push('error', ['unhandledrejection', e.reason]))
}
