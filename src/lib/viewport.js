// 视口与安全区的**度量**工具，给自检页把真机现场带回来用。
//
// 这里曾经放过一套「逼 WebKit 重算视口」的手段（改 meta 内容 / 摘掉再插回 / 抖缩放 /
// 撑高滚一下），四条在真机上全部量出 +0 —— 已证伪并删除，别再往回加。
// 底部那条死边的成因与绕法见 index.html 里 apple-mobile-web-app-status-bar-style 的注释。

const px = v => Math.round(parseFloat(v) || 0)

// env() 的真实数值只能从计算样式里读出来，所以临时挂一个探针元素
const safeInsets = () => {
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

// 状态栏那一档到底生效了没有，看 insets.top 最准：default 之下网页不铺到状态栏底下，
// 那里就该是 0；还是 44 就说明仍在用 black-translucent 那套几何
export const measureViewport = () => ({
    screenPt: [window.screen.width, window.screen.height],
    dpr: window.devicePixelRatio,
    innerH: window.innerHeight,
    clientH: document.documentElement.clientHeight,
    visualH: window.visualViewport ? Math.round(window.visualViewport.height) : null,
    meta: document.querySelector('meta[name="viewport"]')?.content ?? null,
    statusbar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content ?? null,
    insets: safeInsets(),
})
