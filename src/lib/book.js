import { UnsupportedTypeError, NotFoundError, ResponseError } from 'foliate-js/view.js'
import { log } from './log.js'

// foliate-js 只认 book 接口的格式；TXT/PDF 需自写适配模块，
// 所以这里把「打不开」拆成能行动的两类，别让用户对着白屏猜。
export function describeOpenError(err) {
    if (err instanceof UnsupportedTypeError) {
        return {
            title: '这个格式目前还打不开',
            detail: '已实测支持 EPUB、MOBI、FB2、CBZ（桌面浏览器实测，iOS 真机仍待验证）；'
                + 'AZW3/KF8 尚未实测，PRC/PDB 与 TXT/PDF 的适配尚未支持。',
        }
    }
    if (err instanceof NotFoundError) return { title: '文件是空的', detail: '请确认文件完整后重新导入。' }
    if (err instanceof ResponseError) return { title: '读取文件失败', detail: String(err.message ?? err) }
    const message = String(err?.message ?? err)
    // DRM 文件在解析头部时就失败，上游不给专门异常，只能按特征文案识别
    if (/encrypt|drm|fairplay/i.test(message)) {
        return { title: '不支持 DRM 加密的书', detail: '本阅读器不做解密；请先用合法途径取得无 DRM 的文件。' }
    }
    return { title: '打开失败', detail: message }
}

export async function openBook(view, file) {
    log.info('开始打开书籍', { name: file?.name, size: file?.size, type: file?.type })
    // view.open() 内部按 magic 派发到 EPUB / MOBI / FB2 / CBZ（zip.js 与 fflate 都在包内 vendor）
    await view.open(file)
    log.info('书籍对象已建立', {
        sections: view.book?.sections?.length ?? 0,
        title: view.book?.metadata?.title,
        fixedLayout: view.isFixedLayout,
    })
    return view.book
}
