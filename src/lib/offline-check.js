import { log } from './log.js'

// precache 里的 url 相对 SW scope，用绝对 base 解析
const BASE = new URL(import.meta.env.BASE_URL, location.href).href

// workbox 用 addAll 写入预缓存：任一 URL 404 就整体 reject、缓存留空，离线静默失效
// 且界面不给提示（/count 就是这么坏的）。iOS 上没有 Web Inspector，只能应用内自证。
// 注意读的是「当前激活的 SW 实际缓存了什么」，不去比对网络上的 sw.js ——
// 有待更新版本时两者哈希不同，比对会误报。
export async function verifyPrecache() {
    const names = (await caches.keys())
        .filter(name => name.startsWith('workbox-precache') && name.endsWith(BASE))
    if (names.length === 0) return { state: 'pending', cached: 0, broken: 0 }

    const urls = []
    let broken = 0
    for (const name of names) {
        const cache = await caches.open(name)
        for (const request of await cache.keys()) {
            urls.push(request.url)
            if (!(await cache.match(request))) broken++
        }
    }
    const result = {
        state: urls.length === 0 ? 'empty' : broken ? 'broken' : 'ok',
        cached: urls.length - broken,
        broken,
        files: urls.map(u => u.replace(location.origin, '').split('?')[0]),
    }
    if (result.state === 'ok') log.info('预缓存自证通过', result)
    else log.warn('预缓存异常', result)
    return result
}
