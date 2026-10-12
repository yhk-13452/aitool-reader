import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { installConsoleCapture, log } from './lib/log.js'
import { markAvailable, setRunner, watchUpdates } from './lib/update.js'
import { fixViewportIfShort, viewportIsShort } from './lib/viewport.js'
import './styles.css'
import App from './App.jsx'

installConsoleCapture()

log.info('应用启动', {
    base: import.meta.env.BASE_URL,
    mode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser-tab',
})

// iOS 主屏冷启动会把视口算短（见 lib/viewport.js）。修它要占几帧，所以**视口定下来之前
// 不挂载 React** —— 首屏要是画在短视口上，之后再改就会把绘制与命中的坐标掰开。
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && viewportIsShort()) fixViewportIfShort()
})

function boot() {
    const updateSW = registerSW({
        onNeedRefresh() {
            markAvailable()
        },
        onOfflineReady() {
            log.info('应用外壳已缓存完毕，可离线使用')
        },
        onRegisteredSW(url, registration) {
            log.info('Service Worker 已注册', { url, scope: registration?.scope })
            watchUpdates(registration)
        },
        onRegisterError(error) {
            log.error('Service Worker 注册失败', error)
        },
    })
    setRunner(updateSW)

    createRoot(document.getElementById('root')).render(
        <StrictMode>
            <App />
        </StrictMode>,
    )
}

// 视口探针最多跑四招，正常每招两帧；万一页面在后台（rAF 不跑、定时器被降频），
// 1.2 秒后也必须启动 —— 界面迟迟不出来比那条黑边严重得多。
const bootWhenSettled = Promise.race([
    fixViewportIfShort()
        .then(r => {
            if (r) log.info('视口修正', {
                前后: `${r.before}→${r.after}`,
                手段: r.tries.map(t => `${t.name}=${t.error ? '出错' : t.grew}`).join(' / '),
            })
        })
        .catch(e => log.warn('视口修正失败，按当前视口启动', e)),
    new Promise(resolve => setTimeout(resolve, 1200)),
])

bootWhenSettled.then(boot, boot)


