import { log } from './log.js'
import {
    DB_NAME, DB_VERSION, STORE_BOOKS, STORE_ANNOTATIONS, STORE_SETTINGS, STORE_READING,
    BOOK_META_PREFIX,
} from './storage.js'

let dbPromise

// 书架要显示书名、大小、「读到 xx%」，但 books 表每条记录都裹着整本书的 Blob，
// 为了列一次书架把每本都反序列化出来在 iOS 上不可接受。所以 per-book 元数据另存
// settings（键 `book:<id>`），books 表只写一次、之后不再碰。
// v1 的老库里，从未打开过的书没有这条元数据 —— 升级时补一次，别让书架少书。
function backfillBookMeta(tx) {
    const books = tx.objectStore(STORE_BOOKS)
    const settings = tx.objectStore(STORE_SETTINGS)
    const all = books.getAll()
    all.onsuccess = () => {
        for (const book of all.result ?? []) {
            if (!book?.id) continue
            const key = `${BOOK_META_PREFIX}${book.id}`
            const existing = settings.get(key)
            existing.onsuccess = () => {
                if (existing.result) return
                settings.put({
                    key,
                    value: { name: book.name, size: book.size, added: book.added },
                })
            }
        }
    }
}

export function openDB() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION)
            req.onupgradeneeded = e => {
                const db = req.result
                const stores = db.objectStoreNames
                if (!stores.contains(STORE_BOOKS)) db.createObjectStore(STORE_BOOKS, { keyPath: 'id' })
                if (!stores.contains(STORE_ANNOTATIONS)) {
                    db.createObjectStore(STORE_ANNOTATIONS, { keyPath: 'id' })
                        .createIndex('bookId', 'bookId')
                }
                if (!stores.contains(STORE_SETTINGS)) db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' })
                if (!stores.contains(STORE_READING)) {
                    db.createObjectStore(STORE_READING, { keyPath: 'id' })
                        .createIndex('bookId', 'bookId')
                }
                // 只在从 v1 升上来时跑：此刻 books 已有数据，事务里同步挂请求保持事务存活
                if (e.oldVersion >= 1 && stores.contains(STORE_BOOKS)) backfillBookMeta(req.transaction)
                log.info('IndexedDB 结构已建立', { db: DB_NAME, version: DB_VERSION, from: e.oldVersion })
            }
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
            // 别的标签页拿着旧版本连接时会一直卡在这里，不报错误，只能显式提示
            req.onblocked = () => log.warn('IndexedDB 打开被其他标签页阻塞')
        })
    }
    return dbPromise
}

async function run(store, mode, op) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode)
        tx.onabort = () => reject(tx.error ?? new Error(`${store} 事务被中止`))
        tx.onerror = () => reject(tx.error)
        const req = op(tx.objectStore(store))
        if (req?.then) return req.then(resolve, reject)
        if (req) {
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        } else {
            tx.oncomplete = () => resolve()
        }
    })
}

// ---- books ----

export const putBook = record => run(STORE_BOOKS, 'readwrite', s => s.put(record))
export const getBook = id => run(STORE_BOOKS, 'readonly', s => s.get(id))
export const deleteBook = id => run(STORE_BOOKS, 'readwrite', s => s.delete(id))

// 不给 books 表写 getAll()：那会把每本书的 Blob 全反序列化一遍，
// 书架展示需要的字段都在 settings（见 library.js 的 listShelf）

// ---- annotations ----

export const putAnnotation = record => run(STORE_ANNOTATIONS, 'readwrite', s => s.put(record))
export const deleteAnnotation = id => run(STORE_ANNOTATIONS, 'readwrite', s => s.delete(id))

export function listAnnotations(bookId) {
    return run(STORE_ANNOTATIONS, 'readonly', s => s.index('bookId').getAll(bookId))
        .then(list => (list ?? []).sort((a, b) => (b.created ?? 0) - (a.created ?? 0)))
}

export async function deleteAnnotationsByBook(bookId) {
    for (const { id } of await listAnnotations(bookId)) await deleteAnnotation(id)
}

// ---- reading 阅读时长 ----

// 一条记录 = 一本书在一个自然日的累计毫秒数，键 `${bookId}|${YYYY-MM-DD}`。
// 按天存而不是按会话存：记录条数是「书数 × 天数」，一年也就几百条，整表读出来再聚合完全够快，
// 也不必给日期开索引。书被移出书架时这些记录会一起删掉。
export const getReading = id => run(STORE_READING, 'readonly', s => s.get(id))
export const putReading = record => run(STORE_READING, 'readwrite', s => s.put(record))

export function listReading() {
    return run(STORE_READING, 'readonly', s => s.getAll())
}

export async function deleteReadingByBook(bookId) {
    const keys = await run(STORE_READING, 'readonly', s => s.index('bookId').getAllKeys(bookId))
    for (const key of keys ?? []) await run(STORE_READING, 'readwrite', s => s.delete(key))
}

// ---- settings / 库指纹 ----

export const getSetting = key => run(STORE_SETTINGS, 'readonly', s => s.get(key))
export const setSetting = (key, value) => run(STORE_SETTINGS, 'readwrite', s => s.put({ key, value }))
export const deleteSetting = key => run(STORE_SETTINGS, 'readwrite', s => s.delete(key))

// settings 表很小，整表读出来再筛前缀，比给每本书单独开一次请求划算
export async function settingsWithPrefix(prefix) {
    const all = await run(STORE_SETTINGS, 'readonly', s => s.getAll())
    const out = new Map()
    for (const { key, value } of all ?? []) if (key.startsWith(prefix)) out.set(key.slice(prefix.length), value)
    return out
}

async function count(store) {
    return (await run(store, 'readonly', s => s.count())) ?? 0
}

export async function readCounts() {
    const [books, annotations] = await Promise.all([count(STORE_BOOKS), count(STORE_ANNOTATIONS)])
    return { books, annotations }
}
