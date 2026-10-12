import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { installConsoleCapture, log } from './lib/log.js'
import { markAvailable, setRunner, watchUpdates } from './lib/update.js'
import { fixViewportIfShort, viewportIsShort } from './lib/viewport.js'
import './styles.css'
import App from './App.jsx'

installConsoleCapture()

// 必须赶在 React 挂载、首屏绘制之前：绘制之后再改 viewport 会把绘制与命中的坐标掰开
// （理由与判定条件见 lib/viewport.js）
fixViewportIfShort().then(r => {
    if (r) log.info('视口修正', { before: r.before, after: r.after, grew: r.grew })
})
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && viewportIsShort()) fixViewportIfShort()
})

log.info('应用启动', {
    base: import.meta.env.BASE_URL,
    mode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser-tab',
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
