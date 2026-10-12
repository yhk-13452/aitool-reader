import { log } from './log.js'
import { fmtBytes } from './format.js'
import { STORAGE_PREFIX, BOOK_META_PREFIX } from './storage.js'
import {
    putBook, getBook, deleteBook,
    putAnnotation, deleteAnnotation, deleteAnnotationsByBook,
    deleteReadingByBook,
    getSetting, setSetting, deleteSetting, settingsWithPrefix, readCounts,
} from './db.js'

const FINGERPRINT_KEY = 'fingerprint'
// 书的原始 Blob 一旦写进 books 表就不再动它：整条记录里 Blob 是主体，
// 每次改标题或存进度都 put 一遍 = 把整本书重新结构化克隆一次，大文件在 iOS 上是灾难。
// 所以 per-book 元数据（标题、进度、书架展示字段）单独存 settings，键为 `book:<id>`。
const META_PREFIX = BOOK_META_PREFIX

const metaKey = id => `${META_PREFIX}${id}`

// 同一本书的判定只读文件属性，不读字节：iOS 的 WebContent 进程内存上限很低，
// 为了算哈希把整本书读进内存不划算。代价是「改了内容但没改时间戳」会被当成同一本书。
export async function bookIdOf(file) {
    const bytes = await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(`${file.name}:${file.size}:${file.lastModified}`))
    return [...new Uint8Array(bytes)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
}

// 导入前先问配额。理由不是「怕写失败」而是「怕写失败之前先把内存打爆」：
// Blob 落库要把整本书结构化克隆一遍，iOS 的 WebContent 进程内存上限很低，
// 空间不够时往往是进程被直接杀掉（界面表现为闪退），而不是给我们一个能显示的错。
// estimate() 在部分环境报 quota=0，那不等于没空间，不能拿它当拒绝的理由。
export async function checkQuota(size) {
    if (!navigator.storage?.estimate) return { known: false }
    let usage = 0
    let quota = 0
    try {
        ;({ usage = 0, quota = 0 } = await navigator.storage.estimate())
    } catch (e) {
        log.warn('配额查询失败，放行导入', e)
        return { known: false }
    }
    if (!quota) return { known: false, usage, quota }
    // 留 10% 余量：落库本身有额外开销，写完还得留出翻页时缓存字节的余地
    const need = Math.ceil(size * 1.1)
    return { known: true, usage, quota, free: Math.max(0, quota - usage), fits: usage + need <= quota }
}

export async function importBook(file) {
    const room = await checkQuota(file.size)
    if (room.known && !room.fits) {
        throw new Error(
            `剩余空间装不下这本书：书 ${fmtBytes(file.size)}，可用约 ${fmtBytes(room.free)}。`
            + '先在书架上「移出书架」删掉不看的书再导入。',
        )
    }
    const id = await bookIdOf(file)
    const existing = await getBook(id)
    const record = {
        id,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified ?? null,
        type: file.type ?? '',
        added: existing?.added ?? Date.now(),
        blob: file,
    }
    await putBook(record)
    // 书架只读 settings，所以入库就要写下展示字段；已有元数据（标题、进度）保留不动，
    // 重复导入同一本书不会把读完的进度清掉
    await patchBookMeta(id, { name: record.name, size: record.size, added: record.added })
    await refreshFingerprint()
    log.info('书籍已入库', { id, name: record.name, size: record.size, reused: !!existing })
    return { record, isNew: !existing }
}

// foliate 的 open() 吃 Blob 即可，但标题与错误文案要用原始文件名
export function toFile(record) {
    return new File([record.blob], record.name,
        { type: record.type, lastModified: record.lastModified ?? undefined })
}

// 书架项只有元数据，翻开一本书得回 books 表把 Blob 取回来
export async function getBookRecord(id) {
    const record = await getBook(id)
    if (!record) throw new Error(`书库里读不到这本书（id ${id}）`)
    return record
}

export const getBookMeta = id => getSetting(metaKey(id)).then(r => r?.value ?? null)

async function patchBookMeta(id, patch) {
    const meta = (await getBookMeta(id)) ?? {}
    const next = { ...meta, ...patch }
    await setSetting(metaKey(id), next)
    return next
}

// 书架列表：真实书名、大小、「读到 62%」全在 settings 里，一次读小表就够，不解 Blob
export async function listShelf() {
    const metas = await settingsWithPrefix(META_PREFIX)
    const items = [...metas]
        .map(([id, m]) => ({ id, ...m }))
        .sort((a, b) => (b.added ?? 0) - (a.added ?? 0))
    // 内部标题相同、文件却不同的两本书（不同版本/不同译本共用一个 title 很常见），
    // 在书架上就是同一行字，用户没法挑。只在真撞名时补文件名，不撞名不打扰。
    const count = new Map()
    for (const x of items) count.set(x.title || x.name, (count.get(x.title || x.name) ?? 0) + 1)
    for (const x of items) {
        const key = x.title || x.name
        const stem = x.name.replace(/\.[^.]+$/, '')
        x.display = count.get(key) > 1 && stem !== key ? `${key}（${stem}）` : key
    }
    return items
}

