// iOS 从主屏冷启动时会把布局视口算短一截，屏幕底下那条「黑边」其实是系统涂在
// **视口之外**的 manifest background_color —— 我们的元素根本画不进去。
// 转屏能立刻治好，说明问题出在启动那一次布局，而不是 CSS。这里把 viewport meta
// 摘掉 viewport-fit 再装回去，逼 WebKit 重算一次视口，并把前后数值留给自检面板核对。

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
    insets: safeInsets(),
})

// 视口比屏幕矮，就是还没修好的样子（单位都是 CSS px / pt）
export const viewportIsShort = () => window.screen.height - window.innerHeight > 1

// rAF 在隐藏页里不跑，所以配一个定时器兜底，别让 await 卡死
const settle = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 120)
    requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
    }))
})

export const refreshViewport = async ({ force = false } = {}) => {
    if (!force && !window.matchMedia('(display-mode: standalone)').matches) return null
    const meta = document.querySelector('meta[name="viewport"]')
    if (!meta) return null
    const content = meta.content
    const before = window.innerHeight
    meta.content = content.replace(/,\s*viewport-fit=cover/, '')
    await settle()
    meta.content = content
    await settle()
    report = {
        before,
        after: window.innerHeight,
        grew: window.innerHeight - before,
        at: Date.now(),
        ...measureViewport(),
    }
    return report
}
