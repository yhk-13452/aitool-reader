import { log } from './log.js'
import { ns } from './storage.js'
import { getSetting, setSetting } from './db.js'

const KEY = ns('typography')

export const FONT_STEP = 10
export const FONT_MIN = 70
export const FONT_MAX = 200
export const LINE_HEIGHTS = [1.4, 1.7, 2.0]
export const ALIGNS = [['left', '左对齐'], ['justify', '两端对齐']]

// 阅读主题三档。只给 html/body 上色并加 !important（作者样式常把正文底色写死），
// 正文里自己指定了颜色的元素（彩色脚注、代码块）靠继承拿不到主题色，因此不受影响。
// 黑底才白字，其余两档深字。
export const THEMES = [
    { key: 'parchment', label: '羊皮纸', bg: '#f4ecd8', fg: '#3a3226', link: '#8a5a2b', scheme: 'light' },
    { key: 'light', label: '白', bg: '#ffffff', fg: '#1c1c1c', link: '#1d5c96', scheme: 'light' },
    { key: 'dark', label: '黑', bg: '#000000', fg: '#e6e6e6', link: '#7fb2e5', scheme: 'dark' },
]

export const themeOf = key => THEMES.find(t => t.key === key) ?? THEMES[0]

export const DEFAULTS = { fontSize: 100, lineHeight: 1.7, align: 'left', theme: 'parchment' }

const clampFont = n => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)))

// 读出来的值全部要过一遍校验：设置项是从 IndexedDB 回来的，老版本或写坏的数据
// 不能把一个非法字号/行距带进 CSS。
export async function loadTypography() {
    let saved = null
    try {
        saved = (await getSetting(KEY))?.value
    } catch (e) {
        log.warn('排版设置读取失败，改用默认值', e)
    }
    if (!saved) return { ...DEFAULTS }
    return {
        fontSize: Number.isFinite(saved.fontSize) ? clampFont(saved.fontSize) : DEFAULTS.fontSize,
        lineHeight: LINE_HEIGHTS.includes(saved.lineHeight) ? saved.lineHeight : DEFAULTS.lineHeight,
        align: ALIGNS.some(([v]) => v === saved.align) ? saved.align : DEFAULTS.align,
        theme: THEMES.some(t => t.key === saved.theme) ? saved.theme : DEFAULTS.theme,
    }
}

export const saveTypography = type => setSetting(KEY, type)

export const stepFont = (size, delta) => clampFont(size + delta)

// 这段 CSS 会被原样塞进每个分段的 iframe。iframe 不继承宿主页的 CSS 变量，
// 所以数值必须在宿主侧就拼好；留 var() 的话永远只会走到括号里的默认值。
export function readerCss({ fontSize, lineHeight, align, theme }) {
    const t = themeOf(theme)
    return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${t.scheme}; font-size: ${fontSize}%; }
    html, body { background-color: ${t.bg} !important; color: ${t.fg} !important; }
    p, li, blockquote, dd {
        line-height: ${lineHeight};
        text-align: ${align};
        -webkit-hyphens: auto;
        hyphens: auto;
        widows: 2;
    }
    a:link { color: ${t.link}; }
    pre { white-space: pre-wrap !important; }
    `
}
