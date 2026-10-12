// 界面文案里的数字必须和实际对得上：10 KB 的书显示成「0.0 MB」看起来像空文件，
// 所以小于 1 MB 一律走 KB 档，并且不显示小数。
export const fmtBytes = n => n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`

export const fmtDate = ms => ms ? new Date(ms).toLocaleDateString('zh-CN') : '日期未知'
