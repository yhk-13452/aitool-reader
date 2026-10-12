import { FONT_MIN, FONT_MAX, FONT_STEP, LINE_HEIGHTS, ALIGNS, THEMES, stepFont } from '../lib/typography.js'

// 排版面板：全部用离档按钮，不用滑杆 —— iOS 上单手翻页时滑杆容易误触，
// 而且滑杆停在中间的值没法一眼读回来。三个控件统一往外报「新值」，夹取规则只留在 lib 里。
export default function Typography({ value, onFont, onLineHeight, onAlign, onTheme }) {
    const { fontSize, lineHeight, align, theme } = value
    return <div className="typo">
        <div className="typo-row">
            <span className="typo-label">背景</span>
            {THEMES.map(t => <button key={t.key} className={`btn${t.key === theme ? ' on' : ''}`}
                onClick={() => onTheme(t.key)}>{t.label}</button>)}
        </div>
        <div className="typo-row">
            <span className="typo-label">字号</span>
            <button className="btn" disabled={fontSize <= FONT_MIN} onClick={() => onFont(stepFont(fontSize, -FONT_STEP))}>A−</button>
            <b className="typo-value">{fontSize}%</b>
            <button className="btn" disabled={fontSize >= FONT_MAX} onClick={() => onFont(stepFont(fontSize, FONT_STEP))}>A＋</button>
        </div>
        <div className="typo-row">
            <span className="typo-label">行距</span>
            {LINE_HEIGHTS.map(h => <button key={h} className={`btn${h === lineHeight ? ' on' : ''}`}
                onClick={() => onLineHeight(h)}>{h === 1.4 ? '紧凑' : h === 1.7 ? '标准' : '宽松'}</button>)}
        </div>
        <div className="typo-row">
            <span className="typo-label">对齐</span>
            {ALIGNS.map(([v, label]) => <button key={v} className={`btn${v === align ? ' on' : ''}`}
                onClick={() => onAlign(v)}>{label}</button>)}
        </div>
        <p className="note">
            排版与背景存在这台设备的本地存储里，换一本书仍然生效。
            CBZ 漫画走整页固定版式，阅读器不给它注入样式，所以这几项对它不起作用。
        </p>
    </div>
}
