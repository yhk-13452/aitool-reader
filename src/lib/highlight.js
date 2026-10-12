import { Overlayer } from 'foliate-js/overlayer.js'
import { log } from './log.js'

// 用 foliate 的 overlayer 把书签画成高亮：跳回去时有视觉指认，iOS 上也不依赖原生选区
// （`view.select()` 走的是 getSelection，正是 T2 那条不可靠路径）。
//
// foliate 自己不给书签存东西，只认 `addAnnotation({ value: cfi, ... })` 的 value 当 key，
// 所以「同一个 CFI 只能有一条绘制」是它的既有行为，不是我们的选择。
// 段是随翻页装载/卸载的，必须听 `create-overlay` 在段回来时重画（上游 reader.js 同此）。
const COLOR = { bookmark: '#f0b354', highlight: '#6ecb8b' }

export function createHighlighter(view) {
    const byIndex = new Map()
    const byValue = new Map()

    const drawListener = e => {
        const { draw, annotation } = e.detail
        draw(annotation.outline ? Overlayer.outline : Overlayer.highlight,
            { color: COLOR[annotation.type] ?? COLOR.bookmark })
    }
    const createOverlayListener = e => {
        const list = byIndex.get(e.detail.index)
        if (list) for (const annotation of list) view.addAnnotation(annotation)
    }

    view.addEventListener('draw-annotation', drawListener)
    view.addEventListener('create-overlay', createOverlayListener)

    const push = (index, annotation) => {
        const list = byIndex.get(index)
        if (list) list.push(annotation)
        else byIndex.set(index, [annotation])
    }

    return {
        async add(value, type = 'bookmark') {
            if (byValue.has(value)) return byValue.get(value)
            const annotation = { value, type }
            // CFI 解析不了时上游 addAnnotation 会在解构处抛错（resolveNavigation 吞异常返回 undefined）
            let obj = null
            try {
                obj = await view.addAnnotation(annotation)
            } catch (e) {
                log.warn('高亮定位失败', { value, reason: String(e?.message ?? e) })
                return null
            }
            // 段还没装载时 obj.index 照样有值（overlayer 那步被跳过），先记账，
            // 等 create-overlay 再画；只有整条 CFI 解不出来才返回 undefined
            if (!obj) {
                log.warn('高亮定位失败：CFI 无法解析', { value })
                return null
            }
            // 段号只在这个返回值里有，得挂到 annotation 上，卸载/删除时才找得回来
            annotation.index = obj.index
            byValue.set(value, annotation)
            push(obj.index, annotation)
            return annotation
        },
        remove(value) {
            const annotation = byValue.get(value)
            if (!annotation) return
            byValue.delete(value)
            const list = byIndex.get(annotation.index)
            if (list) {
                const i = list.indexOf(annotation)
                if (i >= 0) list.splice(i, 1)
            }
            view.deleteAnnotation(annotation).catch(e => log.warn('清除高亮失败', e))
        },
        replaceAll(values) {
            for (const value of [...byValue.keys()]) if (!values.includes(value)) this.remove(value)
            for (const value of values) this.add(value).catch(e => log.warn('高亮绘制失败', { value, e }))
        },
        // 改写 Text.nodeValue 会把锚在这个文本节点上的 Range 折叠成 collapsed（实测：同一个
        // Range 从 5 个 rect 变成 1 个 0 宽 rect）。简繁切换正是改 nodeValue，所以切完必须
        // 用 CFI 重新解析一遍 —— overlayer 存的那条旧 Range 画出来是看不见的空气高亮。
        refresh() {
            for (const annotation of byValue.values()) {
                // addAnnotation 内部会先 overlayer.remove(value) 再用新 Range 画，重复调用安全
                view.addAnnotation(annotation).catch(e => log.warn('高亮重画失败',
                    { value: annotation.value, reason: String(e?.message ?? e) }))
            }
        },
        dispose() {
            view.removeEventListener('draw-annotation', drawListener)
            view.removeEventListener('create-overlay', createOverlayListener)
            byIndex.clear()
            byValue.clear()
        },
    }
}
