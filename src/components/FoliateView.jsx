import { useEffect, useRef } from 'react'
import 'foliate-js/view.js'
import { log } from '../lib/log.js'
import { describeOpenError, openBook } from '../lib/book.js'

// 正文在 iframe 里，点击/选区的坐标是 iframe 视口坐标，浮层要贴在宿主视口上，
// 所以统一经 frameElement 换算一次。sandbox 带 allow-same-origin，这个访问是允许的。
const hostBox = (win, rect) => {
    const frame = win?.frameElement?.getBoundingClientRect?.()
    if (!frame) return null
    return {
        top: frame.top + rect.top,
        left: frame.left + rect.left,
        width: rect.width,
        height: rect.height,
    }
}

// 排版样式由 src/lib/typography.js 生成后从 props 传进来：这里只负责塞给 renderer，
// 不在组件里留一份默认值，避免两处各写一套、改一处忘另一处。
// 本组件不持有任何界面状态：点击热区、抽屉、工具条的归属都在 App，这里只把原始事件换好坐标报上去。
export default function FoliateView({
    file, initialLocation, readerCss, onTap, onKey, onSelection, onView, onError, onRelocate,
}) {
    const hostRef = useRef(null)
    const viewRef = useRef(null)
    // 每次渲染刷新即可，不进 effect 依赖：把它放进去会连带重建 foliate-view，
    // 而重建 = 重新解一遍整本书
    const tapRef = useRef(null)
    tapRef.current = onTap
    const keyRef = useRef(null)
    keyRef.current = onKey
    const selRef = useRef(null)
    selRef.current = onSelection
    const relocateRef = useRef(null)
    relocateRef.current = onRelocate
    const locationRef = useRef(null)
    locationRef.current = initialLocation ?? null
    const cssRef = useRef(readerCss)
    cssRef.current = readerCss

    // 改字号/行距不重建阅读器（那是整本重解一遍），只换样式表；但重新分页会让落点飘，
    // 所以换完用当前 CFI 再定位一次，用户看到的还是同一句话。
    useEffect(() => {
        const view = viewRef.current
        if (!view || !readerCss) return
        view.renderer?.setStyles?.(readerCss)
        const here = view.lastLocation?.cfi
        if (here) view.goTo(here).catch(e => log.warn('排版调整后回位失败', e))
    }, [readerCss])

    useEffect(() => {
        const host = hostRef.current
        if (!host || !file) return

        const view = document.createElement('foliate-view')
        viewRef.current = view
        host.append(view)
        let disposed = false
        let lastSection

        const fail = err => {
            if (disposed) return
            log.error('打开书籍失败', err)
            onError({ ...describeOpenError(err), raw: String(err?.stack ?? err) })
        }

        view.addEventListener('load', e => {
            log.info('章节已加载', { index: e.detail.index })
            const doc = e.detail.doc
            const win = doc.defaultView

            // 正文在 iframe 里，点击不会冒泡到宿主文档，只能逐段挂监听（foliate 自己也这么做）
            doc.addEventListener('click', ev => {
                const frame = win?.frameElement?.getBoundingClientRect?.()
                if (!frame) return
                tapRef.current?.({ x: frame.left + ev.clientX, y: frame.top + ev.clientY, target: ev.target })
            })
            // 焦点在 iframe 里时宿主收不到按键，键盘翻页得从正文这边转出去
            doc.addEventListener('keydown', ev => keyRef.current?.(ev.key))

            // 拖选过程中 selectionchange 每帧都来，包围盒和文字长度没变就不往上报。
            // 应用内日志环只有 500 条，是给真机排障留证据的预算，所以一次手势只记两条：
            // 冒头那条（证明系统把选区报上来了）和收起那条（选区自己没了 / 被点掉了），
            // 中间的坐标漂移不占环。
            let lastKey
            let boxReported = false
            const report = () => {
                const sel = win?.getSelection?.()
                const range = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
                if (!range) {
                    if (lastKey === null) return
                    lastKey = null
                    if (boxReported) {
                        boxReported = false
                        log.info('选区已收起')
                    }
                    selRef.current?.(null)
                    return
                }
                const box = hostBox(win, range.getBoundingClientRect())
                if (!box) {
                    if (boxReported) return
                    boxReported = true
                    log.warn('选区坐标算不出来', { len: sel.toString().length })
                    return
                }
                const text = sel.toString()
                const key = `${Math.round(box.left)},${Math.round(box.top)},`
                    + `${Math.round(box.width)},${Math.round(box.height)},${text.length}`
                if (key === lastKey) return
                lastKey = key
                if (!boxReported) {
                    boxReported = true
                    log.info('选区上报', {
                        l: Math.round(box.left), t: Math.round(box.top),
                        w: Math.round(box.width), h: Math.round(box.height), len: text.length,
                    })
                }
                selRef.current?.({ ...box, text })
            }

            doc.addEventListener('selectionchange', report)
            // iOS 长按选字之后 selectionchange 未必会补最后一次（选区手柄落定常在 pointerup 之后），
            // 所以 pointerup 再兜一次
            doc.addEventListener('pointerup', report)
        })

        // relocate 只能从 renderer 上听，不能听 view 转发的：view 转出去的 detail 把 reason 丢了
        // （view.js:316 组装 lastLocation 时没带上它），而「读者自己翻页」和「goTo 跳转」的区分
        // 就靠这一个字段（paginator.js：翻页 page/snap，跳转 navigation，重排恢复 anchor）。
        // view 自己的监听器在 open() 里先注册（view.js:250），所以这里读 lastLocation 已是新值。
        const onRendererRelocate = e => {
            const detail = { ...view.lastLocation, reason: e.detail.reason }
            // 页码：优先从**这一条事件自己带的数**反算，不去读 renderer 的实时 getter。
            // paginator 报的是 fraction = (page-1)/(pages-2)、size = 1/(pages-2)（paginator.js:996-1004），
            // 反过来就是 pages = 2 + 1/size、page = 1 + fraction/size —— 与界面那个百分比同源，
            // 不会出现「百分比是刚才那次 relocate 的、页码是待会儿布局完的」两帧错位。
            // 读实时 getter 的旧写法在跳章后就报过 page 1 配 fraction 1，就是这种错位。
            const { fraction: fracIn, size } = e.detail ?? {}
            let page = null
            if (view.isFixedLayout && detail.section) {
                // 固定版式（CBZ 漫画、pre-paginated EPUB）每张图就是一个 section，序号即页码，
                // 而且是全书精确值（comic-book.js:48-53）。必须先判这一支：fxl 的 relocate 也带
                // fraction/size（fixed-layout.js:251-253 恒为 0 与 1），拿上面那个式子反算会永远得到
                // 「1/3」，与图片张数无关 —— 五张图的夹具就是这么暴露出来的。
                page = { current: detail.section.current + 1, total: detail.section.total }
            } else if (typeof size === 'number' && size > 0 && typeof fracIn === 'number') {
                const total = Math.round(2 + 1 / size)
                // 上游的 fraction 定义在章末会越界（实测过 1.1176 那一类），页码一律夹进 [1, total]
                const current = Math.min(Math.max(Math.round(1 + fracIn / size), 1), total)
                page = { current, total }
            } else if (typeof e.target?.page === 'number' && typeof e.target?.pages === 'number'
                && e.target.pages > 0) {
                // 兜底：真拿不到 size 的场合（比如 flow=scrolled）再读实时 getter
                page = { current: e.target.page, total: e.target.pages }
            }
            detail.page = page
            relocateRef.current?.(detail)
            // 翻页很频繁，逐条记会把日志环（MAX=500）冲掉，真机上反而看不到关键证据；
            // 只有换段才值得记录，页内进度底部浮层实时显示就够用了
            const current = detail.section?.current
            if (current === undefined || current !== lastSection) {
                lastSection = current
                log.info('换段', {
                    section: current,
                    total: detail.section?.total,
                    fraction: detail.fraction?.toFixed?.(4),
                    tocItem: detail.tocItem?.label,
                    reason: detail.reason,
                })
            }
        }

        ;(async () => {
            await openBook(view, file)
            if (disposed) return
            view.renderer.addEventListener('relocate', onRendererRelocate)
            if (cssRef.current) view.renderer.setStyles?.(cssRef.current)
            // 上游 paginator 默认给正文上下各让 48px（#top 的 --_margin），收起菜单后
            // 那就是屏幕边上两条空带。归零让正文真铺满；状态栏与底部横条的避让改由
            // .reader-host 的 safe-area 内边距负责。
            view.renderer.setAttribute?.('margin', '0')
            // 有上次位置就回到那里，没有则跳过 nav / 封面等非正文段落到正文起点
            const last = locationRef.current
            let restored = last
            if (last) {
                try {
                    await view.init({ lastLocation: last })
                } catch (e) {
                    // 位置串失效不该让整本书看起来「打不开」：退回正文起点
                    log.warn('恢复上次位置失败，从正文起点打开', { last, reason: String(e?.message ?? e) })
                    restored = null
                    await view.init({ showTextStart: true })
                }
            } else {
                await view.init({ showTextStart: true })
            }
            if (disposed) return
            log.info('阅读器初始化完成', { restored })
            onView?.(view, file, restored)
        })().catch(fail)

        return () => {
            disposed = true
            if (viewRef.current === view) viewRef.current = null
            try { view.close() } catch (e) { log.warn('关闭书籍失败', e) }
            view.remove()
        }
        // 换书走卸载重建：paginator 的 iframe 池复用容易残留上一章的状态
    }, [file])

    return <div className="reader-host" ref={hostRef} />
}
