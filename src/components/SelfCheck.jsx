import { useEffect, useState } from 'react'
import { checkCapabilities, detectMode, storageEstimate } from '../lib/capability.js'
import { verifyPrecache } from '../lib/offline-check.js'
import { log } from '../lib/log.js'
import { applyUpdate, checkNow, updateAvailable } from '../lib/update.js'
import { STORAGE_PREFIX, DB_NAME, OPFS_ROOT_DIR } from '../lib/storage.js'

const fmtBytes = n => `${(n / 1048576).toFixed(1)} MB`

// 脚手架自检面板：装对了没有的证据都在这里。一律以浮层呈现：书架态下若改成并排渲染，
// 页面里就会有两个 .shell 各自滚动；阅读态下换页会把 foliate-view 卸载、重新解一遍书。
// 后续要并进正式界面的 debug 面板。
export default function SelfCheck({ onClose, closeLabel = '返回' }) {
    const [caps, setCaps] = useState(() => checkCapabilities())
    const [estimate, setEstimate] = useState(null)
    const [offline, setOffline] = useState(null)
    const [logs, setLogs] = useState(log.all())
    const [updateCheck, setUpdateCheck] = useState(null)

    useEffect(() => log.subscribe(() => setLogs(log.all())), [])

    useEffect(() => {
        storageEstimate().then(setEstimate)
        setCaps(checkCapabilities())
        // 首次安装时 SW 可能还在装 precache；不依赖 serviceWorker.ready（无激活 SW 时它永不 resolve）
        let alive = true
        ;(async () => {
            let result = null
            for (let i = 0; i < 10; i++) {
                result = await verifyPrecache()
                if (result.state !== 'pending') break
                await new Promise(r => setTimeout(r, 400))
            }
            if (alive) setOffline(result)
        })().catch(e => {
            log.warn('预缓存自证失败', e)
            if (alive) setOffline({ state: 'broken', cached: 0, broken: 0 })
        })
        return () => { alive = false }
    }, [])

    const mode = detectMode()

    return (
        <main className="shell sheet">
            <div className="sheet-head">
                <h1>脚手架自检</h1>
                <button onClick={onClose}>{closeLabel}</button>
            </div>
            <p className="lead">部署形态、离线缓存与安全配置是否正确，全在这一页核对。平时用不到，出问题再看 —— 入口在书架底部和阅读时的设置抽屉里。</p>

            <section>
                <h2>运行形态</h2>
                <p className="note">
                    这台浏览器满足阅读器的运行条件：{caps.length} 项能力全过，
                    当前为{mode === 'standalone' ? '主屏 App' : 'Safari 标签页'}形态。
                </p>
                {mode === 'standalone'
                    ? <p className="ok">✓ 主屏 App（豁免 ITP 7 天清除，数据可长期留存）</p>
                    : <p className="warn">
                        ⚠ Safari 标签页模式：<strong>此模式下的存储会在 7 天无交互后被清除</strong>，
                        且与主屏 App 的存储互不可见。请先「分享 → 添加到主屏幕」，之后只在主屏窗口里使用与导入书籍。
                    </p>}
            </section>

            <section>
                <h2>能力门禁</h2>
                <ul className="caps">
                    {caps.map(c => <li key={c.name}>✓ {c.name}</li>)}
                </ul>
            </section>

            <section>
                <h2>路径与存储命名</h2>
                <dl>
                    <dt>base / manifest scope</dt><dd>{import.meta.env.BASE_URL}</dd>
                    <dt>存储前缀</dt><dd>{STORAGE_PREFIX}</dd>
                    <dt>IndexedDB</dt><dd>{DB_NAME}</dd>
                    <dt>OPFS 目录</dt><dd>{OPFS_ROOT_DIR}</dd>
                </dl>
                <p className="note">
                    同一 origin 下可能有你的其他 PWA，所有存储标识均带前缀以避免互相踩踏。
                </p>
            </section>

            <section>
                <h2>离线与配额</h2>
                <dl>
                    <dt>SW 更新</dt>
                    <dd>
                        {updateAvailable()
                            ? <button onClick={() => applyUpdate()}>重启以应用新版本</button>
                            : <button onClick={async () => setUpdateCheck(await checkNow())}>立即检查一次</button>}
                        {updateCheck && <span className="note">
                            {updateCheck.checked
                                ? updateCheck.updated
                                    ? '✓ 新版本已经下载好并进入待激活，点「重启以应用新版本」即可'
                                    : '查过了：远端的 sw.js 和现在跑的是同一版，没有新版本'
                                : `这次没查成：${updateCheck.reason}`}
                        </span>}
                        <span className="note">
                            平时每 5 分钟、以及每次切回前台各查一次；Pages 对 sw.js 缓存 max-age=600，更新本就会滞后
                        </span>
                    </dd>
                    {estimate && <>
                        <dt>已用 / 可用配额</dt>
                        <dd>{fmtBytes(estimate.usage)} / {fmtBytes(estimate.quota)}（persisted: {String(estimate.persisted)}）</dd>
                    </>}
                    <dt>离线缓存自证</dt>
                    <dd className={offline?.state === 'ok' ? 'ok' : 'warn'}>
                        {offline === null
                            ? '检查中…'
                            : offline.state === 'ok'
                                ? `✓ 预缓存 ${offline.cached} 个文件，全部可读`
                                : offline.state === 'pending'
                                    ? '⚠ 本作用域的预缓存尚未建立（SW 未激活或首次安装，刷新后复查）'
                                    : `⚠ 预缓存不可用：已缓存 ${offline.cached} 个、异常 ${offline.broken} 个 → 离线阅读会失败`}
                    </dd>
                </dl>
            </section>

            <section>
                <h2>调试日志（{logs.length}）</h2>
                <p className="note">真机测试时手机若没连 Mac 挂 Safari Web Inspector，这里的日志就是把 iOS 现场带回来的手段；判断结果以此为准。</p>
                <ol className="logs">
                    {logs.slice(-40).reverse().map(e => <li key={e.id} className={e.level}>
                        {e.level} · {e.text}{e.count > 1 ? ` ×${e.count}` : ''}
                    </li>)}
                </ol>
                <button onClick={() => log.clear()}>清空</button>
            </section>
        </main>
    )
}
