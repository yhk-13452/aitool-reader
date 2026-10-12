// 阅读界面的抽屉：覆盖在正文之上，不占布局高度 —— 正文区域必须始终是整屏，
// 这是它和「把面板塞在正文下面」的区别。侧边只认 left / bottom 两种。
export default function Drawer({ side = 'left', title, onClose, children }) {
    return <>
        <div className="scrim" onClick={onClose} />
        <aside className={`drawer drawer-${side}`} role="dialog" aria-label={title}>
            <header className="drawer-head">
                <strong>{title}</strong>
                <button className="btn" onClick={onClose}>关闭</button>
            </header>
            <div className="drawer-body">{children}</div>
        </aside>
    </>
}
