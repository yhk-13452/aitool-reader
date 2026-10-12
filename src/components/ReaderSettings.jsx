import Typography from './Typography.jsx'
import { SCRIPT_MODES } from '../lib/script.js'

// 设置抽屉：原来挤在底部控制条上的东西全部收进来，正文才换得来整屏。
// 「点段收藏」是 iOS 原生选区不可靠时的退路，开着它时正文中间的点击归它，
// 唤出菜单改走屏幕顶部一条热区 —— 这两件事都吃「点正文中间」，必须说清楚谁让谁。
export default function ReaderSettings({
    type, onType, scriptMode, onScript, picking, onPicking, onCheck,
}) {
    return <div className="settings">
        <Typography value={type}
            onFont={fontSize => onType({ fontSize })}
            onLineHeight={lineHeight => onType({ lineHeight })}
            onAlign={align => onType({ align })}
            onTheme={theme => onType({ theme })} />

        <div className="setting-group">
            <span className="typo-label">文字</span>
            {SCRIPT_MODES.map(m => <button key={m.key}
                className={`btn${scriptMode === m.key ? ' on' : ''}`}
                onClick={() => onScript(m.key)}>{m.label}</button>)}
            <p className="note">转换只改屏幕上的字形，书签和导出文件里存的一律是原书文字。</p>
        </div>

        <div className="setting-group">
            <button className={`btn${picking ? ' on' : ''}`} onClick={() => onPicking(!picking)}>
                {picking ? '点段收藏：已开' : '点段收藏：已关'}
            </button>
            <p className="note">
                开着时点正文任意一段即整段收藏，不需要长按选字；
                但正文中间的点击就被它占了，唤出菜单改点屏幕最上方那一条，左右翻页热区不变。
            </p>
        </div>

        <div className="setting-group">
            <button className="btn" onClick={onCheck}>自检面板</button>
            <p className="note">看离线缓存、存储配额、版本更新与本机能力，不占用阅读时间。</p>
        </div>

        <p className="note">
            快捷键：← / → 或空格翻页，Esc 收起浮层。
            触屏上点正文左右各四分之一翻页，中间切换菜单。
        </p>
    </div>
}
