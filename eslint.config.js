// 只跑两条规则，目的很窄：Vite 8 用的是 rolldown，未导入的裸标识符会被当成全局变量，
// 构建照样绿、运行时才 ReferenceError。
// 所以这里只要 no-undef 能把「缺 import」在提交前抓出来，不去做风格审判。
// 全局名手工列：不引 globals 包，少一个依赖也逼我们看清楚代码到底碰了哪些宿主 API。

const browserGlobals = {
    window: 'readonly',
    document: 'readonly',
    navigator: 'readonly',
    location: 'readonly',
    history: 'readonly',
    console: 'readonly',
    alert: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    requestAnimationFrame: 'readonly',
    cancelAnimationFrame: 'readonly',
    matchMedia: 'readonly',
    customElements: 'readonly',
    HTMLElement: 'readonly',
    Worker: 'readonly',
    indexedDB: 'readonly',
    caches: 'readonly',
    localStorage: 'readonly',
    fetch: 'readonly',
    addEventListener: 'readonly',
    removeEventListener: 'readonly',
    innerWidth: 'readonly',
    innerHeight: 'readonly',
    TextEncoder: 'readonly',
    NodeFilter: 'readonly',
    Blob: 'readonly',
    File: 'readonly',
    FileReader: 'readonly',
    Image: 'readonly',
    URL: 'readonly',
    crypto: 'readonly',
    performance: 'readonly',
    AbortController: 'readonly',
    structuredClone: 'readonly',
    Intl: 'readonly',
    DOMRect: 'readonly',
    Range: 'readonly',
    Node: 'readonly',
    Element: 'readonly',
    DocumentFragment: 'readonly',
    StorageManager: 'readonly',
}

const nodeGlobals = {
    process: 'readonly',
    console: 'readonly',
    URL: 'readonly',
    Blob: 'readonly',
}

export default [
    {
        ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', '.scratch/**', 'public/**', 'vibe_images/**'],
    },
    {
        files: ['src/**/*.{js,jsx}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            // 默认解析器 espree 能读 JSX，不必额外装 parser —— 但必须显式打开这个开关
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: browserGlobals,
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
        },
    },
    {
        files: ['src/**/*.worker.js'],
        languageOptions: {
            globals: { self: 'readonly', postMessage: 'readonly', importScripts: 'readonly' },
        },
    },
    {
        files: ['vite.config.js', 'build/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: nodeGlobals,
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
        },
    },
]
