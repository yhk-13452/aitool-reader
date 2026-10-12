import { log } from './log.js'

// 从 foliate-view 里取当前选区并算出 CFI。
// iOS 上 iframe 内的 getSelection() 有已知破损（真机待测项 T2），所以这里把每一步的实际情况
// 都记进日志环：真机上长按选字后点「收藏」，即使手机没连 Mac 挂 Web Inspector，日志也能带出结论。
// textOf 由简繁切换器提供：屏幕上显示的可能是转换后的字形，书签必须存原始字形，
// 否则切回原文（或换设备）时书签文字和正文一个字都对不上。
export function captureSelection(view, textOf) {
    const contents = view.renderer?.getContents?.() ?? []
    const seen = contents.map(c => {
        const sel = c.doc?.defaultView?.getSelection?.()
        return {
            index: c.index,
            hasDoc: !!c.doc,
            rangeCount: sel?.rangeCount ?? -1,
            collapsed: sel ? sel.isCollapsed : null,
            length: sel ? sel.toString().length : -1,
        }
    })

    const hit = contents.find(c => {
        const sel = c.doc?.defaultView?.getSelection?.()
        return sel && !sel.isCollapsed && sel.rangeCount > 0
    })

    if (!hit) {
        const reason = contents.length === 0 ? '没有已加载的分页内容'
            : seen.every(s => s.rangeCount === 0) ? '所有 iframe 的 selection 都是空的'
            : 'selection 处于 collapsed（未选中）状态'
        log.warn('选区捕获失败', { reason, contents: seen })
        return { ok: false, reason }
    }

    const sel = hit.doc.defaultView.getSelection()
    const range = sel.getRangeAt(0)
    const text = textOf?.(range) ?? sel.toString()
    let cfi = null
    try {
        cfi = view.getCFI(hit.index, range)
    } catch (e) {
        log.error('CFI 计算失败', e)
        return { ok: false, reason: `getCFI 抛错：${e.message}` }
    }
    log.info('选区捕获成功', { index: hit.index, length: text.length, cfi })
    return { ok: true, index: hit.index, text, cfi }
}

// 收起所有已加载分页里的选区。浮层工具条点「取消」、翻页、跳章节都要用它 ——
// 选区还挂着时正文上的点击只该用来收选区，不该顺手翻一页。
export function clearSelections(view) {
    for (const c of view?.renderer?.getContents?.() ?? []) {
        try {
            c.doc?.defaultView?.getSelection?.()?.removeAllRanges()
        } catch (e) {
            log.warn('清除选区失败', { index: c.index, reason: String(e?.message ?? e) })
        }
    }
}

// 不依赖原生选区的创建路径：点正文块级元素，整段收藏。
// iOS 上 iframe 内的 getSelection() 可靠性是待测项 T2，长按选字可能整条走不通，
// 所以必须有这条只靠 click + Range over 元素就能生成 CFI 的退路。
const BLOCK = 'p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, pre'

// Range 必须锚在文本节点上，不能锚在元素上。
// selectNodeContents(el) 的起止容器是 el 自己（offset 0 / 1），foliate 的 fromRange 会把它写成
// 元素锚点串（`,/14[x3],/14[x3]`）；解析回来时 partsToNode 按 id 找到元素、两端都返回
// {node: el, offset: 0}，得到 collapsed Range → 0 个 client rect → 高亮是一个宽度 0 的 rect，
// 书签在列表里能跳转但屏幕上看不见。
// 改成 (首个文本节点, 0)-(末个文本节点, 其长度) 后 CFI 带字符偏移（`,/1:0,/1:123`），有 rect。
function innerTextRange(doc, el) {
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    })
    let first = null
    let last = null
    while (walker.nextNode()) {
        if (!first) first = walker.currentNode
        last = walker.currentNode
    }
    if (!first) return null
    const range = doc.createRange()
    range.setStart(first, 0)
    range.setEnd(last, last.nodeValue.length)
    return range
}

export function captureParagraph(view, target, textOf) {
    const contents = view.renderer?.getContents?.() ?? []
    // 链接交给阅读器自己跳转：点链接不是「收藏失败」，别弹报警条
    if (target?.closest?.('a[href]')) {
        log.info('点到链接，不收藏', { href: target.closest('a[href]').getAttribute('href') })
        return { ok: false, silent: true, reason: '点到了链接，已交给阅读器跳转' }
    }
    const el = target?.closest?.(BLOCK)
    if (!el) return { ok: false, reason: '点到的不是正文段落（图片或非文本元素）' }

    const doc = el.ownerDocument
    const hit = contents.find(c => c.doc === doc)
    if (!hit) {
        log.warn('整段捕获失败：该段不在渲染池里', { contents: contents.map(c => c.index) })
        return { ok: false, reason: '这一页刚被回收，翻回来再点一次' }
    }

    const text = (textOf?.(el) ?? el.textContent).replace(/\s+/g, ' ').trim()
    if (!text) return { ok: false, reason: '这段没有文字（可能是图片段）' }

    const range = innerTextRange(doc, el)
    if (!range) return { ok: false, reason: '这段没有可定位的文字节点' }

    let cfi = null
    try {
        cfi = view.getCFI(hit.index, range)
    } catch (e) {
        log.error('CFI 计算失败', e)
        return { ok: false, reason: `getCFI 抛错：${e.message}` }
    }
    log.info('整段捕获成功', { index: hit.index, tag: el.tagName, length: text.length, cfi })
    return { ok: true, index: hit.index, text, cfi, tag: el.tagName }
}