export async function renameBookTitle(id, title) {
    if (!title || (await getBookMeta(id))?.title === title) return
    await patchBookMeta(id, { title })
}

// 备份恢复用：把备份里的标题与进度写回元数据，缺字段就不覆盖本机已有值
export async function importBookMeta(id, meta) {
    if (!meta) return
    const patch = {}
    if (meta.title) patch.title = meta.title
    if (meta.progress?.cfi) patch.progress = meta.progress
    if (Object.keys(patch).length) await patchBookMeta(id, patch)
}

// 阅读进度按书存：重新打开时用存的 CFI 调 `view.init({ lastLocation })` 回到上次的位置。
// 除了 CFI 还带 fraction/label，备份和书架展示都用得上，不用为了显示进度去解一遍书。
export async function saveProgress(id, { cfi, fraction, label }) {
    if (!cfi) return null
    const progress = { cfi, fraction: fraction ?? null, label: label ?? null, at: Date.now() }
    await patchBookMeta(id, { progress })
    return progress
}

export async function removeBook(id) {
    await deleteAnnotationsByBook(id)
    await deleteReadingByBook(id)
    await deleteBook(id)
    await deleteSetting(metaKey(id))
    log.info('书籍已移出书库', { id })
    return refreshFingerprint()
}

// 刚导进来的书打不开（格式不支持、文件坏了）时把这条记录退回去，别在书架上留一具打不开的尸体。
// 注意不动 annotations：books 被清过而标注还在的情况下，正是靠留着标注才能把书签捡回来。
export async function discardFailedImport(id) {
    await deleteBook(id)
    await deleteSetting(metaKey(id))
    log.info('打不开的新书已退回', { id })
    return refreshFingerprint()
}

export async function addAnnotation(bookId, { type, locator, text, note }) {
    const record = {
        id: crypto.randomUUID(),
        bookId,
        type,
        locatorType: locator.type,
        locator: locator.value,
        text,
        note: note ?? '',
        created: Date.now(),
        updated: Date.now(),
    }
    await putAnnotation(record)
    await refreshFingerprint()
    return record
}

export async function removeAnnotation(id) {
    await deleteAnnotation(id)
    await refreshFingerprint()
}

// ---- 库指纹自检 ----
// iOS 清掉 IndexedDB 时不抛异常，只会开出一个空库：界面若照常显示「空书架」，
// 用户看到的就是「书凭空消失了但一切正常」。所以每次启动都和上次记下的数量对账。
//
// 诚实说明：指纹存在 IndexedDB 自己的 settings 里，而 ITP 是按 origin 整体清除的，
// 主数据没了时指纹通常也没了 → 这条路只能抓到「部分丢失 / 我们自己写坏 / 单独清了 books 表」。
// 整库消失那种情况只能靠 localStorage 副本兜（另一套驱逐路径，iOS 上的表现未证实），
// 真正的兜底是全库备份导出（backlog 高优）。

const LS_FINGERPRINT_KEY = `${STORAGE_PREFIX}:fingerprint`

function readFingerprintCopies() {
    const copies = []
    const fromLs = localStorage.getItem(LS_FINGERPRINT_KEY)
    if (fromLs) {
        try { copies.push({ from: 'localStorage', ...JSON.parse(fromLs) }) } catch { /* 坏数据直接忽略 */ }
    }
    return copies
}

export async function refreshFingerprint() {
    const counts = await readCounts()
    const record = { ...counts, at: Date.now() }
    await setSetting(FINGERPRINT_KEY, record)
    try { localStorage.setItem(LS_FINGERPRINT_KEY, JSON.stringify(record)) } catch (e) { log.warn('指纹副本写入失败', e) }
    return counts
}

export async function checkLibrary() {
    const [setting, counts] = await Promise.all([
        getSetting(FINGERPRINT_KEY),
        readCounts(),
    ])
    // 首次安装时这条记录还不存在，get 的 result 是 undefined
    const saved = setting?.value
    const copies = readFingerprintCopies()
    // 只要任一副本记着「曾有书」而本次读出为空，就报异常
    const claims = [saved ? { from: 'IndexedDB', ...saved } : null, ...copies].filter(c => c && c.books > 0)
    const wiped = counts.books === 0 && claims.length > 0
    const worst = claims.sort((a, b) => b.books - a.books)[0] ?? null
    if (wiped) log.error('库指纹自检异常：上次有书记录，本次读出为空', { counts, claims })
    else log.info('库指纹自检通过', { counts, saved: saved ?? null, copies })
    return {
        counts,
        saved,
        wiped,
        lostBooks: wiped ? worst.books - counts.books : 0,
        lostAnnotations: wiped ? (worst.annotations ?? 0) - counts.annotations : 0,
        lastAt: worst?.at ?? null,
        from: worst?.from ?? null,
    }
}
