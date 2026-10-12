import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { installConsoleCapture, log } from './lib/log.js'
import { markAvailable, setRunner, watchUpdates } from './lib/update.js'
import { refreshViewport, viewportIsShort } from './lib/viewport.js'
import './styles.css'
import App from './App.jsx'

installConsoleCapture()

log.info('应用启动', {
    base: import.meta.env.BASE_URL,
    mode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser-tab',
})

// iOS 主屏冷启动会把视口算短（见 lib/viewport.js）：启动后修一次；之后每次回到前台，
// 只在仍然偏矮时再修，避免白白让正文重排一次
refreshViewport().then(r => {
    if (r) log.info('视口修正', { before: r.before, after: r.after, grew: r.grew })
})
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && viewportIsShort()) refreshViewport()
})

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
