// 版本标识由构建期注入（见 vite.config.js 的 define）：Pages 上 sw.js 有 CDN 缓存滞后，
// 读者没法凭网址判断手机上到底加载了哪一套代码，所以界面上必须留一个能核对的串。
export const APP_BUILD = __APP_BUILD__

const fmtTime = iso => iso
    ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '时间未知'

export const buildLine = () =>
    `${APP_BUILD.id}${APP_BUILD.dirty ? '（含未提交改动）' : ''} · 构建于 ${fmtTime(APP_BUILD.at)}`
