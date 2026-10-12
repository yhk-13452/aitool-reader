// opencc 的词典按方向分块：cn2t 的 ESM 单文件 1.1 MB，t2cn 109 KB。
// 都放主线程会拖慢首屏，也吃 iOS 的内存，所以丢进 Worker 并按需动态 import，
// 用户第一次真正切换时才拉对应方向的词典。
let cached

async function converterFor(to) {
    if (cached?.to === to) return cached.conv
    // opencc-js 的两个子路径各自打包了该方向的词典
    const mod = to === 'tw' ? await import('opencc-js/cn2t') : await import('opencc-js/t2cn')
    const conv = mod.Converter(to === 'tw' ? { from: 'cn', to: 'tw' } : { from: 'tw', to: 'cn' })
    cached = { to, conv }
    return conv
}

self.onmessage = async ({ data }) => {
    const { id, to, texts } = data
    try {
        const conv = await converterFor(to)
        postMessage({ id, ok: true, out: texts.map(t => conv(t)) })
    } catch (e) {
        postMessage({ id, ok: false, error: String(e?.message ?? e) })
    }
}
