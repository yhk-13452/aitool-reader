// 支持下限：iOS 18.7.7 及以上（iOS 18 整条线放行）。
// 只卡能力，不解析 UA —— iOS UA 里的 Version/x.y 与真实 iOS 版本不对应。
const REQUIREMENTS = [
    { name: 'Object.groupBy', check: () => typeof Object.groupBy === 'function',
      why: 'foliate-js 解析 EPUB 元数据的必经路径' },
    { name: 'Array.prototype.findLastIndex', check: () => typeof [].findLastIndex === 'function',
      why: 'foliate-js paginator 依赖' },
    { name: 'Array.prototype.at', check: () => typeof [].at === 'function',
      why: 'foliate-js epubcfi 依赖' },
    { name: 'Intl.Segmenter', check: () => typeof Intl.Segmenter === 'function',
      why: 'foliate-js 搜索依赖' },
    { name: 'OPFS（异步 API）', check: () => !!navigator.storage?.getDirectory,
      why: '书籍原始文件持久化' },
    { name: 'IndexedDB', check: () => !!window.indexedDB,
      why: '元数据与书签' },
    { name: 'Service Worker', check: () => !!navigator.serviceWorker,
      why: '离线可用' },
    { name: 'Web Crypto（需安全上下文）', check: () => !!crypto?.subtle,
      why: 'EPUB 混淆字体解密的前提，缺则部分书字体乱码' },
]

export function checkCapabilities() {
    return REQUIREMENTS.map(r => ({ ...r, ok: (() => { try { return !!r.check() } catch { return false } })() }))
}

export function missingCapabilities() {
    return checkCapabilities().filter(c => !c.ok)
}

// 运行形态：主屏 App 与 Safari 标签页的存储是两套且互不可见（WebKit #181849），
// 只有主屏 App 豁免 ITP 7 天清除，所以界面必须显示当前形态。
export function detectMode() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches
        || navigator.standalone === true
    return standalone ? 'standalone' : 'browser-tab'
}

export async function storageEstimate() {
    if (!navigator.storage?.estimate) return null
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota, persisted: navigator.storage.persisted ? await navigator.storage.persisted() : false }
}
