// 选区浮层工具条：贴在选区包围盒上方，居中并夹在视口内，避免选到页边时整条飞出屏幕。
// 只放「收藏」「复制」「取消」三件事 —— 更多操作属于设置抽屉，不该在正文上堆按钮。
const MARGIN = 8
const HALF = 96

export default function SelectionBar({ sel, onBookmark, onCopy, onDismiss }) {
    const width = typeof innerWidth === 'number' ? innerWidth : 400
    const x = Math.min(Math.max(sel.left + sel.width / 2, HALF + MARGIN), width - HALF - MARGIN)
    const y = Math.max(sel.top - MARGIN, 44)
    return <div className="sel-bar" style={{ left: `${x}px`, top: `${y}px` }}>
        <button className="btn" onMouseDown={e => e.preventDefault()} onClick={onBookmark}>收藏</button>
        <button className="btn" onMouseDown={e => e.preventDefault()} onClick={onCopy}>复制</button>
        <button className="btn" onMouseDown={e => e.preventDefault()} onClick={onDismiss}>取消</button>
    </div>
}
