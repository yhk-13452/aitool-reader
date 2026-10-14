import { useEffect, useRef, useState } from 'react'
import { missingCapabilities, detectMode } from './lib/capability.js'
import { captureParagraph, captureSelection, clearSelections } from './lib/selection.js'
import { listAnnotations, getSetting, setSetting } from './lib/db.js'
import {
    importBook, toFile, getBookRecord, removeBook, addAnnotation, removeAnnotation,
    checkLibrary, listShelf, renameBookTitle, saveProgress, discardFailedImport,
} from './lib/library.js'
import { createHighlighter } from './lib/highlight.js'
import { createScriptSwitcher, SCRIPT_MODES } from './lib/script.js'
import { DEFAULTS as TYPO_DEFAULTS, loadTypography, saveTypography, readerCss, themeOf } from './lib/typography.js'
import { createReadingTracker, readingYear } from './lib/reading.js'
import { applyUpdate, subscribe } from './lib/update.js'
import { bookmarkFiles, libraryBackupFiles, restoreBackup } from './lib/export.js'
import { saveFiles } from './lib/share.js'
import { fmtBytes, fmtDate } from './lib/format.js'
import { buildLine } from './lib/build.js'
import { log } from './lib/log.js'
import FoliateView from './components/FoliateView.jsx'
import SelfCheck from './components/SelfCheck.jsx'
import ReadingStats from './components/ReadingStats.jsx'
import { InstallGuide, InstallConfirm } from './components/InstallGuide.jsx'
import Drawer from './components/Drawer.jsx'
import SelectionBar from './components/SelectionBar.jsx'
import ReaderSettings from './components/ReaderSettings.jsx'
import { ns } from './lib/storage.js'

// 安装引导的确认状态存本机：确认过一次就不再每次导入都拦，但标签页的风险提示常驻
const INSTALL_ACK = ns('install-ack')

const flattenToc = (toc, out = []) => {
    for (const item of toc ?? []) {
        out.push({ label: item.label, href: item.href })
        if (item.subitems?.length) flattenToc(item.subitems, out)
    }
    return out
}

const fmtProgress = p => p?.fraction == null ? null : `读到 ${(p.fraction * 100).toFixed(0)}%`

// 翻页时 relocate 会连续触发，落盘等停顿，别每翻一页写一次 IndexedDB
const PROGRESS_DELAY = 2000

// foliate 给每次定位都标了 reason：page/snap/scroll 是读者自己翻页（paginator.js:1071/1083、842），
// navigation 是 goTo、anchor 是重排后恢复锚点（:954、:956）。但**章末那一下翻页会把「进入下一章」
// 也报成 navigation**（实测：page(frac=1) 紧跟 navigation(index+1)），所以只按 reason 判会把跨章翻页
// 当成参观。真正的判据是「这一次 goTo 是不是我们自己发起的」。
const PAGING_REASONS = new Set(['page', 'snap', 'scroll'])

// 正文左右各 1/4 是翻页热区，中间切换菜单
const EDGE = 0.25
// 「点段收藏」开着时中间归收藏，唤出菜单改点屏幕最上方这一条
const HOT_ZONE = 44
// 反馈浮层：info 类（已加书签、已切换繁体、已回到上次位置）会自动收起，错误类必须手动关
const TOAST_MS = 3000

// 三条导出通道发生的并不是同一件事，标题就别用一句「导出成功」糊过去：
// 下载没有回执、分享可能被用户取消，界面上说的必须和实际对得上
const CHANNEL_TITLE = {
    share: n => `已通过系统分享导出 ${n} 个文件`,
    download: n => `已向浏览器发出 ${n} 个文件的下载请求`,
    clipboard: () => '已把文本文件复制到剪贴板',
    'share-cancelled': () => '你取消了分享，文件没有导出',
}

