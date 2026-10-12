// iOS 从主屏冷启动时会把布局视口算短一截，屏幕底下那条「黑边」其实是系统涂在
// **视口之外**的 manifest background_color —— 我们的元素根本画不进去。
// 真机量到的形状（375 × 812 的机子，innerHeight 768）：缺的正好是状态栏那 44，
// 而 `env()` 照样报上 44 / 下 31 —— 样式层以为内容铺满、布局层没有。
// 转屏能立刻治好（= 一次真 resize），所以问题出在启动那一次布局，不在 CSS。
//
// 两条硬约束，都是从真机上踩回来的：
// ① 只在确实算矮了的时候动手（见 viewportIsShort）；
// ② 视口定下来之前不要把界面画出来。绘制之后再改 viewport，iOS 会出现
//    「菜单条画在这里、点击落在那儿」的坐标错位 —— 白边没了换来点不动的按钮，更糟。

let report = null

export const viewportReport = () => report

const px = v => Math.round(parseFloat(v) || 0)

// env() 的真实数值只能从计算样式里读出来，所以临时挂一个探针元素
export const safeInsets = () => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden'
    probe.style.paddingTop = 'env(safe-area-inset-top)'
    probe.style.paddingRight = 'env(safe-area-inset-right)'
    probe.style.paddingBottom = 'env(safe-area-inset-bottom)'
    probe.style.paddingLeft = 'env(safe-area-inset-left)'
    document.documentElement.append(probe)
    const cs = getComputedStyle(probe)
    const out = {
        top: px(cs.paddingTop),
        right: px(cs.paddingRight),
        bottom: px(cs.paddingBottom),
        left: px(cs.paddingLeft),
    }
    probe.remove()
    return out
}

export const measureViewport = () => ({
    screenPt: [window.screen.width, window.screen.height],
    dpr: window.devicePixelRatio,
    innerH: window.innerHeight,
    clientH: document.documentElement.clientHeight,
    visualH: window.visualViewport ? Math.round(window.visualViewport.height) : null,
    meta: document.querySelector('meta[name="viewport"]')?.content ?? null,
    insets: safeInsets(),
})

// 视口比屏幕矮，就是「底下有条涂不出去的边」那个样子（两个数都是 CSS px / pt）
export const viewportIsShort = () => window.screen.height - window.innerHeight > 1

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches

// 矮下来那截归系统，home indicator 其实落在我们画不到的地方 —— 这时再按 env() 给底部
// 留 31px，就是白让正文少一截、底栏还往上飘。用这个类把底部让边收掉。
const markShort = () => document.documentElement.classList
    .toggle('vp-short', isStandalone() && viewportIsShort())

// 转屏、软键盘、回到前台都会改视口，这个类必须跟着重算：修好之后还留着它，
// 就会把真正需要的 home indicator 让边也一起吃掉
addEventListener('resize', markShort)

// rAF 在隐藏页里不跑，所以配一个定时器兜底，别让 promise 永远悬着
const settle = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 250)
    requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
    }))
})

const forceLayout = () => void document.documentElement.getBoundingClientRect()

// 真机（375×812，iOS 主屏 App）量到 innerHeight=768，缺的 44 正好是状态栏高度，
// 而 env() 又报告上 44 / 下 31 —— 样式层以为铺满、布局层没有。转屏立刻就好，
// 说明缺一次「让 WebKit 重新算视口」的动作。
//
// 第一条已试的手段（改 meta.content 再改回来）在真机上量出 +0，**已证伪**。
// 所以这里把剩下的候选一次排完：每条自己跑一帧，视口够高就停，
// 前后数值全部留在 viewportReport() 里，由自检面板带回桌面 —— 本机没有 iOS，
// 哪种有效只能让真机说话。
const LEVERS = [
    ['改 meta 内容再改回', (meta, content) => {
        meta.content = content.replace(/,\s*viewport-fit=cover/, '')
        forceLayout()
        meta.content = content
    }],
    ['把 meta 摘掉再插回', (meta, content, host, next) => {
        meta.remove()
        forceLayout()
        host.insertBefore(meta, next)
    }],
    ['缩放抖一下', (meta, content) => {
        meta.content = content.replace(/initial-scale=[\d.]+/, 'initial-scale=0.999')
        forceLayout()
        meta.content = content
    }],
    // 动态视口是 WebKit 在滚动时才重算的那一套：把文档临时撑高一点再滚一下
    ['撑高一点再滚一下', () => {
        const html = document.documentElement
        const prev = html.style.minHeight
        html.style.minHeight = `${window.screen.height + 8}px`
        window.scrollTo(0, 8)
        window.scrollTo(0, 0)
        html.style.minHeight = prev
    }],
]

// 在 React 挂载之前调用完，首屏就不会画在还没定下来的视口上
// （上一版让绘制停在中间态，结果按钮「看得见点不着」，见 LEVERS 上方注释）
export async function fixViewportIfShort() {
    markShort()
    if (!isStandalone() || !viewportIsShort()) return null
    const meta = document.querySelector('meta[name="viewport"]')
    if (!meta) return null
    const content = meta.content
    const host = meta.parentNode
    const next = meta.nextSibling
    const before = window.innerHeight
    const tries = []
    for (const [name, run] of LEVERS) {
        try { run(meta, content, host, next) } catch (e) { tries.push({ name, error: String(e) }); continue }
        await settle()
        const after = window.innerHeight
        tries.push({ name, after, grew: after - before })
        if (!viewportIsShort()) break
    }
    markShort()
    report = {
        before,
        after: window.innerHeight,
        grew: window.innerHeight - before,
        at: Date.now(),
        tries,
        ...measureViewport(),
    }
    return report
}

