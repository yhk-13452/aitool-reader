import { log } from './log.js'

// 导出的三条通道，按可靠性排序：
//   1. navigator.share({files}) —— iOS 主屏 App 里的正路，能直接落到「文件」App / iCloud Drive
//   2. <a download> —— 桌面浏览器可用；iOS 的 Safari 标签页里对非图片类型经常直接忽略
//   3. 剪贴板 —— 只兜文本，在桌面浏览器里调试时不至于什么都拿不出来
// 三条都失败要如实报出来，别静默丢掉用户的数据。
export async function saveFiles(files) {
    if (files.length === 0) return { ok: false, reason: '没有要导出的文件' }

    if (navigator.canShare?.({ files })) {
        try {
            await navigator.share({ files })
            log.info('已通过系统分享导出', { files: files.map(f => f.name) })
            return { ok: true, via: 'share' }
        } catch (e) {
            // 用户主动取消不算失败
            if (e?.name === 'AbortError') return { ok: true, via: 'share-cancelled' }
            log.warn('系统分享失败，退回下载', e)
        }
    }

    // 支不支持 download 能问出来，下载到底成没成功问不出来（浏览器不给回执，iOS Safari 还经常直接忽略
    // 非图片下载）。所以这条只说「已触发」，把到下载目录核对这件事如实交回给用户。
    if ('download' in document.createElement('a')) {
        for (const file of files) downloadOne(file)
        log.info('已触发浏览器下载', { files: files.length })
        return {
            ok: true,
            via: 'download',
            note: '浏览器不会回下载结果，请到下载目录确认文件是否真的落盘。'
                + '（iOS Safari 在标签页里常常直接忽略这类下载；从主屏图标进来走系统分享才是正路。）',
        }
    }

    const textFile = files.find(f => (f.type?.startsWith('text/') ?? false) || /\.(md|json|txt)$/i.test(f.name))
    if (textFile) {
        try {
            await navigator.clipboard.writeText(await textFile.text())
            log.info('下载不可用，已复制到剪贴板', { file: textFile.name })
            return { ok: true, via: 'clipboard', note: `这台浏览器不分享也不下载，已把 ${textFile.name} 放进剪贴板` }
        } catch (e) {
            log.warn('剪贴板兜底也失败', e)
        }
    }
    return { ok: false, reason: '这台设备的浏览器既不分享、不下载，也写不了剪贴板' }
}

function downloadOne(file) {
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.append(a)
    a.click()
    a.remove()
    // 回收太早会让下载读不到 Blob 内容
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function fileFromText(name, text, type) {
    return new File([text], name, { type, lastModified: Date.now() })
}
