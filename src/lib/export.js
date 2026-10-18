import { log } from './log.js'
import {
    listShelf, getBookRecord, getBookMeta, importBook, importBookMeta, bookIdOf,
} from './library.js'
import { listAnnotations, putAnnotation, listReading, getReading, putReading } from './db.js'
import { fileFromText } from './share.js'
import { loadTypography, saveTypography } from './typography.js'

export const BACKUP_FORMAT = 'aitool-reader-backup'
export const BOOKMARK_FORMAT = 'aitool-reader-bookmarks'
export const BACKUP_VERSION = 1

// 用本地时间而不是 toISOString()：界面上的日期（导入于、阅读时长的自然日）全是本地口径，
// 备份文件名却走 UTC 的话，东八区晚上导出的包会写成「前一天」，看着就是两个对不上的日期
const stamp = () => {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`
}
const fmtTime = ms => ms ? new Date(ms).toLocaleString('zh-CN') : '未知时间'
// 文件名里不能带这些字符，书名直接拼进去会造出一个写不出来的文件
const safeName = s => (s || 'book').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)

async function annotationList(bookId) {
    return (await listAnnotations(bookId)).map(m => ({
        id: m.id, bookId: m.bookId, type: m.type, locatorType: m.locatorType,
        locator: m.locator, text: m.text, note: m.note ?? '',
        created: m.created, updated: m.updated,
    }))
}

function bookmarkMarkdown(book, marks) {
    const lines = [
        `# 《${book.title || book.name}》书签`,
        '',
        `- 导出时间：${fmtTime(Date.now())}`,
        `- 共 ${marks.length} 条`,
        `- 文件：${book.name}（${book.size} 字节，书库编号 ${book.id}）`,
        '',
    ]
    marks.forEach((m, i) => {
        lines.push(`## ${i + 1}. ${m.text.slice(0, 30)}`, '')
        for (const para of m.text.split(/\n+/)) lines.push(`> ${para}`)
        if (m.note) lines.push('>', ...m.note.split(/\n+/).map((l, i) => i ? `> ${l}` : `> 笔记：${l}`))
        lines.push('', `位置：\`${m.locator}\` · 收藏于 ${fmtTime(m.created)}`, '')
    })
    return lines.join('\n')
}

// 一本书的书签：Markdown 给人看，JSON 给以后导回来用
export async function bookmarkFiles(bookId) {
    const [record, meta, marks] = await Promise.all([
        getBookRecord(bookId), getBookMeta(bookId), annotationList(bookId),
    ])
    if (marks.length === 0) return []
    const book = {
        id: record.id, name: record.name, size: record.size,
        lastModified: record.lastModified ?? null, title: meta?.title ?? null,
    }
    const base = `${safeName(book.title || book.name)}-书签-${stamp()}`
    const json = JSON.stringify({ format: BOOKMARK_FORMAT, version: BACKUP_VERSION, book, annotations: marks }, null, 2)
    return [
        fileFromText(`${base}.md`, bookmarkMarkdown(book, marks), 'text/markdown'),
        fileFromText(`${base}.json`, json, 'application/json'),
    ]
}

// 全库备份 = manifest + 每本书的原始文件一起分享出去。
// 不做 zip：foliate-js 里 vendor 的 fflate 只有解压（unzlibSync），没有打包能力，
// 而把整本书塞进 JSON 的 base64 会在 iOS 上直接把内存顶穿。
export async function libraryBackupFiles() {
    const items = await listShelf()
    const books = []
    const files = []
    for (const item of items) {
        // 一本一本取：所有 Blob 同时进内存的话，几本书就能把 WebContent 进程挤爆
        const record = await getBookRecord(item.id)
        const meta = await getBookMeta(item.id)
        books.push({
            id: record.id, name: record.name, size: record.size,
            lastModified: record.lastModified ?? null, type: record.type ?? '',
            added: record.added, meta: meta ?? null,
        })
        files.push(new File([record.blob], record.name, {
            type: record.type, lastModified: record.lastModified ?? undefined,
        }))
    }
    const annotations = []
    for (const book of books) annotations.push(...await annotationList(book.id))
    // 阅读时长整表带走：一条记录 = 一本书一个自然日的毫秒数，一年也就几百条。
    // 不筛书 —— 移出书架时记录会跟着删，所以表里不该有幽灵行；真有的话恢复那头按
    // 「书没回来就不写」挡住，不会往书架上凭空拉出一本书。
    const reading = await listReading() ?? []
    const manifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: Date.now(),
        books,
        annotations,
        reading,
        // 排版（字号/行距/对齐/主题）是全局一份存在 settings 里，重装主屏图标就会没。
        // 以前备份只装书与书签，读者调好的那套排版压根不在里面 —— 补上。
        // version 不升：这些字段是叠加的，老版本读不到就当没有，新备份缺它也能恢复。
        settings: { typography: await loadTypography() },
    }
    files.unshift(fileFromText(`aitool-reader-backup-${stamp()}.json`,
        JSON.stringify(manifest, null, 2), 'application/json'))
    log.info('全库备份已打包', { books: books.length, annotations: annotations.length, reading: reading.length })
    return files
}

