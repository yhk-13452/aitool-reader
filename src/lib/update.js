import { log } from './log.js'

// 新版本状态由 Service Worker 的回调异步报进来，React 树外面没有地方挂它，所以放模块级。
// 不做「自动刷新」：阅读中途换包会把正解到一半的书打断，跳没跳位全看运气 —— 只通知，重启由用户点。
let waiting = null
let runUpdate = null
const listeners = new Set()

export const updateAvailable = () => waiting !== null

export function markAvailable() {
    if (!waiting) {
        waiting = true
        log.info('检测到新版本，等待用户确认重启')
        for (const cb of listeners) cb(true)
    }
}

export function subscribe(cb) {
    listeners.add(cb)
    cb(waiting === true)
    return () => listeners.delete(cb)
}

export const setRunner = fn => { runUpdate = fn }

export async function applyUpdate() {
    if (!runUpdate) return false
    await runUpdate(true)
    return true
}

// App 从主屏图标进来后可以一直开着不重载，Pages 又给 sw.js 挂了 max-age=600：
// 只在启动时注册一次的话，这一整次会话都停在旧版本上，用户根本不知道有新东西。
// update() 只是重新拉一次 sw.js，字节没变就不会进入 installing，不打扰任何人。
export function watchUpdates(registration, every = 5 * 60_000) {
    if (!registration) return
    const check = () => registration.update().catch(e => log.warn('版本探测失败', e))
    const timer = setInterval(check, every)
    // iOS 会把后台页面的定时器 throttle 到几乎不动，而「切回 App」恰好是最该看新版本的时刻
    const onVisible = () => document.visibilityState === 'visible' && check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
        clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisible)
    }
}

// update() 的 promise 只保证「重新拉过一次 sw.js」，装没装出新 SW 要等它进 waiting 才知道。
// 不等它就报「有新版本」，用户每次点检查都会收到一个根本不存在的更新。
function waitForWaiting(registration, ms = 5000) {
    return new Promise(resolve => {
        if (registration.waiting) return resolve(true)
        const stop = () => { clearTimeout(timer); registration.removeEventListener('updatefound', onFound) }
        const done = value => { stop(); resolve(value) }
        const onFound = () => {
            if (registration.waiting) done(true)
            else if (registration.installing?.state === 'redundant') done(false)
        }
        const timer = setTimeout(() => done(!!registration.waiting), ms)
        registration.addEventListener('updatefound', onFound)
    })
}

// 手动查一次：真机排障时「我明明推了新代码」需要一条能当场验证的路径，而不是等 5 分钟。
export async function checkNow() {
    let registration = null
    try {
        registration = await navigator.serviceWorker.getRegistration()
        await registration?.update()
    } catch (e) {
        return { checked: false, reason: String(e?.message ?? e) }
    }
    if (!registration) return { checked: false, reason: '这个浏览器标签页里没有已注册的 Service Worker' }
    log.info('手动版本探测已发起', { scope: registration.scope })
    const updated = await waitForWaiting(registration)
    if (updated) markAvailable()
    return { checked: true, updated }
}
