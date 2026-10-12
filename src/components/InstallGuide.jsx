// 界面文案里的数字必须和实际对得上，所以大小一律走共用的 fmtBytes（小文件不会被显示成「0.0 MB」）。
import { fmtBytes } from '../lib/format.js'

// iOS 的 Safari 不给出任何可程序化的安装入口（没有 beforeinstallprompt，也不允许脚本调起
// 「添加到主屏幕」），所以引导只能自绘步骤，让用户手动完成。
// 之所以值得这样拦一道：标签页形态下的存储会在 7 天无交互后被 ITP 整体清除（WebKit #181849 定论），
// 且与主屏 App 是两套互不可见的存储 —— 在这里导入的书和书签，
// 装到主屏之后一本都看不到。

const STEPS = [
    '在 Safari 底部的工具栏点「分享」（方框加向上箭头那个）',
    '在分享面板里往下滑，点「添加到主屏幕」',
    '回到桌面，从新出现的「阅读器」图标打开',
    '以后都从这个图标进来：标签页里的书和书签，主屏 App 一本都读不到',
]

export function InstallGuide({ onUnderstood }) {
    return (
        <section className="guide">
            <h2>先把数据落在不会丢的地方</h2>
            <p className="note">
                现在是在 Safari 标签页里用。这种形态下导入的书和做的书签会在
                <strong>连续 7 天没有交互后被 iOS 清掉</strong>，而且清掉时不报错。
                装到主屏幕就没有这个限制，所以建议先装再导入。
            </p>
            <ol className="guide-steps">
                {STEPS.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            <button className="btn" onClick={onUnderstood}>我知道了，就在标签页里用</button>
        </section>
    )
}

export function InstallConfirm({ file, onProceed, onCancel }) {
    return (
        <div className="dialog-mask">
            <div className="dialog" role="dialog" aria-modal="true">
                <h2>这本书要导入到标签页里</h2>
                <p>
                    <strong>{file.name}</strong>（{fmtBytes(file.size)}）
                    会存进 Safari 标签页这一份存储：连续 7 天没有交互就会被 iOS 整体清除，
                    而且<strong>之后装成主屏 App 也读不到它</strong> —— 两边是两套存储。
                </p>
                <p className="note">建议先按「分享 → 添加到主屏幕」装好，从主屏图标进来再导入。</p>
                <div className="dialog-actions">
                    <button className="btn" onClick={onCancel}>先去添加</button>
                    <button className="btn" onClick={onProceed}>仍在标签页里导入</button>
                </div>
            </div>
        </div>
    )
}
