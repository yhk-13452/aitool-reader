import { log } from './log.js'

// 简繁切换只做「显示层」的替换，而且只改 Text node 的 nodeValue：
// 不重建 DOM、不动属性，这样书签与进度用的 CFI 字符偏移才不会因为结构变化而漂。
//
// 关键约束：转换后长度必须和原文一致。CFI 里 `/1:36` 指的就是文本节点内的第 36 个字符，
// 长度一变，已有书签和稍后算出的书签位置就全错位。所以长度不一致的节点直接不转换，
// 保持原文字形显示，并把数量如实报给用户 —— 混排比错位诚实。
export const SCRIPT_MODES = [
    { key: 'orig', label: '原文' },
    { key: 'cn', label: '简体' },
    { key: 'tw', label: '繁体' },
]

const SKIP = 'script, style, noscript, template, svg, foreignObject'

function textNodesOf(root) {
    const walker = root.ownerDocument
        ? root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: n => {
                if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT
                if (n.parentElement?.closest(SKIP)) return NodeFilter.FILTER_REJECT
                return NodeFilter.FILTER_ACCEPT
            },
        })
        : null
    const out = []
    if (!walker) return out
    while (walker.nextNode()) out.push(walker.currentNode)
    return out
}

export function createScriptSwitcher(view) {
    // 只记被改过的节点：没进 originals 的节点，nodeValue 本身就是原文
    const originals = new WeakMap()
    const tracked = new Map()
    const waiting = new Map()
    let worker = null
    let msgId = 0
    let applySeq = 0
    let mode = 'orig'
    let disposed = false

    function ensureWorker() {
        if (worker) return worker
        worker = new Worker(new URL('./script.worker.js', import.meta.url), { type: 'module' })
        worker.onmessage = ({ data }) => {
            const settle = waiting.get(data.id)
            waiting.delete(data.id)
            if (!settle) return
            if (data.ok) settle.resolve(data.out)
            else settle.reject(new Error(data.error))
        }
        worker.onerror = e => log.error('简繁转换 Worker 出错', e.message || e)
        return worker
    }

    function convert(texts, to) {
        const id = ++msgId
        return new Promise((resolve, reject) => {
            waiting.set(id, { resolve, reject })
            ensureWorker().postMessage({ id, to, texts })
        })
    }

    function restore(doc) {
        for (const node of tracked.get(doc) ?? []) {
            const orig = originals.get(node)
            if (orig != null && node.nodeValue !== orig) node.nodeValue = orig
        }
    }

    // 返回因长度不一致而保持原文的节点数；-1 表示这次结果已过期（用户又点了一次）
    async function applyDoc(doc) {
        restore(doc)
        if (mode === 'orig') {
            tracked.delete(doc)
            return 0
        }
        const nodes = textNodesOf(doc.documentElement ?? doc)
        const texts = nodes.map(n => n.nodeValue)
        const token = ++applySeq
        let out
        try {
            out = await convert(texts, mode)
        } catch (e) {
            log.error('简繁转换失败', e)
            return 0
        }
        if (disposed || token !== applySeq) return -1
        let unsafe = 0
        for (let i = 0; i < nodes.length; i++) {
            const src = texts[i]
            const dst = out[i]
            if (dst === src) continue
            if (dst?.length !== src.length) {
                unsafe++
                continue
            }
            originals.set(nodes[i], src)
            nodes[i].nodeValue = dst
        }
        tracked.set(doc, nodes.filter(n => originals.has(n)))
        return unsafe
    }

    async function setMode(next) {
        mode = next
        let unsafe = 0
        // 一本一本段接着转：并发打同一个 Worker 只会让先发的请求变成过期响应白跑一趟
        for (const { doc } of view.renderer.getContents()) {
            const result = await applyDoc(doc)
            if (result > 0) unsafe += result
        }
        view.renderer.render?.()
        log.info('简繁显示已切换', { mode: next, unsafe })
        return unsafe
    }

    const originalOf = node => originals.get(node) ?? node.nodeValue

    // 界面上显示的可能是转换后的字形，书签存的文本必须是原始字形：
    // 否则切回原文（或换一台设备）时，书签文字和正文一个字都对不上
    function textOf(subject) {
        // 跨 iframe 的 Range 不一定 instanceof 主文档的 Range，按属性判断
        const isRange = subject && subject.commonAncestorContainer != null && 'startOffset' in subject
        if (!isRange) {
            const nodes = textNodesOf(subject)
            if (nodes.length === 0) return subject.textContent ?? ''
            return nodes.map(originalOf).join('')
        }
        // commonAncestorContainer 自己就是文本节点时，TreeWalker 走不出任何节点
        const same = subject.startContainer === subject.endContainer
        if (same && same.nodeType === 3) {
            return originalOf(same).slice(subject.startOffset, subject.endOffset)
        }
        const parts = []
        for (const node of textNodesOf(subject.commonAncestorContainer)) {
            if (!subject.intersectsNode(node)) continue
            const text = originalOf(node)
            const from = subject.startContainer === node ? subject.startOffset : 0
            const to = subject.endContainer === node ? subject.endOffset : text.length
            if (to > from) parts.push(text.slice(from, to))
        }
        if (parts.length === 0) return subject.toString()
        return parts.join('')
    }

    const onLoad = e => {
        if (mode === 'orig') return
        applyDoc(e.detail.doc).then(unsafe => {
            if (unsafe > 0) log.warn('新载入段落有文字保持原文', { index: e.detail.index, unsafe })
        })
    }
    view.addEventListener('load', onLoad)

    // 书签列表里的文字不在 DOM 上，改不了 nodeValue，只能单独送 Worker 转一次。
    // 存的一直是原始字形（见 textOf），这里只是换一种显示；转换失败就退回原文，
    // 宁可混排也不显示空白。
    async function forDisplay(texts) {
        if (mode === 'orig' || texts.length === 0) return texts
        try {
            const out = await convert(texts, mode)
            return out.map((x, i) => (typeof x === 'string' && x.length === texts[i].length ? x : texts[i]))
        } catch (e) {
            log.warn('书签列表转换失败，显示原始字形', e)
            return texts
        }
    }

    return {
        get mode() { return mode },
        setMode,
        textOf,
        forDisplay,
        dispose() {
            disposed = true
            view.removeEventListener('load', onLoad)
            worker?.terminate()
            worker = null
            tracked.clear()
            waiting.clear()
        },
    }
}
