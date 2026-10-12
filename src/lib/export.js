import { log } from './log.js'
import {
    listShelf, getBookRecord, getBookMeta, importBook, importBookMeta, bookIdOf,
} from './library.js'
import { listAnnotations, putAnnotation } from './db.js'
import { fileFromText } from './share.js'

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
        if (m.note) lines.push('>', `> 笔记：${m.note}`)
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
    const manifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: Date.now(),
        books,
        annotations,
    }
    files.unshift(fileFromText(`aitool-reader-backup-${stamp()}.json`,
        JSON.stringify(manifest, null, 2), 'application/json'))
    log.info('全库备份已打包', { books: books.length, annotations: annotations.length })
    return files
}

const isManifest = f => /\.json$/i.test(f.name)

// 恢复靠 (name, size, lastModified) 认书：这三个正是书库 id 的哈希输入，
// 只要文件本身没被改过，重新导入就会算出同一个 id，书签自然接回原来的书。
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
    const restored = []
    const skipped = []
    for (const book of manifest.books ?? []) {
        const file = others.find(f => f.name === book.name && f.size === book.size)
        if (!file) {
            skipped.push(book.name)
            log.warn('备份里的书没在选中文件中找到', { name: book.name, size: book.size })
            continue
        }
        // 书库 id 的哈希输入就是 (name, size, lastModified)，而 lastModified 最容易变：
        // 文件被拷来拷去 mtime 就变了。所以先按文件自身的时间试，再退回清单里记的时间，
        // 两个都不是就算不出原 id —— 那种情况如实跳过，不硬凑。
        const times = [...new Set([file.lastModified, book.lastModified]
            .filter(t => typeof t === 'number' && Number.isFinite(t)))]
        let match = null
        for (const lastModified of times) {
            const candidate = new File([file], book.name, { type: book.type || file.type, lastModified })
            if (await bookIdOf(candidate) === book.id) { match = candidate; break }
        }
        if (!match) {
            skipped.push(`${book.name}（文件属性对不上，认不出是同一本书）`)
            log.warn('备份里的书无法还原编号', { name: book.name, size: book.size, bookId: book.id })
            continue
        }
        // 单本书失败不该中断整次恢复（空间不够、写坏都只影响这一本），如实记进 skipped
        try {
            const { record, isNew } = await importBook(match)
            await importBookMeta(record.id, book.meta)
            restored.push({ id: record.id, name: book.name, isNew })
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
    log.info('备份恢复完成', { restored: restored.length, skipped: skipped.length, annotations })
    return { restored, skipped, annotations, books: manifest.books?.length ?? 0 }
}
