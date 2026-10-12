export const STORAGE_PREFIX = 'aitool-reader'

export const DB_NAME = `${STORAGE_PREFIX}-meta`
// v2：书架改成只读 settings 里的 per-book 元数据（读 books 会把每本书的 Blob 全反序列化一遍），
// 老库里已有的书需要在升级时补一条元数据，否则书架会少书
// v3：新增 reading 表，按「书 + 自然日」累加阅读时长
export const DB_VERSION = 3
export const STORE_BOOKS = 'books'
export const STORE_ANNOTATIONS = 'annotations'
export const STORE_SETTINGS = 'settings'
export const STORE_READING = 'reading'

// settings 里 per-book 元数据的键前缀：`book:<bookId>`
export const BOOK_META_PREFIX = 'book:'

export const OPFS_ROOT_DIR = `${STORAGE_PREFIX}-books`

export const CACHE_PREFIX = STORAGE_PREFIX

// 同一 origin 下（GitHub Pages 上多个 PWA 共用 https://<user>.github.io），
// IndexedDB / OPFS / Cache 均按 origin 共享，因此任何存储标识都必须过这个函数。
export const ns = name => `${STORAGE_PREFIX}:${name}`