export default function App() {
    // 书架项：{ id, name, size, added, title, progress }，全部来自 settings，不含 Blob
    const [book, setBook] = useState(null)
    const [file, setFile] = useState(null)
    const [initialLocation, setInitialLocation] = useState(null)
    const [view, setView] = useState(null)
    const [toc, setToc] = useState([])
    const [loc, setLoc] = useState(null)
    const [marks, setMarks] = useState([])
    // 书签列表的显示文本：存的一律是原始字形，这里只是按当前简繁设置转一份来显示
    const [markText, setMarkText] = useState(new Map())
    // 阅读界面的三态浮层：菜单条、抽屉（目录/书签/设置）、选区工具条
    const [chrome, setChrome] = useState(true)
    const [drawer, setDrawer] = useState(null)
    const [sel, setSel] = useState(null)
    const [picking, setPicking] = useState(false)
    const [shelf, setShelf] = useState([])
    const [audit, setAudit] = useState(null)
    const [error, setError] = useState(null)
    const [showCheck, setShowCheck] = useState(false)
    const inputRef = useRef(null)
    // 上一次重定位落在哪一页：同一页的 cfi 是同一个串，用来分辨「真的换页了」和
    // 「iOS 长按选字后的那次回弹」
    const lastCfiRef = useRef(null)
    const highlighterRef = useRef(null)
    const scriptRef = useRef(null)
    const [scriptMode, setScriptMode] = useState('orig')
    const [statsYear, setStatsYear] = useState(new Date().getFullYear())
    const [stats, setStats] = useState(null)
    const [readingRev, setReadingRev] = useState(0)
    const [installAck, setInstallAck] = useState(false)
    const [pendingFile, setPendingFile] = useState(null)
    const [type, setType] = useState(TYPO_DEFAULTS)
    const [updateReady, setUpdateReady] = useState(false)
    // 阅读位置与「跳转参观」分开记：只有用户自己翻页才算他读到了哪儿。
    // readPos 是那个位置，canReturn 表示当前屏幕是跳过来的、可以一键回去。
    const [canReturn, setCanReturn] = useState(false)
    const readPos = useRef(null)
    // 最近一次移动是不是我们主动发起的列表跳转；读者一翻页就翻回 false
    const selfJump = useRef(false)
    const stageRef = useRef(null)
    const pendingProgress = useRef(null)
    const progressTimer = useRef(0)
    const readingRef = useRef(null)
    const freshRef = useRef(null)
    const mode = detectMode()

    const missing = missingCapabilities()

    // 启动就做一次库指纹对账：iOS 清空 IndexedDB 时不报错，只会开出空库
    useEffect(() => {
        (async () => {
            try {
                const [result, items, ack, typo] = await Promise.all([
                    checkLibrary(), listShelf(), getSetting(INSTALL_ACK), loadTypography(),
                ])
                setAudit(result)
                setShelf(items)
                setInstallAck(!!ack?.value?.at)
                setType(typo)
            } catch (e) {
                log.error('书库读取失败', e)
                setError({ title: '本地存储读不出来', detail: String(e?.message ?? e) })
            }
        })()
    }, [])

    // 高亮跟着书签列表走：新增/删除/换书都重画一遍，省掉逐条同步的分支
    useEffect(() => {
        if (!view) return
        highlighterRef.current?.replaceAll(marks.map(m => m.locator))
    }, [marks, view])

    useEffect(() => () => highlighterRef.current?.dispose(), [])

    // 有新版本时 SW 的回调可能在这次会话的任意时刻报进来，所以订阅而不是启动时读一次
    useEffect(() => subscribe(setUpdateReady), [])

    // 状态栏那一条现在归系统画（见 index.html 的 status-bar-style），颜色由 theme-color 决定：
    // 让它跟着阅读底色走，否则羊皮纸正文上面压着一条深色边。
    // iOS 在 standalone 下会不会跟着运行时改，属未证实项（真机清单里另记一条）。
    useEffect(() => {
        const meta = document.querySelector('meta[name="theme-color"]')
        if (!meta) return
        meta.content = book
            ? themeOf(type.theme).bg
            : getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    }, [book, type.theme])

    // 列表字形跟着「书签 + 当前简繁模式」重算：转换只走一次 Worker，不做逐条缓存
    useEffect(() => {
        const sw = scriptRef.current
        if (!sw || marks.length === 0) {
            setMarkText(new Map(marks.map(m => [m.id, m.text])))
            return
        }
        let alive = true
        sw.forDisplay(marks.map(m => m.text))
            .then(out => { if (alive) setMarkText(new Map(marks.map((m, i) => [m.id, out[i] ?? m.text]))) })
        return () => { alive = false }
    }, [marks, scriptMode, view])

    // 阅读计时：书开着、阅读器已就绪、且自检浮层没盖住时才走表；停表时把攒下的时长落盘
    useEffect(() => {
        if (!book || !view || showCheck) return
        const tracker = createReadingTracker(book.id)
        readingRef.current = tracker
        tracker.start()
        // stop 是异步落盘，cleanup 里不能干等它 —— 靠它完成后翻一个版本号，
        // 让统计在那之后再重算，否则合上书看到的是上一秒的旧数字（数据没错但界面在说谎）
        return () => {
            if (readingRef.current === tracker) readingRef.current = null
            tracker.stop().then(() => setReadingRev(r => r + 1), () => {})
        }
    }, [book?.id, view, showCheck])

    // 统计跟着书架与「刚合上书」走：合上书时计时已落盘，回书架就该看到新数字
    useEffect(() => {
        readingYear(statsYear, shelf)
            .then(setStats)
            .catch(e => log.warn('阅读时长统计读取失败', e))
    }, [statsYear, shelf, book, readingRev])

    // iOS 上「关掉 App」常常直接杀进程，不给 unload 时机；pagehide 是还能抢救的一下
    useEffect(() => {
        const handler = () => flushProgress()
        addEventListener('pagehide', handler)
        return () => removeEventListener('pagehide', handler)
    }, [])

    if (missing.length > 0) {
        return (
            <main className="shell">
                <h1>当前浏览器不支持运行本阅读器</h1>
                <p className="lead">
                    本项目只支持 <strong>iOS 18 及以上</strong>，并且必须<strong>添加到主屏幕后从主屏图标打开</strong>。
                </p>
                <ul className="caps">
                    {missing.map(c => <li key={c.name}>✗ {c.name} —— {c.why}</li>)}
                </ul>
            </main>
        )
    }

    // 只认 refs，不读 state：pagehide 上挂的是首次渲染那个实例，靠 state 会读到过期值
    async function flushProgress() {
        clearTimeout(progressTimer.current)
        const pending = pendingProgress.current
        pendingProgress.current = null
        if (!pending) return
        try {
            await saveProgress(pending.bookId, pending)
        } catch (e) {
            log.warn('进度写入失败', e)
        }
    }

    const onRelocate = detail => {
        const prevCfi = lastCfiRef.current
        lastCfiRef.current = detail.cfi ?? null
        setLoc(detail)
        // 换页之后选区的屏幕坐标已经不属于这一页，工具条留着就是骗人。
        // 但 iOS 长按选字收尾时分页器会回弹一次（reason: snap，页没变、cfi 一模一样），
        // 无条件清掉就等于工具条刚冒头就被自己按回去 —— iOS 18.6 模拟器实测：
        // 「选区上报」之后紧跟一条 snap 重定位，选区工具条因此一次都没出现过。
        const moved = prevCfi !== null && prevCfi !== (detail.cfi ?? null)
        if (sel && moved) log.info('换页清掉选区', { reason: detail.reason, section: detail.section?.current })
        if (moved) setSel(null)
        if (!book || !detail.cfi) return
        const here = {
            bookId: book.id,
            cfi: detail.cfi,
            fraction: detail.fraction ?? null,
            label: detail.tocItem?.label ?? null,
        }
        // 只有读者自己移动才算「读到这儿了」。我们发起的列表跳转（书签 / 目录 / 回原位）既不动进度
        // 也不动落点，否则跳去第一章看一眼就把第三章的位置覆盖了、也就没有「回原位」可说。
        // 翻页一律作数，包括章末那一下被 foliate 报成 navigation 的「进入下一章」。
        if (PAGING_REASONS.has(detail.reason)) selfJump.current = false
        if (selfJump.current && readPos.current) return
        // 章末的 page 事件会报出越界的 fraction（实测 1.1176）和退化到段首的 CFI（`epubcfi(/6/4!/4)`），
        // 存下去界面上就是「读到 112%」，重开书还会被拽回本章开头 —— 宁可保留上一条真位置。
        if (!(detail.fraction >= 0 && detail.fraction <= 1)) return
        readPos.current = here
        setCanReturn(false)
        pendingProgress.current = here
        clearTimeout(progressTimer.current)
        progressTimer.current = setTimeout(flushProgress, PROGRESS_DELAY)
    }

    const closeDrawer = () => setDrawer(null)
    const toggleDrawer = name => setDrawer(d => (d === name ? null : name))

    // 翻页前先把「参观」标记清掉：章末那一下 foliate 会把「进入下一章」报成 navigation，
    // 只看 reason 就分不清是读者翻过去的还是我们跳过去的
    const turnLeft = () => { selfJump.current = false; view?.goLeft() }
    const turnRight = () => { selfJump.current = false; view?.goRight() }

    // 正文在 iframe 里，宿主收不到那一下点击，所以误点的证据只能从转出来的坐标里拿。
    // 真机上出现过「菜单条画在这里、点击落在那儿」的偏移（启动后改 viewport 的后遗症）：
    // 不猜，量出来 —— 正文收到了一个其实落在可见按钮矩形上（或上下 90px 内）的点击，
    // 就把偏差记进日志环，自检页的日志能把数字带回桌面。上限 5 条，别把环刷满。
    const misalignRef = useRef(0)
    const measureMisalign = (x, y) => {
        if (misalignRef.current >= 5) return
        for (const btn of document.querySelectorAll('.chrome:not(.hide) button')) {
            const r = btn.getBoundingClientRect()
            if (x < r.left - 8 || x > r.right + 8) continue
            const dy = y < r.top ? y - r.top : y > r.bottom ? y - r.bottom : 0
            if (Math.abs(dy) > 90) continue
            misalignRef.current++
            log.warn('菜单按钮的位置收到了正文的点击', {
                按钮: btn.textContent.trim(),
                偏差: Math.round(dy),
                点于: Math.round(y),
                矩形: `${Math.round(r.top)}–${Math.round(r.bottom)}`,
            })
        }
    }

    // 正文里的一次点击只做一件事，按「先收选区 → 收抽屉 → 边缘翻页 → 中间切菜单」的优先级判
    const onContentTap = ({ x, y, target }) => {
        if (chrome) measureMisalign(x, y)
        if (sel) {
            clearSelections(view)
            setSel(null)
            return
        }
        if (drawer) {
            setDrawer(null)
            return
        }
        const stage = stageRef.current?.getBoundingClientRect()
        const relX = stage && stage.width ? (x - stage.left) / stage.width : x / innerWidth
        if (picking && y - (stage?.top ?? 0) < HOT_ZONE) {
            setChrome(true)
            return
        }
        if (relX < EDGE) { turnLeft(); return }
        if (relX > 1 - EDGE) { turnRight(); return }
        if (picking) {
            onPick(target)
            return
        }
        setChrome(c => !c)
    }

    const onKey = key => {
        if (key === 'Escape') {
            if (drawer) setDrawer(null)
            else if (sel) { clearSelections(view); setSel(null) }
            else setChrome(false)
            return
        }
        if (drawer || sel) return
        if (key === 'ArrowLeft') turnLeft()
        else if (key === 'ArrowRight' || key === ' ') turnRight()
    }

    // 焦点在正文 iframe 里时宿主收不到 keydown，所以两边都挂；
    // 抽屉/工具条是宿主 DOM，焦点在它们上面时走宿主这条
    useEffect(() => {
        if (!book) return
        const handler = e => {
            if (!['ArrowLeft', 'ArrowRight', ' ', 'Escape'].includes(e.key)) return
            if (e.target?.closest?.('input, select, textarea')) return
            e.preventDefault()
            onKey(e.key)
        }
        addEventListener('keydown', handler)
        return () => removeEventListener('keydown', handler)
    })

    // 阅读态的反馈是浮层，会自动消失，所以只让 info 类超时收起；错误类留着等用户关掉
    useEffect(() => {
        if (!book || !error || error.tone !== 'info') return
        const timer = setTimeout(() => setError(null), TOAST_MS)
        return () => clearTimeout(timer)
    }, [book, error])

    const closeBook = () => {
        setPicking(false)
        setDrawer(null)
        setSel(null)
        setCanReturn(false)
        readPos.current = null
        selfJump.current = false
        setBook(null)
        setFile(null)
        setView(null)
        setMarks([])
        setToc([])
        setLoc(null)
        setInitialLocation(null)
        highlighterRef.current?.dispose()
        highlighterRef.current = null
        scriptRef.current?.dispose()
        scriptRef.current = null
        setScriptMode('orig')
    }

    const openStored = async item => {
        setError(null)
        await flushProgress()
        try {
            const record = await getBookRecord(item.id)
            setMarks(await listAnnotations(item.id))
            setDrawer(null)
            setSel(null)
            setCanReturn(false)
            readPos.current = null
            selfJump.current = false
            setChrome(true)
            setBook(item)
            setToc([])
            setLoc(null)
            setView(null)
            setInitialLocation(item.progress?.cfi ?? null)
            setShowCheck(false)
            setFile(toFile(record))
        } catch (e) {
            log.error('打开书籍失败', e)
            setError({ title: '这本书打不开', detail: String(e?.message ?? e) })
        }
    }

    const pickFile = f => {
        if (!f) return
        // 标签页形态下第一本书之前拦一道：这里导入的东西 7 天无交互就被清掉，
        // 而且装成主屏 App 之后读不到 —— 让用户先知道再花这一次导入
        if (mode === 'browser-tab' && !installAck) {
            setError(null)
            setPendingFile(f)
            log.info('标签页首次导入，等待用户确认', { name: f.name, size: f.size })
            return
        }
        doImport(f)
    }

    const ackBrowserTab = async () => {
        setInstallAck(true)
        await setSetting(INSTALL_ACK, { at: Date.now() })
    }

    const doImport = async f => {
        if (!f) return
        setError(null)
        try {
            await flushProgress()
            const { record, isNew } = await importBook(f)
            // 记下「这次新导进来的那本」：打不开时只退回这一本，不碰之前就存在的书
            freshRef.current = isNew ? record.id : null
            // 重新导入后数据又有了，「被清空」的红条得跟着消失，否则就是滞留在界面上的假警报
            setAudit(await checkLibrary())
            // 不按「新书」清空标注：books 表被清掉过但 annotations 还在时，这样能把书签捡回来
            setMarks(await listAnnotations(record.id))
            setDrawer(null)
            setSel(null)
            setChrome(true)
            const items = await listShelf()
            setShelf(items)
            setBook(items.find(i => i.id === record.id) ?? { id: record.id, name: record.name })
            setToc([])
            setLoc(null)
            setView(null)
            setInitialLocation(null)
            setShowCheck(false)
            setFile(f)
        } catch (e) {
            log.error('导入失败', e)
            setError({ title: '导入失败', detail: String(e?.message ?? e) })
        }
    }

    const dropBook = async item => {
        try {
            // 先停表再删：计时落盘是异步的，排在 removeBook 之后的话这次 flush
            // 会把刚删掉的时长又写回去，留下一条谁也不会再读到的幽灵行
            if (book?.id === item.id) await readingRef.current?.stop()
            await removeBook(item.id)
        } catch (e) {
            log.error('移出书架失败', e)
            setError({ title: '移出书架失败', detail: String(e?.message ?? e) })
            return
        }
        if (book?.id === item.id) closeBook()
        setShelf(await listShelf())
        setAudit(await checkLibrary())
    }

    const onReady = async (v, f, restored) => {
        setView(v)
        setToc(flattenToc(v.book?.toc))
        highlighterRef.current?.dispose()
        highlighterRef.current = createHighlighter(v)
        scriptRef.current?.dispose()
        scriptRef.current = createScriptSwitcher(v)
        const title = v.book?.metadata?.title
        await renameBookTitle(book.id, title)
        if (title) setBook(b => (b ? { ...b, title } : b))
        setShelf(await listShelf())
        const progress = book.progress
        if (initialLocation && !restored) {
            setError({
                title: '没能回到上次阅读的位置',
                detail: `存下的位置串（${initialLocation}）在当前这本书里解析失败，已从正文开头打开。`,
            })
        } else if (restored) {
            setError({
                tone: 'info',
                title: '已回到上次阅读的位置',
                detail: `${fmtProgress(progress) ?? '进度未知'}${progress?.label ? ` · ${progress.label}` : ''}`,
            })
        } else setError(null)
        log.info('阅读界面就绪', { title, tocItems: v.book?.toc?.length ?? 0, restored })
    }

    const saveBookmark = async result => {
        // overlayer 以位置串为 key，同一段收两次只会有一条高亮，存两条书签反而是假数据
        if (marks.some(m => m.locator === result.cfi)) {
            setError({ tone: 'info', title: '这一段已经收藏过了', detail: '书签按正文位置去重。' })
            return false
        }
        const record = await addAnnotation(book.id, {
            type: 'bookmark',
            locator: { type: 'cfi', value: result.cfi },
            text: result.text,
        })
        setError({ tone: 'info', title: '已加书签', detail: record.text.slice(0, 40) })
        setMarks(list => [record, ...list])
        return true
    }

    // 屏幕上显示的可能是转换后的字形，书签存的文本要走这一步换回原始字形（没开转换时原样返回）
    const textOf = subject => scriptRef.current?.textOf(subject)

    const addBookmark = async () => {
        if (!view || !book) return
        const result = captureSelection(view, textOf)
        if (!result.ok) {
            setError({
                title: '没有取到选区',
                detail: `${result.reason} —— 手机上长按选出来的字，常被系统自己收掉。改用设置里的「点段收藏」：开着它直接点一段就能收藏，不依赖选区。`,
            })
            return
        }
        setError(null)
        await saveBookmark(result)
        // 收完就把选区和工具条一起撤掉，否则屏幕上留着一块已经失效的选区
        clearSelections(view)
        setSel(null)
    }

    // 复制走宿主的剪贴板：`sel.text` 已经是屏幕上看到的那串字（开着简繁转换时就是转换后的字形），
    // 用户要的「复制」是复制他看到的东西，所以这里故意不走 textOf。
    const copySelection = async () => {
        const text = sel?.text ?? ''
        log.info('点复制', { 长度: text.length, 有剪贴板: !!navigator.clipboard?.writeText })
        if (!text) return
        try {
            await navigator.clipboard.writeText(text)
            log.info('复制写入完成', { 长度: text.length })
            setError({ tone: 'info', title: '已复制', detail: text.slice(0, 40) })
        } catch (e) {
            log.warn('复制失败', e)
            setError({ title: '复制没成功', detail: '系统没让网页写进剪贴板。长按选区后系统菜单里的「拷贝」可以先用一次。' })
        }
    }

    // 「点段收藏」模式下的落点：整段 Range → CFI，不经过 getSelection()
    const onPick = async target => {
        const result = captureParagraph(view, target, textOf)
        if (!result.ok) {
            if (!result.silent) setError({ title: '这一段没收藏成', detail: result.reason })
            return
        }
        setError(null)
        await saveBookmark(result)
    }

    // 阅读器打不开书：如果这本是本次刚导入的，把它从书架退回 —— 留一具「点了就报错」的
    // 尸体在书架上比删掉更糟。标注一律不动（books 被清过、标注还在时靠它们捡书签）。
    const onOpenError = async info => {
        const fresh = freshRef.current
        freshRef.current = null
        if (fresh && fresh === book?.id) {
            try {
                await discardFailedImport(fresh)
                setShelf(await listShelf())
                setAudit(await checkLibrary())
                closeBook()
                setError({ ...info, detail: `${info.detail} 这本刚导入，已从书架退回；原有书签没有动。` })
                return
            } catch (e) {
                log.warn('退回打不开的新书失败', e)
            }
        }
        setError(info)
    }

    const backToShelf = async () => {
        await flushProgress()
        closeBook()
        setShelf(await listShelf())
    }

    const switchScript = async key => {
        const sw = scriptRef.current
        if (!sw || sw.mode === key) return
        setError(null)
        try {
            const label = SCRIPT_MODES.find(m => m.key === key).label
            const unsafe = await sw.setMode(key)
            setScriptMode(key)
            // 改 nodeValue 会折叠掉所有锚在这些文本节点上的 Range，而被折叠的不只是高亮：
            // paginator 的滚动锚点也是一条 Range，render() 后它落到章首（实测 93% → 11%）。
            // 所以切完要用 CFI 把高亮重画一遍，再用当前位置重新定位。
            const here = view?.lastLocation?.cfi
            highlighterRef.current?.refresh()
            if (here) await view.goTo(here).catch(e => log.warn('切换后回位失败', e))
            setError(unsafe > 0
                ? {
                    title: `已切换到${label}，${unsafe} 处保持原文`,
                    detail: '这些文字转换后长度会变。书签与进度用的是正文里的字符偏移，'
                        + '长度一变老书签就会错位，所以宁可混排也不改它们。',
                }
                : { tone: 'info', title: `已切换到${label}` })
        } catch (e) {
            log.error('简繁切换失败', e)
            setError({ title: '简繁切换失败', detail: String(e?.message ?? e) })
        }
    }

    // 跳转完就把抽屉收起、菜单隐藏：从列表回到正文之后，屏幕该整块还给书
    const jump = async (go, what) => {
        setDrawer(null)
        try {
            // 从现在起是「参观」：这条路上的 relocate（navigation + 随后几次 anchor 重排）都不算读者移动，
            // 直到他真翻一页才作数
            selfJump.current = true
            await go()
            // 有可回的落点就把底栏留着 —— 藏起来的按钮等于没给；没有落点才把屏幕整块还给书
            const arm = !!readPos.current
            setCanReturn(arm)
            setChrome(arm)
            log.info(`${what}跳转完成`)
        } catch (e) {
            log.error(`${what}跳转失败`, e)
            setError({ title: '跳转失败', detail: String(e?.message ?? e) })
        }
    }

    const goToBookmark = mark => jump(() => view?.goTo(mark.locator), '书签')

    // 回的是「上次阅读位置」而不是历史栈上一层：多级后退会一路退到看不懂的位置，
    // 而读者要的从来就是「我刚读到哪儿来着」这一件事
    const backToReadPos = async () => {
        const here = readPos.current
        if (!here) return
        setDrawer(null)
        setCanReturn(false)
        try {
            // 回位之后重新记下落点（认下同样的值，无害），并解除参观态：接下来读者可能直接翻页，
            // 若仍算跳转就会漏写一次进度
            await view?.goTo(here.cfi)
            selfJump.current = false
            setChrome(false)
            log.info('回到上次阅读位置', { cfi: here.cfi })
        } catch (e) {
            log.error('回阅读位置失败', e)
            setError({ title: '回不到上次阅读的位置', detail: String(e?.message ?? e) })
        }
    }

    const dropBookmark = async mark => {
        await removeAnnotation(mark.id)
        setMarks(list => list.filter(m => m.id !== mark.id))
    }

    const report = res => setError(res.ok
        ? {
            tone: res.via === 'share-cancelled' ? undefined : 'info',
            title: (CHANNEL_TITLE[res.via] ?? (n => `已导出 ${n} 个文件`))(res.count),
            detail: res.note,
        }
        : { title: '导出失败', detail: res.reason })

    const exportMarks = async () => {
        setError(null)
        try {
            const files = await bookmarkFiles(book.id)
            if (files.length === 0) {
                setError({ tone: 'info', title: '这本书还没有书签', detail: '没有可导出的内容。' })
                return
            }
            report({ ...(await saveFiles(files)), count: files.length })
        } catch (e) {
            log.error('导出书签失败', e)
            setError({ title: '导出书签失败', detail: String(e?.message ?? e) })
        }
    }

    const exportLibrary = async () => {
        setError(null)
        try {
            const files = await libraryBackupFiles()
            if (files.length <= 1) {
                setError({ tone: 'info', title: '书库是空的', detail: '没有可导出的书。' })
                return
            }
            report({ ...(await saveFiles(files)), count: files.length })
        } catch (e) {
            log.error('导出备份失败', e)
            setError({ title: '导出备份失败', detail: String(e?.message ?? e) })
        }
    }

    const restoreFromBackup = async list => {
        setError(null)
        try {
            const result = await restoreBackup([...list])
            setShelf(await listShelf())
            setAudit(await checkLibrary())
            setError({
                tone: result.skipped.length ? undefined : 'info',
                title: `恢复完成：${result.restored.length} 本书 / ${result.annotations} 条书签`,
                detail: result.skipped.length ? `没接回来的：${result.skipped.join('；')}` : null,
            })
        } catch (e) {
            log.error('恢复备份失败', e)
            setError({ title: '恢复备份失败', detail: String(e?.message ?? e) })
        }
    }

    // 排版：先改内存让界面立刻跟上，再落盘。写失败不回滚状态 —— 顶多是下次启动读回旧值，
    // 为一类几乎不会发生的 IO 错误把正在读的这一页弹回去不值得。
    const applyType = async patch => {
        const next = { ...type, ...patch }
        setType(next)
        try {
            await saveTypography(next)
        } catch (e) {
            log.warn('排版设置保存失败', e)
        }
    }

    // 三条横幅：书架页按文档流排布，阅读页改成盖在正文上的浮层。内容完全一致，只是位置不同
    const bannersTop = <>
        {audit?.wiped && <p className="error-banner fatal">
            <strong>本地存储被清空了</strong>
            <span>
                {audit.from} 在 {fmtDate(audit.lastAt)} 还记有 {audit.lostBooks} 本书 / {audit.lostAnnotations} 条标注，
                现在读出来是空的。如果不是你自己删除的，说明存储被系统清掉了 —— iOS 清数据不会报错，
                只能靠这种对账发现。如果之前用「导出全库备份」存过文件，重新导入并「从备份恢复」就能把书签接回来；
                从没导出过的话，这些书签已经找不回来了。
                另外确认自己是<strong>从主屏图标</strong>打开的：Safari 标签页里的数据 7 天无交互就会被清。
            </span>
        </p>}

        {/* 新版本提示常驻、不给关闭按钮：它不是通知，是「你现在看的这套代码已经过期」的状态 */}
        {updateReady && <p className="update-bar">
            <strong>有新版本可用</strong>
            <span className="note">
                当前跑的是 {buildLine()}；重启后会加载新版本，书架与书签都存在本地库里，不受影响。
            </span>
            <button className="btn" onClick={() => applyUpdate()}>重启更新</button>
        </p>}

        {error && error.tone !== 'info' && <p className="error-banner">
            <strong>{error.title}</strong>
            {error.detail ? ` —— ${error.detail}` : ''}
            <button onClick={() => setError(null)}>关闭</button>
        </p>}
    </>

    // 确认类提示（已加书签、已切换繁体）会自己消失，放底部；放顶部就会把菜单条压住好几秒
    const bannersInfo = error && error.tone === 'info' && <p className="error-banner info">
        <strong>{error.title}</strong>
        {error.detail ? ` —— ${error.detail}` : ''}
        <button onClick={() => setError(null)}>关闭</button>
    </p>

    const progress = loc
        ? `${((loc.fraction ?? 0) * 100).toFixed(1)}%${loc.tocItem?.label ? ` · ${loc.tocItem.label}` : ''}`
        : '等待首次渲染…'

    // 底栏右侧那颗按钮只在「当前屏幕是跳过来的」时出现；自己翻过一页就消失（PAGING 分支会清）
    const readPosLabel = readPos.current?.label
        ? `回到上次阅读位置（${((readPos.current.fraction ?? 0) * 100).toFixed(0)}% ${readPos.current.label}）`
        : '回到上次阅读位置'

    // 只做 [目录] [书签] 两个抽屉：笔记还没有创建与编辑入口，放个空抽屉就是半成品
    const dialogs = <>
        {/* 自检一律是浮层：不能替代阅读区渲染，否则一进自检就合上书，回来要重解一遍整本书 */}
        {showCheck && <SelfCheck onClose={() => setShowCheck(false)} closeLabel={book ? '返回阅读' : '返回书架'} />}
        {pendingFile && <InstallConfirm
            file={pendingFile}
            onProceed={async () => {
                const f = pendingFile
                setPendingFile(null)
                await ackBrowserTab()
                doImport(f)
            }}
            onCancel={() => {
                setPendingFile(null)
                setError({ tone: 'info', title: '这次没有导入', detail: '按书架上的步骤装到主屏幕后，从主屏图标进来再导入。' })
            }} />}
    </>

    return (
        <div className="app">
            {book ? <div className="stage" ref={stageRef}
                style={{ background: themeOf(type.theme).bg }}>
                <FoliateView
                    file={file}
                    initialLocation={initialLocation}
                    readerCss={readerCss(type)}
                    onTap={onContentTap}
                    onKey={onKey}
                    onSelection={setSel}
                    onView={onReady}
                    onError={onOpenError}
                    onRelocate={onRelocate} />

                <header className={`chrome chrome-top${chrome ? '' : ' hide'}`}>
                    <button className="btn" onClick={backToShelf}>书架</button>
                    <strong className="chrome-title">{book.title || book.name}</strong>
                    <nav className="chrome-nav">
                        <button className={`btn${drawer === 'toc' ? ' on' : ''}`}
                            onClick={() => toggleDrawer('toc')}>目录</button>
                        <button className={`btn${drawer === 'marks' ? ' on' : ''}`}
                            onClick={() => toggleDrawer('marks')}>书签</button>
                        <button className={`btn${drawer === 'settings' ? ' on' : ''}`}
                            onClick={() => toggleDrawer('settings')}>设置</button>
                    </nav>
                </header>

                <footer className={`chrome chrome-bottom${chrome ? '' : ' hide'}`}>
                    <span className="note">{progress}</span>
                    {picking && <span className="chip">点段收藏中</span>}
                    {scriptMode !== 'orig' && <span className="chip">
                        {SCRIPT_MODES.find(m => m.key === scriptMode)?.label}
                    </span>}
                    {canReturn && <button className="btn return-read" onClick={backToReadPos}
                        title={readPosLabel}>回原位</button>}
                </footer>

                {drawer === 'toc' && <Drawer side="left" title={`目录（${toc.length}）`} onClose={closeDrawer}>
                    <ul className="toc">
                        {toc.map((t, i) => <li key={i}>
                            <button onClick={() => jump(() => view?.goTo(t.href), '目录')}>{t.label}</button>
                        </li>)}
                    </ul>
                </Drawer>}

                {drawer === 'marks' && <Drawer side="left" title={`书签（${marks.length}）`} onClose={closeDrawer}>
                    <ul className="marks">
                        {marks.length === 0 && <li className="note">
                            这本书还没有书签。选中文字后点浮出来的「收藏」，或在设置里开「点段收藏」整段收。
                        </li>}
                        {marks.map(m => <li key={m.id}>
                            <div className="mark-body">
                                <button className="mark-text" onClick={() => goToBookmark(m)}>{markText.get(m.id) ?? m.text}</button>
                                <code>{m.locator}</code>
                            </div>
                            <button className="mark-del" aria-label="删除书签" onClick={() => dropBookmark(m)}>✕</button>
                        </li>)}
                    </ul>
                    {/* Markdown 给人看，JSON 留着以后导回来，两个文件一起走系统分享 */}
                    <button className="btn" disabled={marks.length === 0} onClick={exportMarks}>
                        导出本书书签（{marks.length}）
                    </button>
                </Drawer>}

                {drawer === 'settings' && <Drawer side="bottom" title="设置" onClose={closeDrawer}>
                    <ReaderSettings type={type} onType={applyType}
                        scriptMode={scriptMode} onScript={switchScript}
                        picking={picking} onPicking={setPicking}
                        onCheck={() => { setDrawer(null); setShowCheck(true) }} />
                </Drawer>}

                {sel && <SelectionBar sel={sel} onBookmark={addBookmark} onCopy={copySelection}
                    onDismiss={() => { clearSelections(view); setSel(null) }} />}

                <div className="toasts">{bannersTop}</div>
                <div className="toasts toasts-bottom">{bannersInfo}</div>
            </div> : <>
                <header className="bar">
                    <strong>本地电子书阅读器</strong>
                    <div className="bar-actions">
                        <label className="btn">
                            导入
                            <input ref={inputRef} type="file"
                                accept=".epub,.mobi,.fb2,.cbz"
                                onChange={e => {
                                    pickFile(e.target.files?.[0])
                                    // 清空 value，否则重选同一个文件不会触发 change
                                    e.target.value = ''
                                }} />
                        </label>
                    </div>
                </header>

                {bannersTop}
                {bannersInfo}

                <main className="shell">
                    <h1>书架</h1>
                    <p className="lead">书与书签都存在这台设备的本地存储里，不上传任何服务器。</p>
                    <p className="note">
                        书籍自带脚本时阅读器会照常执行它（正文与分页需要同源），
                        所以<strong>只导入你信任的文件</strong>：一本恶意书籍能改写这台设备上的整个书库，
                        而 CSP 拦不住这种同源访问。定期「导出全库备份」是唯一能撤销这种破坏的手段。
                    </p>
                    {mode === 'browser-tab' && (installAck
                        ? <p className="warn mode-warn">
                            ⚠ 现在是在 <strong>Safari 标签页</strong>里用：这里的数据
                            <strong>连续 7 天没有交互就会被 iOS 清掉</strong>，且与主屏 App 互不可见。
                            「分享 → 添加到主屏幕」之后从主屏图标进来，书架会是从空的开始。
                        </p>
                        : <InstallGuide onUnderstood={async () => {
                            await ackBrowserTab()
                            setError({ tone: 'info', title: '已记下，不再拦导入', detail: '这条风险提醒会一直留在书架上。' })
                        }} />)}
                    {shelf.length === 0 ? <p className="note">书库是空的。用上方「导入」选择一本 EPUB / MOBI / FB2 / CBZ。</p> : (
                        <ul className="shelf">
                            {shelf.map(item => <li key={item.id}>
                                <button className="shelf-open" onClick={() => openStored(item)}>
                                    <span className="shelf-name">{item.display}</span>
                                    <span className="note">
                                        {fmtProgress(item.progress)
                                            ? `${fmtBytes(item.size)} · ${fmtProgress(item.progress)}`
                                            : `${fmtBytes(item.size)} · 未开始`}
                                        {item.added ? ` · 导入于 ${fmtDate(item.added)}` : ''}
                                    </span>
                                </button>
                                <button className="mark-del" aria-label="移出书架" onClick={() => dropBook(item)}>✕</button>
                            </li>)}
                        </ul>
                    )}

                    <ReadingStats data={stats} year={statsYear} onYear={setStatsYear} />

                    <div className="backup-row">
                        <button className="btn" onClick={exportLibrary}>导出全库备份</button>
                        <label className="btn">
                            从备份恢复
                            <input type="file" multiple
                                accept=".json,.epub,.mobi,.fb2,.cbz"
                                onChange={e => {
                                    restoreFromBackup(e.target.files)
                                    e.target.value = ''
                                }} />
                        </label>
                        <p className="note">
                            备份 = 一个清单 JSON 加上每本书的原始文件，一次系统分享就能存进「文件」App；
                            恢复时把这些文件一起选中即可。书签按正文位置（CFI）接回原书，
                            所以<strong>必须连同书本身一起备份</strong>，只留 JSON 是导不回来的。
                        </p>
                    </div>

                    <div className="shelf-tools">
                        <button className="btn" onClick={() => setShowCheck(true)}>自检</button>
                        <p className="note">
                            运行形态、离线缓存、能力门禁与一份环形调试日志都在这页。
                            平时用不到，出问题再看。
                        </p>
                        {/* 版本要常驻：Pages 的 sw.js 走 CDN 缓存，光看网址分辨不出手机上跑的是哪套代码 */}
                        <p className="note">当前版本 {buildLine()}</p>
                    </div>
                </main>
            </>}

            {dialogs}
        </div>
    )
}
