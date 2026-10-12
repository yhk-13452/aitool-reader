import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { installConsoleCapture, log } from './lib/log.js'
import { markAvailable, setRunner, watchUpdates } from './lib/update.js'
import './styles.css'
import App from './App.jsx'

installConsoleCapture()

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
