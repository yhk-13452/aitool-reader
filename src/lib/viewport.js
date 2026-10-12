// iOS 从主屏冷启动时会把布局视口算短一截，屏幕底下那条「黑边」其实是系统涂在
// **视口之外**的 manifest background_color —— 我们的元素根本画不进去。
// 转屏能立刻治好，说明问题出在启动那一次布局，而不是 CSS。修法是摘掉 viewport-fit
// 再装回去，逼 WebKit 重算一次视口。
//
// 两条硬约束，都是从真机上踩回来的：
// ① 只在确实算矮了的时候动手（见 viewportIsShort）；
// ② 必须在首屏绘制之前做完。绘制之后再改 viewport，iOS 会出现「菜单条画在这里、
//    点击落在那儿」的坐标错位 —— 白边没了换来点不动的按钮，比原来更糟。

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

// rAF 在隐藏页里不跑，所以配一个定时器兜底，别让 promise 永远悬着
const settle = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 120)
    requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
    }))
})

// 同步改完 meta 就返回；重排落地之后才补上 after 数值，所以这里给的是 promise，
// 只为让自检面板能拿到前后对比，调用方不需要等它
export function fixViewportIfShort() {
    if (!isStandalone() || !viewportIsShort()) return Promise.resolve(null)
    const meta = document.querySelector('meta[name="viewport"]')
    if (!meta) return Promise.resolve(null)
    const content = meta.content
    const before = window.innerHeight
    // 摘掉再装回，中间逼一次同步布局，让 WebKit 重算一次视口。
    // 全程在同一个任务里做完：绘制发生在任务结束时，所以 viewport-fit 缺失的那一帧
    // 根本不会被画出来。要是像上一版那样等两帧再装回，安全区内边距会在中间态里
    // 变成 0，绘制停在那个位置、命中测试却按最终布局算，按钮就会「看得见却点不着」。
    meta.content = content.replace(/,\s*viewport-fit=cover/, '')
    document.documentElement.getBoundingClientRect()
    meta.content = content
    return settle().then(() => {
        report = {
            before,
            after: window.innerHeight,
            grew: window.innerHeight - before,
            at: Date.now(),
            ...measureViewport(),
        }
        return report
    })
}