const isManifest = f => /\.json$/i.test(f.name)
const extOf = n => (n.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()

// 恢复靠 (name, size, lastModified) 这三元组认书 —— 它们正是书库 id 的哈希输入。
// 但**文件名不能逐字信**：iOS「存储到文件」撞名会自动加 " 2"，备份里的 `三重门.epub`
// 落回磁盘就成了 `三重门 2.epub`，逐字比相等会把每一本都判成「没找到」。
// 所以先按同名同尺寸配，配不上再按「同尺寸 + 同扩展名」取候选，名字一律用清单里那个重建，
// 时间拿文件自身与清单记录各试一次 —— **id 对上才算同一本书**，这比字符串相等硬得多。
export async function restoreBackup(picked) {
    const manifestFile = picked.find(isManifest)
    if (!manifestFile) throw new Error('选中的文件里没有备份清单（那个 .json）')
    let manifest
    try {
        manifest = JSON.parse(await manifestFile.text())
    } catch (e) {
        throw new Error(`备份清单读不出来：${e.message}`)
    }
    if (manifest.format !== BACKUP_FORMAT) throw new Error(`这不是本应用的备份文件（format=${manifest.format ?? '无'}）`)
    if (manifest.version !== BACKUP_VERSION) throw new Error(`备份版本 ${manifest.version} 当前版本读不了`)

    const others = picked.filter(f => f !== manifestFile)
    // 一个文件只能认领一本书，否则两本同尺寸的书会抢同一个
    const taken = new Set()
    const restored = []
    const skipped = []
    for (const book of manifest.books ?? []) {
        const free = () => others.filter(f => !taken.has(f))
        const exact = free().find(f => f.name === book.name && f.size === book.size)
        // 名字不同也没关系，尺寸与扩展名对上的都当候选，交给 id 去判
        const candidates = exact ? [exact]
            : free().filter(f => f.size === book.size && extOf(f.name) === extOf(book.name))
        const times = [...new Set([book.lastModified, ...candidates.map(f => f.lastModified)]
            .filter(t => typeof t === 'number' && Number.isFinite(t)))]
        let match = null
        let matchFile = null
        let renamedTo = null
        for (const file of candidates) {
            for (const lastModified of times) {
                const candidate = new File([file], book.name, { type: book.type || file.type, lastModified })
                if (await bookIdOf(candidate) === book.id) {
                    match = candidate
                    matchFile = file
                    renamedTo = file.name === book.name ? null : file.name
                    break
                }
            }
            if (match) break
        }
        if (!match) {
            // 把「到底收到了哪些文件」一起报出来：这次三本全跳，光看书名分不清是没选上还是名字变了
            skipped.push(`${book.name}（${book.size} 字节，在选中的文件里没认出来）`)
            log.warn('备份里的书没在选中文件中找到', {
                name: book.name, size: book.size, bookId: book.id,
                选中了: others.map(f => `${f.name}=${f.size}`),
            })
            continue
        }
        taken.add(matchFile)
        // 单本书失败不该中断整次恢复（空间不够、写坏都只影响这一本），如实记进 skipped
        try {
            const { record, isNew } = await importBook(match)
            await importBookMeta(record.id, book.meta)
            restored.push({
                id: record.id, name: book.name, isNew,
                // 认回来这件事要说得出证据，不然用户以为我们偷偷放宽了什么
                ...(renamedTo ? { renamedFrom: renamedTo } : {}),
            })
            if (renamedTo) log.info('备份里的书按内容认回（文件名已被系统改动）', { 清单里: book.name, 实际文件: renamedTo })
        } catch (e) {
            skipped.push(`${book.name}（${String(e?.message ?? e)}）`)
            log.warn('备份里的书导入失败', { name: book.name, reason: String(e?.message ?? e) })
        }
    }

    const restoredIds = new Set(restored.map(r => r.id))
    let annotations = 0
    for (const a of manifest.annotations ?? []) {
        // 书没回来的，它的书签也就没处挂，直接跳过（不猜、不改 bookId）
        if (!restoredIds.has(a.bookId)) continue
        await putAnnotation({ ...a })
        annotations++
    }
    // 阅读时长**只增不减**：一台机重装后可能又读了几分钟，那比备份新，
    // 拿旧值盖回去等于把人家刚读掉的抹掉。按 `${bookId}|${day}` 逐日取较大值。
    let reading = 0
    for (const r of manifest.reading ?? []) {
        if (!restoredIds.has(r.bookId) || !r.day) continue
        const id = `${r.bookId}|${r.day}`
        const existing = await getReading(id)
        const ms = Math.max(existing?.ms ?? 0, r.ms ?? 0)
        if (!ms || ms === existing?.ms) continue
        await putReading({ id, bookId: r.bookId, day: r.day, ms, updated: Date.now() })
        reading++
    }
    // 排版是全局一份（字号/行距/对齐/主题），老备份没这个字段就跳过，不算错
    let typography = false
    if (manifest.settings?.typography) {
        await saveTypography(manifest.settings.typography)
        typography = true
    }
    log.info('备份恢复完成', { restored: restored.length, skipped: skipped.length, annotations, reading, typography })
    return { restored, skipped, annotations, reading, typography, books: manifest.books?.length ?? 0 }
}
